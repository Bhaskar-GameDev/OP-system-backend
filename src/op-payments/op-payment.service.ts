import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OpPayment,
  OpPaymentMode,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventStoreService } from '../event-store/event-store.service';
import { DomainEventType } from '../event-store/domain-event.types';
import {
  RAZORPAY_GATEWAY,
  RazorpayGateway,
} from '../payments/razorpay.gateway';

export interface OnlineOrder {
  opPaymentId: string;
  orderId: string;
  amount: number;
}

const DESK_MODES: OpPaymentMode[] = [
  OpPaymentMode.CASH,
  OpPaymentMode.UPI_DESK,
  OpPaymentMode.CORPORATE_BILL,
  OpPaymentMode.WAIVED,
];

/**
 * Decoupled OP payment (ARCHITECTURE.md §3.2, §5.1). Payment is INDEPENDENT of
 * token issuance and queue position:
 *   - ONLINE: patient pays via the app BEFORE arriving (Razorpay order + confirm),
 *   - AT-DESK: reception takes cash / UPI / corporate / waiver AFTER the token.
 *
 * NOTHING here reads or writes Encounter status, tokens, or the queue. A token is
 * issued purely on check-in (TokenSeriesService), so payment can never gate it —
 * that decoupling is structural, not a convention. Settling emits PaymentSettled
 * on the payment's OWN event stream, so it never contends with encounter commands.
 */
@Injectable()
export class OpPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStoreService,
    @Inject(RAZORPAY_GATEWAY) private readonly razorpay: RazorpayGateway,
  ) {}

  /** Create an OpPayment + a Razorpay order for the app to pay online. Never
   *  issues a token or touches the encounter. */
  async createOnlineOrder(
    encounterId: string,
    opts: { amount?: number } = {},
  ): Promise<OnlineOrder> {
    const enc = await this.mustEncounter(encounterId);
    const amount = await this.resolveAmount(enc.opCategoryId, opts.amount);
    if (amount <= 0) {
      throw new BadRequestException('online amount must be > 0');
    }

    const payment = await this.prisma.opPayment.create({
      data: {
        encounterId,
        amount,
        mode: OpPaymentMode.ONLINE,
        status: PaymentStatus.CREATED,
      },
    });
    const order = await this.razorpay.createOrder(amount, `op_${payment.id}`);
    await this.prisma.opPayment.update({
      where: { id: payment.id },
      data: { gatewayRefs: { orderId: order.orderId } },
    });
    return { opPaymentId: payment.id, orderId: order.orderId, amount };
  }

  /**
   * Confirm an online payment (checkout return / webhook). Verifies the gateway
   * signature, confirms capture, flips SUCCESS, and emits PaymentSettled.
   * Idempotent: a second confirm on an already-SUCCESS payment is a no-op.
   */
  async confirmOnline(input: {
    opPaymentId: string;
    razorpayPaymentId: string;
    signature: string;
  }): Promise<OpPayment> {
    const payment = await this.mustPayment(input.opPaymentId);
    if (payment.mode !== OpPaymentMode.ONLINE) {
      throw new BadRequestException('not an online payment');
    }
    if (payment.status === PaymentStatus.SUCCESS) return payment; // idempotent

    const orderId = (payment.gatewayRefs as { orderId?: string } | null)?.orderId;
    if (!orderId) throw new BadRequestException('payment has no gateway order');

    if (
      !this.razorpay.verifyCheckoutSignature(
        orderId,
        input.razorpayPaymentId,
        input.signature,
      )
    ) {
      throw new BadRequestException('invalid payment signature');
    }
    const rp = await this.razorpay.fetchPayment(input.razorpayPaymentId);
    if (rp.orderId !== orderId) {
      throw new BadRequestException('payment does not match order');
    }
    if (rp.status !== 'captured') {
      throw new ConflictException(`payment not captured (status: ${rp.status})`);
    }

    return this.settle(payment, {
      razorpayPaymentId: input.razorpayPaymentId,
      orderId,
    });
  }

  /**
   * Reception settles at the desk AFTER the token is issued: cash / UPI / corporate
   * bill / waiver. Never gates the token (which may already be in the queue).
   */
  async settleAtDesk(
    encounterId: string,
    mode: OpPaymentMode,
    opts: { amount?: number; actorId?: string } = {},
  ): Promise<OpPayment> {
    if (!DESK_MODES.includes(mode)) {
      throw new BadRequestException('mode must be a desk mode (not ONLINE)');
    }
    const enc = await this.mustEncounter(encounterId);
    const amount =
      mode === OpPaymentMode.WAIVED
        ? 0
        : await this.resolveAmount(enc.opCategoryId, opts.amount);

    const payment = await this.prisma.opPayment.create({
      data: {
        encounterId,
        amount,
        mode,
        status: PaymentStatus.SUCCESS, // settled on the spot
      },
    });
    await this.emitSettled(payment, enc.clinicId, opts.actorId);
    return payment;
  }

  /** Every payment recorded against an encounter (audit / reconciliation). */
  forEncounter(encounterId: string): Promise<OpPayment[]> {
    return this.prisma.opPayment.findMany({
      where: { encounterId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── helpers ────────────────────────────────────────────

  private async settle(
    payment: OpPayment,
    refs: Record<string, string>,
  ): Promise<OpPayment> {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: payment.encounterId },
      select: { clinicId: true },
    });
    const merged = {
      ...((payment.gatewayRefs as Record<string, unknown> | null) ?? {}),
      ...refs,
    };
    const updated = await this.prisma.opPayment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.SUCCESS,
        gatewayRefs: merged as Prisma.InputJsonValue,
      },
    });
    await this.emitSettled(updated, enc?.clinicId, undefined);
    return updated;
  }

  private async emitSettled(
    payment: OpPayment,
    clinicId?: string,
    actorId?: string,
  ): Promise<void> {
    // Payment's OWN stream — decoupled, so it never contends with the encounter's
    // command stream (optimistic concurrency stays local to payments).
    const version = await this.events.currentVersion('OpPayment', payment.id);
    await this.events.append(
      {
        streamType: 'OpPayment',
        streamId: payment.id,
        type: DomainEventType.PaymentSettled,
        payload: {
          encounterId: payment.encounterId,
          amount: payment.amount,
          mode: payment.mode,
        },
        metadata: { actorId, clinicId },
      },
      version,
    );
  }

  /** Amount from explicit override, else the encounter's TokenSeries fee. */
  private async resolveAmount(
    opCategoryId: string,
    override?: number,
  ): Promise<number> {
    if (override !== undefined) {
      if (!Number.isInteger(override) || override < 0) {
        throw new BadRequestException('amount must be a non-negative integer');
      }
      return override;
    }
    const series = await this.prisma.tokenSeries.findUnique({
      where: { id: opCategoryId },
      select: { fee: true },
    });
    return series?.fee ?? 0;
  }

  private async mustEncounter(encounterId: string) {
    const enc = await this.prisma.encounter.findUnique({
      where: { id: encounterId },
      select: { id: true, clinicId: true, opCategoryId: true },
    });
    if (!enc) throw new NotFoundException('encounter not found');
    return enc;
  }

  private async mustPayment(opPaymentId: string): Promise<OpPayment> {
    const p = await this.prisma.opPayment.findUnique({
      where: { id: opPaymentId },
    });
    if (!p) throw new NotFoundException('payment not found');
    return p;
  }
}
