import {
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '../common/prisma/prisma.service';
import { TenantService } from '../common/tenant/tenant.service';
import {
  AuthTokenService,
  SessionClaims,
} from '../auth/auth-token.service';
import { DisplayService } from '../display/display.service';
import { EtaService } from './eta.service';
import { QueueService } from './queue.service';
import { QueueEventsService } from './queue-events.service';
import { SessionKey } from './token.service';

interface JoinPayload {
  doctorId: string;
  sessionDate: string;
  sessionType: 'MORNING' | 'EVENING';
  token?: string; // patients only — their own token
}

const sessionRoom = (s: SessionKey): string =>
  `session:${s.doctorId}:${s.sessionDate}:${s.sessionType}`;
const bookingRoom = (bookingId: string): string => `booking:${bookingId}`;
const displayRoom = (clinicId: string): string => `display:${clinicId}`;

/**
 * Realtime queue transport.
 *
 *  - Doctor / receptionist / admin join a per-doctor-session room and receive
 *    the FULL queue state.
 *  - Patients join a private per-booking channel and receive ONLY their own
 *    derived position/ETA — never the full listing.
 *  - Waiting-room TV displays connect WITHOUT a token and may join exactly one
 *    room — `display:{clinicId}` — which carries only sanitized cards (token
 *    numbers and counts, never a patient). See handleConnection.
 *
 * Every other connection authenticates with a session token; room joins are
 * authorized against the token's role + scope. On every join (so: on connect AND
 * reconnect) an immediate snapshot is pushed before any future delta event.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class QueueGateway
  implements OnGatewayConnection, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(QueueGateway.name);
  private unsubscribe?: () => void;
  /** Per-session set of booking ids that were in the queue at the last broadcast. */
  private lastSessionBookings = new Map<string, Set<string>>();

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly auth: AuthTokenService,
    private readonly eta: EtaService,
    private readonly queue: QueueService,
    private readonly events: QueueEventsService,
    private readonly prisma: PrismaService,
    private readonly tenant: TenantService,
    private readonly display: DisplayService,
  ) {}

  onModuleInit(): void {
    // fan queue mutations out to the right rooms
    this.unsubscribe = this.events.onSessionChanged((session) => {
      void this.broadcast(session);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  handleConnection(client: Socket): void {
    // A waiting-room display announces itself in the handshake and gets no
    // claims at all. It is confined to its clinic's display room by
    // joinAsDisplay, and `claims` staying undefined is what bars it from every
    // authenticated path below.
    const clinicId = extractDisplayClinic(client);
    if (clinicId) {
      void this.joinAsDisplay(client, clinicId);
      return;
    }

    try {
      const token = extractToken(client);
      client.data.claims = this.auth.verify(token);
    } catch {
      client.emit('error', { message: 'unauthorized' });
      client.disconnect(true);
    }
  }

  @SubscribeMessage('join')
  async onJoin(client: Socket, payload: JoinPayload): Promise<void> {
    // Displays are unauthenticated, so they must never reach the session or
    // booking rooms — the only place they belong is the room handleConnection
    // already put them in.
    if (client.data.display) {
      client.emit('error', { message: 'forbidden' });
      return;
    }

    const claims = client.data.claims as SessionClaims | undefined;
    if (!claims) {
      client.disconnect(true);
      return;
    }
    if (!payload?.doctorId || !payload?.sessionDate || !payload?.sessionType) {
      client.emit('error', { message: 'doctorId, sessionDate, sessionType required' });
      return;
    }

    const session: SessionKey = {
      doctorId: payload.doctorId,
      sessionDate: payload.sessionDate,
      sessionType: payload.sessionType,
    };

    if (claims.role === 'PATIENT') {
      await this.joinAsPatient(client, claims, session, payload.token);
      return;
    }
    await this.joinAsStaff(client, claims, session);
  }

  // ── patient: private per-booking channel, own ETA only ───
  private async joinAsPatient(
    client: Socket,
    claims: SessionClaims,
    session: SessionKey,
    token?: string,
  ): Promise<void> {
    if (!token) {
      client.emit('error', { message: 'forbidden' });
      return;
    }
    // Resolve the token to its booking, then confirm that booking belongs to
    // THIS authenticated patient. A patient can only subscribe to channels for
    // bookings they own — never anyone else's.
    const bookingId = await this.queue.bookingIdFor(token, session);
    if (!bookingId) {
      client.emit('error', { message: 'forbidden' });
      return;
    }
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { patientId: true },
    });
    if (!booking || booking.patientId !== claims.sub) {
      client.emit('error', { message: 'forbidden' });
      return;
    }

    await client.join(bookingRoom(bookingId));
    const mine = await this.eta.etaFor(token, session);
    client.emit('snapshot', { kind: 'booking', booking: bookingId, eta: mine });
  }

  // ── waiting-room TV: clinic display room, sanitized cards ─
  /**
   * Put an unauthenticated display into `display:{clinicId}` and push the
   * opening board. The clinic is verified first so a mistyped URL closes the
   * socket instead of parking it in a room that will never receive anything.
   */
  private async joinAsDisplay(client: Socket, clinicId: string): Promise<void> {
    try {
      await this.display.assertClinic(clinicId);
    } catch {
      client.emit('error', { message: 'unknown clinic' });
      client.disconnect(true);
      return;
    }

    client.data.display = clinicId;
    await client.join(displayRoom(clinicId));
    const board = await this.display.board(clinicId);
    client.emit('display:snapshot', board);
  }

  // ── doctor / receptionist / admin: full session room ─────
  private async joinAsStaff(
    client: Socket,
    claims: SessionClaims,
    session: SessionKey,
  ): Promise<void> {
    const allowed = await this.staffMayJoin(claims, session);
    if (!allowed) {
      client.emit('error', { message: 'forbidden' });
      return;
    }
    await client.join(sessionRoom(session));
    const queue = await this.eta.etaForQueue(session);
    client.emit('snapshot', { kind: 'session', session, queue });
  }

  private async staffMayJoin(
    claims: SessionClaims,
    session: SessionKey,
  ): Promise<boolean> {
    if (claims.role === 'DOCTOR') {
      return claims.doctorId === session.doctorId;
    }
    if (claims.role === 'ADMIN') {
      // ADMIN may watch any doctor's queue in their OWN hospital — never another
      // hospital's. The doctor->clinic->hospital check is the tenant boundary.
      if (!claims.hospitalId) return false;
      return this.tenant.doctorInHospital(claims.hospitalId, session.doctorId);
    }
    if (claims.role === 'STAFF') {
      // only sessions for doctors in the staff member's clinic
      if (!claims.clinicId) return false;
      const doctor = await this.prisma.doctor.findUnique({
        where: { id: session.doctorId },
        select: { clinicId: true },
      });
      return !!doctor && doctor.clinicId === claims.clinicId;
    }
    return false;
  }

  // ── fan-out on state change ──────────────────────────────
  private async broadcast(session: SessionKey): Promise<void> {
    // No socket server in a context-only process (CLI scripts, workers): those
    // still drive the queue through ConsultationService, which emits here. There
    // is nobody to broadcast to, and this runs fire-and-forget, so an
    // unguarded call surfaces as an unhandled rejection that kills the process.
    if (!this.server) return;

    const queue = await this.eta.etaForQueue(session);

    // full state to the session room (staff)
    this.server.to(sessionRoom(session)).emit('queue:update', { session, queue });

    // each patient gets ONLY their own slice on their private channel
    const current = new Set<string>();
    for (const entry of queue) {
      const bookingId = await this.queue.bookingIdFor(entry.tokenNumber, session);
      if (bookingId) {
        current.add(bookingId);
        this.server
          .to(bookingRoom(bookingId))
          .emit('eta:update', { booking: bookingId, eta: entry });
      }
    }

    // Bookings that LEFT the queue since the last broadcast (DONE / no-show /
    // cancelled) get a final eta:update with eta=null, so the patient's OWN
    // terminal transition is pushed live — the loop above only covers tokens
    // still queued, which would otherwise strand the just-completed patient.
    const tag = sessionRoom(session);
    const previous = this.lastSessionBookings.get(tag);
    if (previous) {
      for (const bookingId of previous) {
        if (!current.has(bookingId)) {
          this.server
            .to(bookingRoom(bookingId))
            .emit('eta:update', { booking: bookingId, eta: null });
        }
      }
    }
    this.lastSessionBookings.set(tag, current);

    // Waiting-room screens go last: a wall display is the least latency-critical
    // consumer, and the staff and patient fan-outs above must not queue behind
    // the projection this builds.
    await this.broadcastDisplay(session);
  }

  /**
   * Push the changed doctor's card to their clinic's displays. Failures are
   * logged and swallowed: a wall screen missing one update is cosmetic (the
   * page re-fetches on a slow poll), and it must never break the staff and
   * patient fan-out that ran before it.
   */
  private async broadcastDisplay(session: SessionKey): Promise<void> {
    try {
      const clinicId = await this.display.clinicIdForDoctor(session.doctorId);
      if (!clinicId) return;

      // Most clinics have no TV on, and every queue mutation reaches here. Bail
      // before building the card so the common case costs a map lookup rather
      // than the queue read and database query the projection needs.
      const room = this.server.sockets.adapter.rooms.get(displayRoom(clinicId));
      if (!room || room.size === 0) return;

      const card = await this.display.cardForSession(session);
      if (!card) return;
      this.server
        .to(displayRoom(clinicId))
        .emit('display:update', { clinicId, doctor: card });
    } catch (err) {
      this.logger.warn(
        `display broadcast failed for ${session.doctorId}: ${String(err)}`,
      );
    }
  }
}

/**
 * Clinic id for a socket that identifies itself as a waiting-room display.
 * Requires an explicit `display: true` alongside the id so an authenticated
 * client cannot fall into the unauthenticated path by passing a stray param.
 */
function extractDisplayClinic(client: Socket): string | null {
  const auth = client.handshake.auth as
    | { display?: unknown; clinicId?: unknown }
    | undefined;
  if (auth?.display === true && typeof auth.clinicId === 'string') {
    return auth.clinicId;
  }
  const q = client.handshake.query ?? {};
  if (q.display === 'true' && typeof q.clinicId === 'string') {
    return q.clinicId;
  }
  return null;
}

function extractToken(client: Socket): string {
  const auth = client.handshake.auth as { token?: string } | undefined;
  if (auth?.token) return auth.token;
  const header = client.handshake.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const q = client.handshake.query?.token;
  if (typeof q === 'string') return q;
  throw new Error('no token');
}
