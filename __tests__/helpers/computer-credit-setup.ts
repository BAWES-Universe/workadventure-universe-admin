/**
 * Computer jobs are held to the credit lots (lib/computer-credit.ts): the computer allowance a test gives is the computers default of the
 * credit books, with a rollout budget big enough for every test person. Shared by the tests that run real jobs against a real database.
 */
import { prisma } from '@/lib/db';
import { saveMeterSettings } from '@/lib/meter';
import { saveComputerAllowance } from '@/lib/grants-admin';

export const root = { userId: 'admin', superAdmin: true };

/** The meter's counts and money, all set, and the computers default `memberAllowanceMicros` (null for none); a test changes the ones it is about. */
export async function setUpComputerCredit(over: Record<string, number | null> = {}, now: Date = new Date()): Promise<void> {
  const { memberAllowanceMicros, ...rest } = { memberAllowanceMicros: 1_000_000 as number | null, ...over };
  await saveMeterSettings({ poolCeilingMicros: 100_000_000, reserveMicros: 0, storageMicrosPerGbMonth: 0, atOnceMember: 100, atOnceAll: 100, renewMinutes: 10, rolloutBudgetMicros: 1_000_000_000_000, ...rest }, 'admin');
  await saveComputerAllowance(memberAllowanceMicros, root, now);
}

/** Everything the credit books and the meter hold, so the next test starts clean. */
export async function wipeComputerCredit(): Promise<void> {
  await prisma.meterEvent.deleteMany({});
  await prisma.meterReservation.deleteMany({});
  await prisma.meterGrant.deleteMany({});
  await prisma.creditRefund.deleteMany({});
  await prisma.creditRefundRequest.deleteMany({});
  await prisma.creditHold.deleteMany({});
  await prisma.creditClosedKey.deleteMany({});
  await prisma.creditLot.deleteMany({});
  await prisma.grantRecipient.deleteMany({});
  await prisma.grantRule.deleteMany({});
  await prisma.grantProgram.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: ['meter', 'bot-limits', 'computer-wind-down', 'computer-credit-books'] } } });
}
