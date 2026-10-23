import { probeChat, type ModelFactsById, type ProbeFailure } from '@/lib/ai-key-models';

/** How many of a key's listed models are asked for one tiny reply before giving up on finding one that answers. */
export const ANSWER_TRIES = 4;

type ChatResult = Awaited<ReturnType<typeof probeChat>>;
export type Answering = { ok: true; model: string } | { ok: false; message: string; reason: ProbeFailure };

/**
 * The first of a key's listed models that answers one tiny reply, the provider's suggested model first (#575). A list can
 * hold a model that doesn't chat (an embedding model whose name says nothing), so a model is only picked once it answers.
 * One that refused only this tiny request (a 400, as a reasoning model that wants a bigger cap does) is picked only when
 * none of the others really replies, since a model that doesn't chat can answer the same way, and never on a key that is
 * out of credit for another model (that model's refusal proves nothing then). A refused key, a busy provider or no answer
 * at all would say the same for every model, so the search stops there; a 403 or a server error can be one model's, so it goes on.
 *
 * Models the provider says call tools are asked ahead of the rest, the same as Add key: those are chat models, so a list
 * that starts with embedding or image models still finds one that replies. `asked` keeps the answers for one caller, so the
 * same model is never asked twice.
 */
export async function firstAnswering(
  target: { kind: string; address?: string; apiKey?: string },
  models: string[],
  suggested: string | undefined,
  asked: Map<string, Promise<ChatResult>> = new Map(),
  facts: ModelFactsById = {},
): Promise<Answering> {
  const first = suggested && models.includes(suggested) ? [suggested] : [];
  const rest = models.filter((id) => !first.includes(id));
  const ordered = [...first, ...rest.filter((id) => facts[id]?.tools === true), ...rest.filter((id) => facts[id]?.tools !== true)];
  let refusedRequest: string | null = null;
  let last: { message: string; reason: ProbeFailure } | null = null;
  let credit: { message: string; reason: ProbeFailure } | null = null;
  let perModel: { message: string; reason: ProbeFailure } | null = null;
  for (const model of ordered.slice(0, ANSWER_TRIES)) {
    let answer = asked.get(model);
    if (!answer) {
      answer = probeChat({ ...target, model });
      asked.set(model, answer);
    }
    const chat = await answer;
    if (chat.ok) return { ok: true, model };
    if (chat.reason === 'request') {
      refusedRequest ??= model;
      continue;
    }
    // A model that went says less than any other failure: "gone" is only the answer when every model asked said so
    if (!last || last.reason === 'gone' || chat.reason !== 'gone') last = chat;
    // A free model can still answer on a key out of credit, so the search goes on
    if (chat.reason === 'credit') credit ??= chat;
    // A 403 or a server error with a status is given per model (an organization not verified for it, one model's host
    // down), the same as Add key reads them: the next model is asked, and the key is judged on that refusal only if none answers
    if ((chat.reason === 'rejected' && chat.status === 403) || (chat.reason === 'unreachable' && chat.status !== undefined)) {
      perModel ??= chat;
      continue;
    }
    // The key or the provider failed, not this model: one that only refused the tiny request earlier proves nothing now
    if (chat.reason !== 'gone' && chat.reason !== 'other' && chat.reason !== 'credit') return { ok: false, message: chat.message, reason: chat.reason };
  }
  if (refusedRequest && !credit) return { ok: true, model: refusedRequest };
  const why = credit ?? perModel ?? last ?? { message: 'No model answered.', reason: 'other' as const };
  return { ok: false, message: why.message, reason: why.reason };
}
