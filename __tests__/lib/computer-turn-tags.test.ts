import { withoutJobTags, withoutTags } from '@/lib/computer-turn-tags';
import { jobTagOf } from '@/lib/computer-values';
import type { TurnEvent } from '@/lib/agent37/turn-events';

const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const run = async (events: TurnEvent[]) => {
  const out: TurnEvent[] = [];
  async function* source() {
    for (const event of events) yield event;
  }
  for await (const event of withoutTags(source())) out.push(event);
  return out;
};
const textOf = (events: TurnEvent[]) => events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('');

describe('the job tag never goes on to a person', () => {
  it('takes a whole tag out, with the note after it, and only a real tag', () => {
    expect(withoutJobTags(`${jobTagOf(ID)}\nHello`)).toEqual({ clean: '\nHello', held: '' });
    expect(withoutJobTags(`I am working on [universe-job:${ID}] now`)).toEqual({ clean: 'I am working on  now', held: '' });
    // brackets that are not a tag stay
    expect(withoutJobTags('see [1] and [universe-jobs] and [universe-job:] and [universe-job:not valid]')).toEqual({ clean: 'see [1] and [universe-jobs] and [universe-job:] and [universe-job:not valid]', held: '' });
  });

  it('finds a tag the agent’s words split anywhere, in the streamed text and nowhere else', async () => {
    const said = `Done. ${jobTagOf(ID)} Anything else? [1]`;
    for (let cut = 1; cut < said.length; cut++) {
      const out = await run([{ type: 'text', text: said.slice(0, cut) }, { type: 'text', text: said.slice(cut) }, { type: 'completed', outputText: said, usage: null }]);
      expect(textOf(out)).toBe('Done.  Anything else? [1]');
      expect(out.at(-1)).toMatchObject({ type: 'completed', outputText: 'Done.  Anything else? [1]' });
    }
    // three ways: one character at a time
    const slow = await run([...said].map((text) => ({ type: 'text' as const, text })));
    expect(textOf(slow)).toBe('Done.  Anything else? [1]');
  });

  it('lets words that only began like a tag go on, when the next words or the end of the stream show they were not one', async () => {
    expect(textOf(await run([{ type: 'text', text: 'a [universe-' }, { type: 'text', text: 'jobs are here' }]))).toBe('a [universe-jobs are here');
    expect(textOf(await run([{ type: 'text', text: 'ends with [universe-job:abc' }]))).toBe('ends with [universe-job:abc');
    // a tag that is the last thing said is out too (nothing can follow it)
    expect(textOf(await run([{ type: 'text', text: `last words ${jobTagOf(ID).split(']')[0]}]` }]))).toBe('last words ');
    // something else in the stream ends the wait
    const out = await run([{ type: 'text', text: 'x [universe-job:ab' }, { type: 'tool', state: 'started', tool: 'browser' }, { type: 'text', text: 'cd]' }]);
    expect(textOf(out)).toBe('x [universe-job:abcd]');
  });

  it('takes it out of a tool’s label and error and a failure’s message, and passes keepalives and ids as they are', async () => {
    const out = await run([
      { type: 'created', id: 'r1', sessionId: 's1' },
      { type: 'keepalive' },
      { type: 'tool', state: 'started', tool: 'shell', label: `echo [universe-job:${ID}]` },
      { type: 'tool', state: 'failed', tool: 'shell', error: `bad [universe-job:${ID}]` },
      { type: 'failed', code: 'x', message: `no [universe-job:${ID}]` },
    ]);
    expect(out).toEqual([
      { type: 'created', id: 'r1', sessionId: 's1' },
      { type: 'keepalive' },
      { type: 'tool', state: 'started', tool: 'shell', label: 'echo ' },
      { type: 'tool', state: 'failed', tool: 'shell', error: 'bad ' },
      { type: 'failed', code: 'x', message: 'no ' },
    ]);
  });
});
