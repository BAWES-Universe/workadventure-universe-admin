import { isAppShareable, nextDay, SHAREABLE_HEADINGS } from '@/lib/app-share';
import { resolveJobs, type JobCandidate } from '@/lib/app-share-owner';
import { shapeOfTool } from '@/lib/mcp/test-connection';
import { BRICK_LIMITS_RECOMMENDED, checkServerLimits, readServerLimits } from '@/lib/bot-limit-values';

const song: JobCandidate = { tool: 'make_song', title: 'Make Song', description: null, heading: 'makesNew', fingerprint: 'fp', inputs: [{ name: 'prompt', required: true }, { name: 'style', required: false }], outputs: ['url', 'title'] };
const find: JobCandidate = { tool: 'find_songs', title: 'Find Songs', description: null, heading: 'looksUp', fingerprint: 'fp2', inputs: [{ name: 'query', required: true }], outputs: null };

describe('what can be shared (game #2006)', () => {
  it('shares only an app added with a link and a key, a token or nothing, never one signed in as the person', () => {
    expect(isAppShareable({ ownerId: 'a', source: 'link', authType: 'bearer' })).toBe(true);
    expect(isAppShareable({ ownerId: 'a', source: 'link', authType: 'none' })).toBe(true);
    expect(isAppShareable({ ownerId: 'a', source: 'link', authType: 'oauth' })).toBe(false);
    expect(isAppShareable({ ownerId: 'a', source: 'listed', authType: 'bearer' })).toBe(false);
    expect(isAppShareable({ ownerId: 'a', source: 'ready_made', authType: 'none' })).toBe(false);
    expect(isAppShareable({ ownerId: null, source: 'link', authType: 'bearer' })).toBe(false);
  });

  it('shares look-ups and makes, never changes, deletes or sends', () => {
    expect([...SHAREABLE_HEADINGS]).toEqual(['looksUp', 'makesNew']);
  });

  it('says a day is back at the next midnight UTC', () => {
    expect(nextDay(new Date('2026-11-14T23:59:59Z')).toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(nextDay(new Date('2026-11-14T00:00:00Z')).toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });
});

describe('resolving the jobs an owner picked', () => {
  it('takes a pick that matches what the tool offers, naming every field that may come back', () => {
    expect(resolveJobs([{ tool: 'make_song', inputs: ['prompt'], returns: null }], [song], true)).toEqual({ ok: true, jobs: [{ tool: 'make_song', fingerprint: 'fp', inputs: ['prompt'], returns: ['url', 'title'] }] });
    expect(resolveJobs([{ tool: 'make_song', inputs: ['prompt', 'style', 'prompt'], returns: ['url'] }], [song], true)).toEqual({ ok: true, jobs: [{ tool: 'make_song', fingerprint: 'fp', inputs: ['prompt', 'style'], returns: ['url'] }] });
    expect(resolveJobs([{ tool: 'find_songs', inputs: ['query'], returns: null }], [find], true)).toEqual({ ok: true, jobs: [{ tool: 'find_songs', fingerprint: 'fp2', inputs: ['query'], returns: null }] });
  });

  it('refuses what the tool does not offer, and what would leave a job nobody could ask for', () => {
    const problem = (job: Parameters<typeof resolveJobs>[0][number], candidates = [song, find]) => {
      const result = resolveJobs([job], candidates, true);
      return result.ok ? null : result.problem;
    };
    expect(problem({ tool: 'delete_song', inputs: [], returns: null })).toBe('unknown_job');
    expect(problem({ tool: 'make_song', inputs: ['prompt', 'owner'], returns: null })).toBe('bad_input');
    expect(problem({ tool: 'make_song', inputs: ['style'], returns: null })).toBe('missing_input');
    expect(problem({ tool: 'make_song', inputs: ['prompt'], returns: ['password'] })).toBe('bad_return');
    expect(problem({ tool: 'find_songs', inputs: ['query'], returns: ['title'] })).toBe('bad_return');
    expect(resolveJobs([{ tool: 'make_song', inputs: ['prompt'], returns: null }], [song], false)).toEqual({ ok: false, problem: 'unreachable' });
  });
});

describe('what a tool takes and gives back, by field name only', () => {
  it('keeps names and whether an input is needed, never a default or an example', () => {
    const shape = shapeOfTool({ name: 'make_song', description: 'Makes a song', inputSchema: { type: 'object', properties: { prompt: { type: 'string', default: 'secret default' }, style: {} }, required: ['prompt'] }, outputSchema: { type: 'object', properties: { url: {}, title: {} } } }, 'make_song');
    expect(shape).toEqual({ name: 'make_song', description: 'Makes a song', inputs: [{ name: 'prompt', required: true }, { name: 'style', required: false }], outputs: ['url', 'title'] });
    expect(JSON.stringify(shape)).not.toContain('secret default');
  });

  it('says nothing about what comes back when the tool does not say, and reads an OpenAI style tool too', () => {
    expect(shapeOfTool({ name: 'x' }, 'x')).toEqual({ name: 'x', description: null, inputs: [], outputs: null });
    expect(shapeOfTool({ function: { name: 'y', description: 'Why', parameters: { properties: { q: {} }, required: ['q'] } } } as never, 'y').inputs).toEqual([{ name: 'q', required: true }]);
  });
});

describe('the starting limits are settings (Limits)', () => {
  it('start at 20 for everyone and 3 for each person, with their ceilings', () => {
    expect(BRICK_LIMITS_RECOMMENDED).toMatchObject({ sharedUsesEveryone: 20, sharedUsesPerPerson: 3, sharedTriesPerHour: 60, sharedRetries: 2, sharedJobsAtOnce: 3, sharedJobMinutes: 10 });
    expect(readServerLimits({ bricks: { sharedUsesEveryone: 50 } }).bricks).toMatchObject({ sharedUsesEveryone: 50, sharedUsesPerPerson: 3 });
  });

  it('turns down values that cannot be saved', () => {
    expect(checkServerLimits({ bricks: { sharedUsesPerPerson: 0 } }).ok).toBe(false);
    expect(checkServerLimits({ bricks: { sharedRetries: 0 } }).ok).toBe(true);
    expect(checkServerLimits({ bricks: { sharedJobsAtOnce: 1.5 } }).ok).toBe(false);
  });
});
