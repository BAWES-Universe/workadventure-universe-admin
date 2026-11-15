import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { changeRule, endRule } from '@/lib/spend-rules';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'PATCH, DELETE, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

const changeSchema = z
  .object({
    // Millionths of a dollar; null takes the cap off
    capMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    period: z.enum(['task', 'day', 'month']).nullable().optional(),
    onlyOwnAccounts: z.boolean().optional(),
    covers: z.enum(['apps', 'computer', 'all']).optional(),
  })
  .strict();

/**
 * PATCH /api/me/spend-rules/:ruleId - the person a rule protects corrects it: its amount, how long it counts, what it covers, or "only
 * my own accounts". Answers { rule }. What was already taken is never undone. Someone else's rule is 404.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const parsed = changeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return respond(request, { error: 'Invalid input data' }, 400);
  try {
    const { ruleId } = await params;
    const changed = await changeRule(ruleId, user.id, parsed.data);
    if (!changed.ok) return respond(request, { error: changed.reason === 'invalid' ? (changed.error ?? 'Invalid input data') : 'Rule not found' }, changed.reason === 'invalid' ? 400 : 404);
    return respond(request, { rule: changed.rule });
  } catch (error) {
    console.error('[Rules] Change failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}

/** DELETE /api/me/spend-rules/:ruleId - ends a rule. Asked twice it is the same. Someone else's rule is 404. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ ruleId: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    const { ruleId } = await params;
    const ended = await endRule(ruleId, user.id);
    return ended.ok ? respond(request, {}, 204) : respond(request, { error: 'Rule not found' }, 404);
  } catch (error) {
    console.error('[Rules] End failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
