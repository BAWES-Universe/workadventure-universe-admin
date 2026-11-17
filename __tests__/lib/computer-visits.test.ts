/**
 * Reading back where a computer's browser went (R06): what Orbit keeps of what the machine says, which is only what is exactly the shape
 * of a host and a path, and how the record says how well it was taken. Pure: nothing here reads a machine or a database.
 */
jest.mock('@/lib/db', () => ({ prisma: {} }));

import { CLOCK_SKEW_MS, READ_PAD_MS, VISITS_MAX, cleanHost, cleanPath, parseReadBack, shapeVisits, type VisitLine } from '@/lib/computer-visits';

const T0 = 1_794_900_000_000;
const started = new Date(T0);
const ended = new Date(T0 + 600_000);

const line = (over: Record<string, unknown>) => `line=${JSON.stringify({ k: 'visit', at: T0 + 1000, m: 'GET', h: 'shop.example', p: '/a', n: 1, ...over })}`;
const back = (rows: string[], head: Partial<{ now: number; state: string; open: number; alive: number; more: number; end: boolean }> = {}) =>
  [`now=${head.now ?? T0 + 700_000}`, `state=${head.state ?? 'on'}`, `open=${head.open ?? 0}`, `alive=${head.alive ?? 1}`, ...(head.more ? [`more=${head.more}`] : []), ...rows, ...(head.end === false ? [] : ['end=1'])].join('\n') + '\n';

const shape = (stdout: string, over: Partial<Parameters<typeof shapeVisits>[0]> = {}) =>
  shapeVisits({ back: parseReadBack(stdout), startedAt: started, endedAt: ended, before: T0 + 699_000, after: T0 + 701_000, hands: [], ...over });

describe('what is kept of an address', () => {
  it('keeps a lower case host with its port, and cuts a path to the path alone', () => {
    expect(cleanHost('shop.example')).toBe('shop.example');
    expect(cleanHost('api.shop.example:8443')).toBe('api.shop.example:8443');
    expect(cleanHost('[::1]:3000')).toBe('[::1]:3000');
    for (const bad of ['Shop.Example', 'user@shop.example', 'shop.example/path', 'shop.example?x=1', 'a b', '', ':80', 'x'.repeat(256), 42, null]) expect(cleanHost(bad)).toBeNull();
    expect(cleanPath('/cart/?item=1&token=abc#top')).toBe('/cart/');
    expect(cleanPath('/a/b#frag')).toBe('/a/b');
    expect(cleanPath('/share/550e8400-e29b-41d4-a716-446655440000')).toBe('/share/…');
    expect(cleanPath('/r/AbCd1234EfGh5678IjKl9012MnOp/x')).toBe('/r/…/x');
    // a versioned storage key, a random code with no digit in it, and a long code of lower case and digits are not kept either
    expect(cleanPath('/files/v1-3fa9c2d41b7e8a905c6d1e2f/download')).toBe('/files/\u2026/download');
    expect(cleanPath('/af/AbCdEfGhIjKlMnOpQrStUvWxYz')).toBe('/af/\u2026');
    expect(cleanPath('/t/abcdefghijklmnop0123456789ab')).toBe('/t/\u2026');
    // the same codes written with percent signs, twice over, or behind an encoded slash, are cut as well; a readable encoded part stays
    expect(cleanPath('/reset/%41bCdEfGhIjKlMnOpQrStUvWxYz')).toBe('/reset/\u2026');
    expect(cleanPath('/reset/%2541bCdEfGhIjKlMnOpQrStUvWxYz')).toBe('/reset/\u2026');
    expect(cleanPath('/share/x%2F550e8400-e29b-41d4-a716-446655440000')).toBe('/share/\u2026');
    // a broken escape is no code, and one whole escape next to it is still read
    expect(cleanPath('/odd/%ZZ-readable')).toBe('/odd/%ZZ-readable');
    expect(cleanPath('/reset/%ZZ/%41bCdEfGhIjKlMnOpQrStUvWxYz')).toBe('/reset/%ZZ/\u2026');
    expect(cleanPath('/a%20readable%20part/%E2%9C%93')).toBe('/a%20readable%20part/%E2%9C%93');
    // a long readable address is kept: a private link is a mix of cases and digits, a slug is not
    expect(cleanPath('/how-to-apply-for-a-visa-in-2026-step-by-step')).toBe('/how-to-apply-for-a-visa-in-2026-step-by-step');
    for (const bad of ['cart', 'with space', '/tab\there', '/nul\u0000', '', 42, null]) expect(cleanPath(bad)).toBeNull();
    expect(cleanPath('/' + 'g'.repeat(400))).toHaveLength(300);
  });
});

describe('what the machine says is checked again', () => {
  it('drops any line that is not exactly one of ours and strips a query string even if one was written', () => {
    const out = parseReadBack(
      back([
        line({ p: '/cart?card=4242&secret=x#top' }),
        line({ k: 'post', m: 'POST', form: 1, p: '/pay', h: 'shop.example:8443' }),
        line({ k: 'on' }),
        'line=not json',
        line({ k: 'weird' }),
        line({ h: 'User@Shop.Example' }),
        line({ h: 'shop.example/evil' }),
        line({ p: 'no-slash' }),
        line({ m: 'post' }),
        line({ at: -1 }),
        line({ at: 'soon' }),
        line({ n: 0 }),
        line({ n: 1.5 }),
        `line=${JSON.stringify({ k: 'visit', at: T0, m: 'GET', h: 'shop.example', p: '/' + 'x'.repeat(2000) })}`,
        'line=[]',
        'line=null',
        'something else',
      ]),
    );
    const visits = out.lines.filter((entry): entry is VisitLine => entry.kind === 'visit' || entry.kind === 'post');
    expect(visits.map((entry) => [entry.kind, entry.method, entry.host, entry.path, entry.form])).toEqual([
      ['visit', 'GET', 'shop.example', '/cart', false],
      ['post', 'POST', 'shop.example:8443', '/pay', true],
    ]);
    expect(out.lines.filter((entry) => entry.kind === 'on')).toHaveLength(1);
    expect(out).toMatchObject({ state: 'on', alive: true, ended: true, more: 0 });
  });

  it('is not trusted for anything it did not say: a missing end line is an answer cut short', () => {
    expect(parseReadBack('').ended).toBe(false);
    expect(parseReadBack(back([], { end: false })).ended).toBe(false);
    expect(parseReadBack('now=abc\nstate=maybe\n')).toMatchObject({ now: null, state: 'none' });
  });
});

describe('what a job keeps and how well it was recorded', () => {
  it('keeps only the job’s own time, by our clock, however far the machine’s clock is from ours', () => {
    // The machine is 30 seconds ahead of us: its line at T0 + 31 s is our T0 + 1 s
    const stdout = back([line({ at: T0 - 5_000 + 30_000, p: '/before' }), line({ at: T0 + 31_000, p: '/inside' }), line({ at: T0 + 700_000 + 30_000, p: '/after' })], { now: T0 + 700_000 + 30_000 });
    const { rows, state } = shape(stdout);
    expect(rows.map((row) => row.path)).toEqual(['/inside']);
    expect(rows[0].at.getTime()).toBe(T0 + 1_000);
    expect(state).toBe('complete');
  });

  it('says partial when the machine’s clock is too far from ours to tell the edges of the job', () => {
    const { state } = shape(back([line({})], { now: T0 + 700_000 + CLOCK_SKEW_MS + 5_000 }));
    expect(state).toBe('partial');
  });

  it('makes the same thing in a row one row with a count, but not the same thing after something else, or across a take-over', () => {
    const rows = shape(
      back([line({ at: T0 + 1_000 }), line({ at: T0 + 2_000, n: 3 }), line({ at: T0 + 3_000, p: '/b' }), line({ at: T0 + 4_000 }), line({ at: T0 + 5_000, k: 'post', m: 'POST', form: 1 }), line({ at: T0 + 6_000, k: 'post', m: 'POST' }), line({ at: T0 + 20_000 }), line({ at: T0 + 21_000 })]),
      { hands: [{ at: new Date(T0 + 10_000), by: 'person' }, { at: new Date(T0 + 30_000), by: 'brick' }] },
    ).rows;
    expect(rows.map((row) => [row.kind, row.path, row.count, row.by, row.form])).toEqual([
      ['visit', '/a', 4, 'brick', false],
      ['visit', '/b', 1, 'brick', false],
      ['visit', '/a', 1, 'brick', false],
      ['post', '/a', 1, 'brick', true],
      ['post', '/a', 1, 'brick', false],
      ['visit', '/a', 2, 'person', false],
    ]);
  });

  it('does not make one row of the same page seen before and after a take-over that happened between', () => {
    const { rows } = shape(back([line({ at: T0 + 5_000 }), line({ at: T0 + 12_000 }), line({ at: T0 + 40_000 })]), {
      hands: [{ at: new Date(T0 + 10_000), by: 'person' }, { at: new Date(T0 + 30_000), by: 'brick' }],
    });
    expect(rows.map((row) => [row.by, row.count, row.at.getTime() - T0])).toEqual([['brick', 1, 5_000], ['person', 1, 12_000], ['brick', 1, 40_000]]);
    // a take-over with nothing opened during it: the visits before and after it are still two rows (the take-over is a boundary of its own)
    const none = shape(back([line({ at: T0 + 5_000 }), line({ at: T0 + 40_000 })]), { hands: [{ at: new Date(T0 + 10_000), by: 'person' }, { at: new Date(T0 + 30_000), by: 'brick' }] }).rows;
    expect(none.map((row) => [row.by, row.count, row.at.getTime() - T0])).toEqual([['brick', 1, 5_000], ['brick', 1, 40_000]]);
    // the same page twice inside one stretch is still one row
    const same = shape(back([line({ at: T0 + 5_000 }), line({ at: T0 + 6_000 })]), { hands: [{ at: new Date(T0 + 10_000), by: 'person' }] }).rows;
    expect(same.map((row) => [row.by, row.count])).toEqual([['brick', 2]]);
  });

  it('marks what was opened while the person had the computer as theirs, and what comes after they gave it back as Brick’s', () => {
    const { rows } = shape(back([line({ at: T0 + 1_000, p: '/one' }), line({ at: T0 + 10_000, p: '/two' }), line({ at: T0 + 20_000, p: '/three' }), line({ at: T0 + 30_000, p: '/four' })]), {
      hands: [{ at: new Date(T0 + 30_000), by: 'brick' }, { at: new Date(T0 + 10_000), by: 'person' }],
    });
    expect(rows.map((row) => [row.path, row.by])).toEqual([['/one', 'brick'], ['/two', 'person'], ['/three', 'person'], ['/four', 'brick']]);
  });

  it('is complete for a quiet browser that was connected the whole time, and for one that was gone (nothing could be opened) and came back', () => {
    expect(shape(back([])).state).toBe('complete');
    expect(shape(back([line({ k: 'off', at: T0 + 100_000, b: 0 }), line({ k: 'on', at: T0 + 110_000 })])).state).toBe('complete');
  });

  it('is partial when the listener lost the browser while it was still there, because a page opened in that stretch was not seen', () => {
    // the browser stayed (b 1, or an older line that does not say) and the listener came back
    expect(shape(back([line({ k: 'off', at: T0 + 100_000, b: 1 }), line({ k: 'on', at: T0 + 110_000 })])).state).toBe('partial');
    expect(shape(back([line({ k: 'off', at: T0 + 100_000 }), line({ k: 'on', at: T0 + 110_000 })])).state).toBe('partial');
    // it never came back before the job ended
    expect(shape(back([line({ k: 'off', at: T0 + 100_000, b: 1 })])).state).toBe('partial');
    // it was already not connected when the read began, and came back during the job
    expect(shape(back([line({ k: 'on', at: T0 + 5_000 })], { state: 'off', open: 1 })).state).toBe('partial');
    // a stretch before the job, or one that began after it, is not a gap in it
    expect(shape(back([line({ k: 'off', at: T0 - 20_000, b: 1 }), line({ k: 'on', at: T0 - 10_000 })])).state).toBe('complete');
    expect(shape(back([line({ k: 'off', at: T0 + 650_000, b: 1 }), line({ k: 'on', at: T0 + 660_000 })])).state).toBe('complete');
  });

  it('is partial when the listener was started again without the browser going away, or lines were cut, or it is not running, or the answer was cut short, or there were more', () => {
    expect(shape(back([line({ k: 'on', at: T0 + 100_000 })])).state).toBe('partial');
    expect(shape(back([line({ k: 'cut', at: T0 + 100_000 })])).state).toBe('partial');
    expect(shape(back([line({})], { alive: 0 })).state).toBe('partial');
    expect(shape(back([line({})], { end: false })).state).toBe('partial');
    expect(shape(back([line({})], { more: 4 })).state).toBe('partial');
    // a cut or a restart BEFORE the job is not a gap in it
    expect(shape(back([line({ k: 'cut', at: T0 - 10_000 }), line({ k: 'on', at: T0 - 5_000 })], { state: 'on' })).state).toBe('complete');
  });

  it('is none for a computer whose listener never ran, and partial for one that stopped without a sign', () => {
    expect(shape(back([], { state: 'none', alive: 0 })).state).toBe('none');
    expect(shape(back([line({})], { state: 'on', alive: 0 })).state).toBe('partial');
  });

  it(`keeps at most ${VISITS_MAX} rows and says partial past them`, () => {
    const many = Array.from({ length: VISITS_MAX + 20 }, (_, i) => line({ at: T0 + 1_000 + i, p: `/p/${i}` }));
    const { rows, state } = shape(back(many));
    expect(rows).toHaveLength(VISITS_MAX);
    expect(state).toBe('partial');
  });

  it('reads from a little before the job began, because the two clocks are not the same clock', () => {
    expect(READ_PAD_MS).toBeGreaterThanOrEqual(CLOCK_SKEW_MS);
  });
});
