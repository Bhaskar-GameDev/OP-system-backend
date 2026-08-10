import { Prisma, QueuePolicyMode, TokenResetPolicy } from '@prisma/client';

/**
 * The OP config a clinic cannot function without.
 *
 * A clinic with no `TokenSeries` looks fine on every screen until someone tries
 * to take a token: the OP engine cannot mint one, so voice booking 409s ("could
 * not raise a token") and any OP check-in fails. That trap only surfaces at the
 * first real patient, so every path that creates a clinic must write this — the
 * admin API, the onboarding CLI and the demo seed all did it separately, which is
 * exactly how one of them ends up forgetting.
 *
 * Takes a transaction client so the clinic row and its config commit together: a
 * clinic that exists without its series is the half-configured state this
 * prevents.
 */
export async function provisionClinicOpConfig(
  tx: Prisma.TransactionClient,
  clinicId: string,
): Promise<void> {
  await tx.tokenSeries.createMany({
    data: [
      {
        clinicId,
        code: 'NORMAL_OP',
        label: 'Normal OP',
        prefix: 'N',
        padWidth: 3,
        startAt: 1,
        resetPolicy: TokenResetPolicy.PER_SESSION,
      },
      {
        clinicId,
        code: 'SPECIAL_OP',
        label: 'Special OP',
        prefix: 'S',
        padWidth: 3,
        startAt: 101,
        resetPolicy: TokenResetPolicy.PER_SESSION,
      },
    ],
  });
  await tx.queuePolicy.create({
    data: {
      clinicId,
      doctorId: null,
      mode: QueuePolicyMode.SHARED_FIFO,
      ratio: { SPECIAL_OP: 2, NORMAL_OP: 1 },
    },
  });
}
