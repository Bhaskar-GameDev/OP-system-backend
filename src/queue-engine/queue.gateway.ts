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
import {
  AuthTokenService,
  SessionClaims,
} from '../auth/auth-token.service';
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

/**
 * Realtime queue transport.
 *
 *  - Doctor / receptionist / admin join a per-doctor-session room and receive
 *    the FULL queue state.
 *  - Patients join a private per-booking channel and receive ONLY their own
 *    derived position/ETA — never the full listing.
 *
 * All connections authenticate with a session token; room joins are authorized
 * against the token's role + scope. On every join (so: on connect AND reconnect)
 * an immediate snapshot is pushed before any future delta event.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class QueueGateway
  implements OnGatewayConnection, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(QueueGateway.name);
  private unsubscribe?: () => void;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly auth: AuthTokenService,
    private readonly eta: EtaService,
    private readonly queue: QueueService,
    private readonly events: QueueEventsService,
    private readonly prisma: PrismaService,
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
    if (claims.role === 'STAFF' || claims.role === 'ADMIN') {
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
    const queue = await this.eta.etaForQueue(session);

    // full state to the session room (staff)
    this.server.to(sessionRoom(session)).emit('queue:update', { session, queue });

    // each patient gets ONLY their own slice on their private channel
    for (const entry of queue) {
      const bookingId = await this.queue.bookingIdFor(entry.tokenNumber, session);
      if (bookingId) {
        this.server
          .to(bookingRoom(bookingId))
          .emit('eta:update', { booking: bookingId, eta: entry });
      }
    }
  }
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
