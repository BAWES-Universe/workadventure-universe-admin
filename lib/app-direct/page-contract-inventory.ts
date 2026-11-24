import { prisma } from '@/lib/db';
import { artifactFiles, type ArtifactFiles } from '@/lib/artifact-storage';

/**
 * Which pages that take payments still speak the old page protocol (a `use-app` message without a request id and the document's session): the
 * host never answers those and never starts a checkout for them, and tells the buyer the pay button needs an update. This reads each page's
 * latest version as plain text, so it can only say what the page's source says (a page that builds the message from pieces may read as
 * "legacy" while working, never the other way round for a page that does not mention `request` and `session` at all). It reads only: nothing
 * is changed, and no name, address or account is printed, only ids.
 */
export type PageContract = 'current' | 'legacy' | 'no_call' | 'unreadable';

/** What a page's source says about the protocol. `current`: it sends `use-app` and mentions a request id and a session; `legacy`: it sends `use-app` without both; `no_call`: no pay button of this kind. */
export function classifyPageContract(source: string): Exclude<PageContract, 'unreadable'> {
  if (!/use-app/.test(source)) return 'no_call';
  return /\brequest\b/.test(source) && /\bsession\b/.test(source) ? 'current' : 'legacy';
}

export interface PageContractRow {
  jobId: string;
  artifactId: string;
  jobActive: boolean;
  openScope: string;
  contract: PageContract;
  /** Orders already made on the page: a legacy page with paid or open orders is the one to upgrade first. */
  orders: { paid: number; open: number };
}

export interface PageContractInventory {
  /** Pages with a payment job, by what their source says. */
  counts: Record<PageContract, number>;
  /** Of the legacy ones: how many are active, and how many have a paid or open order already. */
  legacy: { active: number; withOrders: number };
  rows: PageContractRow[];
  nextCursor: string | null;
}

/** The pages with a payment job (every status), oldest first, `take` at a time. A cursor is the last job id of the page before. */
export async function inventoryPaymentPages(input: { take?: number; cursor?: string | null } = {}, files: Pick<ArtifactFiles, 'get'> = artifactFiles): Promise<PageContractInventory> {
  const take = Math.min(500, Math.max(1, input.take ?? 200));
  const jobs = await prisma.appPageJob.findMany({
    orderBy: { id: 'asc' },
    take: take + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: { id: true, artifactId: true, status: true, artifact: { select: { openScope: true, latestVersion: true, versions: { orderBy: { number: 'desc' }, take: 1, select: { fileKey: true } } } } },
  });
  const page = jobs.slice(0, take);
  const rows: PageContractRow[] = [];
  for (const row of page) {
    const fileKey = row.artifact.versions[0]?.fileKey;
    let contract: PageContract = 'unreadable';
    if (fileKey) {
      try {
        contract = classifyPageContract(await files.get(fileKey));
      } catch {
        contract = 'unreadable';
      }
    }
    const [paid, open] = await Promise.all([prisma.appPageOrder.count({ where: { artifactId: row.artifactId, status: 'paid' } }), prisma.appPageOrder.count({ where: { artifactId: row.artifactId, status: { in: ['creating', 'pending'] } } })]);
    rows.push({ jobId: row.id, artifactId: row.artifactId, jobActive: row.status === 'active', openScope: row.artifact.openScope, contract, orders: { paid, open } });
  }
  const counts: Record<PageContract, number> = { current: 0, legacy: 0, no_call: 0, unreadable: 0 };
  for (const row of rows) counts[row.contract] += 1;
  const legacy = rows.filter((row) => row.contract === 'legacy');
  return { counts, legacy: { active: legacy.filter((row) => row.jobActive).length, withOrders: legacy.filter((row) => row.orders.paid + row.orders.open > 0).length }, rows, nextCursor: jobs.length > take ? page[page.length - 1].id : null };
}
