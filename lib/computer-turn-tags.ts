import type { TurnEvent } from '@/lib/agent37/turn-events';
import { JOB_TAG_NOTE, JOB_TAG_PREFIX } from '@/lib/computer-values';

/**
 * The job's tag is for the machine's model address, not for a person: every turn Orbit sends the agent starts with it (see `jobTagOf`), and an agent may
 * repeat it in its own words anyway. Whatever Orbit passes on from the agent has the tag taken out, the note after it too when it follows, so it can never
 * reach a person's screen, chat or report (Orbit keeps none of the agent's words itself).
 */
const TAG = new RegExp(`^${JOB_TAG_PREFIX.replace(/[[\]]/g, '\\$&')}[A-Za-z0-9-]{1,64}\\]`);
const ID_CHARS = /^[A-Za-z0-9-]{0,64}$/;

/** Whether the text could still become a tag when more words come: an unfinished start of one. */
const couldBecomeTag = (text: string): boolean => (text.length <= JOB_TAG_PREFIX.length ? JOB_TAG_PREFIX.startsWith(text) : text.startsWith(JOB_TAG_PREFIX) && ID_CHARS.test(text.slice(JOB_TAG_PREFIX.length)));

/** The words with every whole tag (and the note right after it) taken out, and the unfinished end that may still become one (held for the next words). */
export function withoutJobTags(text: string, final = false): { clean: string; held: string } {
  let clean = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf('[', at);
    if (open < 0) return { clean: clean + text.slice(at), held: '' };
    clean += text.slice(at, open);
    const rest = text.slice(open);
    const found = TAG.exec(rest);
    if (found) {
      const after = rest.slice(found[0].length);
      if (after.startsWith(JOB_TAG_NOTE)) {
        at = open + found[0].length + JOB_TAG_NOTE.length;
        continue;
      }
      // The note may be on its way: what is left may be its start
      if (!final && after.length < JOB_TAG_NOTE.length && JOB_TAG_NOTE.startsWith(after)) return { clean, held: rest };
      at = open + found[0].length;
      continue;
    }
    if (couldBecomeTag(rest)) return { clean, held: rest };
    clean += '[';
    at = open + 1;
  }
}

/** A whole text with the tags out: what is left unfinished at its end is no tag, so it stays. */
const all = (text: string): string => {
  const out = withoutJobTags(text, true);
  return out.clean + out.held;
};

/** Every word a stream passes on, without the tag. Words that may be the start of a tag wait for the next ones; whatever is held when something else comes (or the stream ends) was not one, and goes on as it was. */
export async function* withoutTags(events: AsyncGenerator<TurnEvent>): AsyncGenerator<TurnEvent> {
  let held = '';
  for await (const event of events) {
    if (event.type === 'text') {
      const out = withoutJobTags(held + event.text);
      held = out.held;
      if (out.clean) yield { type: 'text', text: out.clean };
      continue;
    }
    if (event.type === 'keepalive') {
      yield event;
      continue;
    }
    // Anything else ends what was waiting: it was no tag
    if (held) {
      const left = all(held);
      if (left) yield { type: 'text', text: left };
      held = '';
    }
    if (event.type === 'completed') yield { ...event, outputText: all(event.outputText) };
    else if (event.type === 'tool') yield { ...event, ...(event.label !== undefined ? { label: all(event.label) } : {}), ...(event.error !== undefined ? { error: all(event.error) } : {}) };
    else if (event.type === 'failed') yield { ...event, message: all(event.message) };
    else yield event;
  }
  if (held) {
    const left = all(held);
    if (left) yield { type: 'text', text: left };
  }
}
