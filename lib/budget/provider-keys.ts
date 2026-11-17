import { prisma } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';

/**
 * The one key the Budget page keeps for a company, apart from the keys Universe already holds: Soniox's organization key (starts snx_org_), made by
 * an organization admin in the Soniox console. The usual Soniox project key cannot read the balance. It is saved encrypted like the other keys, is
 * read only by this page's reader, and is never sent back to any browser: the page only learns whether one is saved.
 */
const SONIOX_KEY = 'budget-soniox-org-key';

export const SONIOX_ORG_PREFIX = 'snx_org_';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function sonioxOrgKey(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: SONIOX_KEY } });
  const encrypted = isRecord(row?.value) && typeof row.value.encrypted === 'string' ? row.value.encrypted : null;
  if (!encrypted) return null;
  try {
    return decryptApiKey(encrypted);
  } catch {
    return null;
  }
}

export async function saveSonioxOrgKey(key: string, userId: string): Promise<void> {
  const value = { encrypted: encryptApiKey(key) };
  await prisma.appSetting.upsert({ where: { key: SONIOX_KEY }, create: { key: SONIOX_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
}

export async function clearSonioxOrgKey(): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: SONIOX_KEY } });
}
