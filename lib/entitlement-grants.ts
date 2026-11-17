import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { GRANT_SETTLEMENTS, type GrantSettlement } from '@/lib/meter-values';
import { GrantKeyUsed, GrantRefused, pickRunning } from '@/lib/meter-grants';

/**
 * "Give more" for one entitlement (billing consensus v2, P5). A person has a speech entitlement (the seconds of speech Universe pays for
 * that one person may use in a month, `speechMemberCeilingSeconds`) and an Apps entitlement (the money one person's Bricks may use of
 * connected Apps in a month, `appUseMemberCeilingMicros`). An authorised admin may extend the ONE entitlement shown, for a while:
 *
 *  - a multiple of it (2 times adds the entitlement once more, never a multiple of a multiple: only the largest one running counts), or
 *  - no limit on that person's own entitlement while it lasts.
 *
 * It never overrides what is not that person's: the platform's Speech or Apps budget, another payer's rules, or a provider's limit. Those
 * stay checked, and a refusal says which one stopped it. Recorded once under its key (a double tap gives it once). Kept apart from the extra
 * usage of chat, voice replies and computer time (lib/meter-grants.ts) so neither can lift the other.
 */
export const ENTITLEMENT_SCOPES = ['speech', 'apps'] as const;
export type EntitlementScope = (typeof ENTITLEMENT_SCOPES)[number];
export const isEntitlementScope = (value: unknown): value is EntitlementScope => typeof value === 'string' && (ENTITLEMENT_SCOPES as readonly string[]).includes(value);

export interface EntitlementGrantInput {
  grantKey: string;
  personId: string;
  scope: EntitlementScope;
  settlement: GrantSettlement;
  multiplier?: number | null;
  noLimit?: boolean;
  startsAt: Date;
  endsAt: Date;
  givenById: string;
  note?: string | null;
}

export interface EntitlementGrant {
  id: string;
  grantKey: string;
  personId: string;
  scope: EntitlementScope;
  settlement: GrantSettlement;
  multiplier: number | null;
  noLimit: boolean;
  startsAt: Date;
  endsAt: Date;
  givenById: string;
  note: string | null;
  billedAt: Date | null;
}

type Row = { id: string; grantKey: string; personId: string; scope: string; settlement: string; multiplier: number | null; noLimit: boolean; startsAt: Date; endsAt: Date; givenById: string; note: string | null; billedAt: Date | null };

const view = (row: Row): EntitlementGrant => ({ ...row, scope: row.scope as EntitlementScope, settlement: row.settlement as GrantSettlement });

/** What a grant of a scope extends, and what it never does, for the sheet that previews it. */
export const SCOPE_WORDS: Record<EntitlementScope, { extends: string; entitlement: string; never: string[] }> = {
  speech: {
    entitlement: 'speechMemberCeilingSeconds',
    extends: 'This person’s own monthly speech allowance',
    never: ['the platform’s Speech budget', 'another payer’s rules', 'a voice company’s own limits'],
  },
  apps: {
    entitlement: 'appUseMemberCeilingMicros',
    extends: 'This person’s own monthly allowance for connected Apps',
    never: ['the platform’s Apps budget', 'another payer’s rules', 'an App provider’s own limits'],
  },
};

type Db = Pick<Prisma.TransactionClient, 'user' | 'meterEntitlementGrant'>;

/** Records a grant once; returns it and whether this call wrote it. The same key with other figures is refused: the first one stands. */
export async function recordEntitlementGrant(input: EntitlementGrantInput, db: Db = prisma): Promise<{ grant: EntitlementGrant; recorded: boolean }> {
  if (!input.grantKey || input.grantKey.length > 255) throw new GrantRefused('grantKey is required (up to 255 characters)');
  if (!isEntitlementScope(input.scope)) throw new GrantRefused('scope must be speech or apps');
  if (!(GRANT_SETTLEMENTS as readonly string[]).includes(input.settlement)) throw new GrantRefused('settlement must be gift or to_bill');
  const noLimit = input.noLimit === true;
  const multiplier = noLimit ? null : (input.multiplier ?? null);
  if (noLimit && input.multiplier) throw new GrantRefused('A grant is a multiple or no limit, not both');
  if (!noLimit && (multiplier === null || !Number.isInteger(multiplier) || multiplier < 2)) throw new GrantRefused('multiplier must be a whole number, 2 or more (or no limit)');
  if (!(input.endsAt > input.startsAt)) throw new GrantRefused('Extra usage must end after it starts');
  if (input.note && input.note.length > 1000) throw new GrantRefused('note is too long (up to 1000 characters)');
  const person = await db.user.findUnique({ where: { id: input.personId }, select: { id: true } });
  if (!person) throw new GrantRefused('That person does not exist');
  const { count } = await db.meterEntitlementGrant.createMany({
    data: [
      {
        grantKey: input.grantKey,
        personId: input.personId,
        scope: input.scope,
        settlement: input.settlement,
        multiplier,
        noLimit,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        givenById: input.givenById,
        note: input.note?.trim() ? input.note.trim() : null,
      },
    ],
    skipDuplicates: true,
  });
  const row = await db.meterEntitlementGrant.findUniqueOrThrow({ where: { grantKey: input.grantKey } });
  if (count === 0 && !(row.personId === input.personId && row.scope === input.scope && row.settlement === input.settlement && row.multiplier === multiplier && row.noLimit === noLimit)) {
    throw new GrantKeyUsed('That key was used for a different grant. The first one stands.');
  }
  return { grant: view(row), recorded: count > 0 };
}

export interface RunningEntitlement {
  grantKey: string;
  /** Null for no limit. */
  multiplier: number | null;
  noLimit: boolean;
  endsAt: Date;
}

/** The extra running for a person's entitlement now: the largest one (no limit beats any multiple), the same pick as the other extra usage. */
export async function runningEntitlement(personId: string, scope: EntitlementScope, now: Date = new Date(), db: Pick<typeof prisma, 'meterEntitlementGrant'> = prisma): Promise<RunningEntitlement | null> {
  const rows = await db.meterEntitlementGrant.findMany({ where: { personId, scope, startsAt: { lte: now }, endsAt: { gt: now } }, select: { grantKey: true, multiplier: true, noLimit: true, endsAt: true } });
  const best = pickRunning(rows);
  return best ? { grantKey: best.grantKey, multiplier: best.noLimit ? null : best.multiplier, noLimit: best.noLimit, endsAt: best.endsAt } : null;
}

/** An entitlement with the extra running for it: `null` ceiling means no limit on that person's own entitlement. */
export function extendedCeiling(base: number, extra: RunningEntitlement | null): number | null {
  if (extra?.noLimit) return null;
  return base * (extra?.multiplier ?? 1);
}

/** The grants of one person, newest first, for the sheet and the person's page. */
export async function entitlementGrantsOf(personId: string, scope?: EntitlementScope, db: Pick<typeof prisma, 'meterEntitlementGrant'> = prisma): Promise<EntitlementGrant[]> {
  const rows = await db.meterEntitlementGrant.findMany({ where: { personId, ...(scope ? { scope } : {}) }, orderBy: { createdAt: 'desc' }, take: 50 });
  return rows.map(view);
}

/** "End it now": a running grant stops this moment; what it already covered stays covered. */
export async function endEntitlementGrantNow(grantKey: string, now: Date = new Date()): Promise<'ended' | 'already_ended' | 'not_found'> {
  const row = await prisma.meterEntitlementGrant.findUnique({ where: { grantKey }, select: { startsAt: true, endsAt: true } });
  if (!row) return 'not_found';
  if (row.endsAt <= now) return 'already_ended';
  const { count } = await prisma.meterEntitlementGrant.updateMany({ where: { grantKey, endsAt: { gt: now } }, data: { endsAt: now > row.startsAt ? now : row.startsAt } });
  return count > 0 ? 'ended' : 'already_ended';
}
