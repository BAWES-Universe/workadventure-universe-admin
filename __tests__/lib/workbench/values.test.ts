import {
  CODE_JOB_LIMIT_RANGES,
  CODE_JOB_LIMITS_EMPTY,
  CODE_JOB_NEEDED,
  capabilitySet,
  checkCodeJobLimits,
  clip,
  codeJobKey,
  contentTypeOf,
  filledLimits,
  isSafeFileName,
  missingCodeJobLimits,
  readCodeJobLimits,
  readJobRequest,
  touchesSandbox,
  type FilledLimits,
} from '@/lib/workbench/values';

const LIMITS: FilledLimits = {
  maxSeconds: 300,
  maxCells: 3,
  maxCodeBytes: 1000,
  maxInputBytes: 2000,
  maxOutputBytes: 5000,
  maxOutputFiles: 4,
  maxResultChars: 100,
  maxReads: 2,
  atOncePerPerson: 1,
  atOnceAll: 3,
  jobsPerPersonPerDay: 20,
  exposureCeilingMicros: 1_000_000,
  keepDays: null,
  waitSeconds: 40,
};

describe('the Limits of a code job', () => {
  it('start empty, so no number is ever assumed in code', () => {
    expect(filledLimits(CODE_JOB_LIMITS_EMPTY)).toBeNull();
    expect(missingCodeJobLimits(CODE_JOB_LIMITS_EMPTY)).toEqual(CODE_JOB_NEEDED);
    expect(CODE_JOB_NEEDED).not.toContain('keepDays');
  });

  it('read back only what is there and fits its range', () => {
    const read = readCodeJobLimits({ maxSeconds: 120, maxCells: 0, maxReads: 1.5, waitSeconds: 9999, nonsense: 1 });
    expect(read.maxSeconds).toBe(120);
    expect(read.maxCells).toBeNull();
    expect(read.maxReads).toBeNull();
    expect(read.waitSeconds).toBeNull();
    expect(readCodeJobLimits('x')).toEqual(CODE_JOB_LIMITS_EMPTY);
  });

  it('keep the wait for a result under the bot server’s own 60 seconds', () => {
    expect(CODE_JOB_LIMIT_RANGES.waitSeconds.max).toBeLessThan(60);
  });

  it('accept a change inside the ranges, an empty one, and refuse the rest', () => {
    expect(checkCodeJobLimits({ maxSeconds: 60, keepDays: null })).toEqual({ ok: true, value: { maxSeconds: 60, keepDays: null } });
    expect(checkCodeJobLimits({ maxSeconds: 0 }).ok).toBe(false);
    expect(checkCodeJobLimits({ maxSeconds: CODE_JOB_LIMIT_RANGES.maxSeconds.max + 1 }).ok).toBe(false);
    expect(checkCodeJobLimits({ maxSeconds: '60' }).ok).toBe(false);
    expect(checkCodeJobLimits({ nope: 1 }).ok).toBe(false);
    expect(checkCodeJobLimits([]).ok).toBe(false);
    expect(checkCodeJobLimits({ toString: 1 }).ok).toBe(false);
  });
});

describe('keys and names', () => {
  it('make one key for one Brick and call id, and a different one for another', () => {
    expect(codeJobKey('b1', 'c1')).toBe(codeJobKey('b1', 'c1'));
    expect(codeJobKey('b1', 'c1')).not.toBe(codeJobKey('b2', 'c1'));
    expect(codeJobKey('b1', 'c1')).not.toBe(codeJobKey('b1', 'c2'));
    // The length is part of the key, so two splits of the same letters are not the same job
    expect(codeJobKey('ab', 'c')).not.toBe(codeJobKey('a', 'bc'));
  });

  it('keep a long call id inside the column by hashing it', () => {
    const key = codeJobKey('b1', 'x'.repeat(1000));
    expect(key.length).toBeLessThanOrEqual(255);
    expect(key).toBe(codeJobKey('b1', 'x'.repeat(1000)));
    expect(key).not.toBe(codeJobKey('b1', `${'x'.repeat(999)}y`));
  });

  it('allow plain file names only', () => {
    for (const name of ['a.csv', 'read-1.json', 'Report_2.txt']) expect(isSafeFileName(name)).toBe(true);
    for (const name of ['', '.hidden', '../x', 'a/b', 'a\\b', 'a..b', '-x', 'x'.repeat(101), 'a b', 3, null, undefined]) expect(isSafeFileName(name)).toBe(false);
  });

  it('tell a type from the extension, and call an unknown one plain bytes', () => {
    expect(contentTypeOf('a.csv')).toMatch(/csv/);
    expect(contentTypeOf('a.json')).toBe('application/json');
    expect(contentTypeOf('a.zzzzz')).toBe('application/octet-stream');
  });

  it('clip text at a number of characters and say so', () => {
    expect(clip('abc', 5)).toEqual({ text: 'abc', clipped: false });
    expect(clip('abcdef', 3)).toEqual({ text: 'abc', clipped: true });
  });
});

describe('the provider’s own sandbox on an App link', () => {
  it('is found alone, in any case, and inside a batch', () => {
    expect(touchesSandbox('COMPOSIO_REMOTE_WORKBENCH', {})).toBe(true);
    expect(touchesSandbox(' composio_remote_bash_tool ', {})).toBe(true);
    expect(touchesSandbox('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_X' }, { tool_slug: ' Composio_Remote_Workbench' }] })).toBe(true);
    expect(touchesSandbox('composio_multi_execute_tool', { tools: [{ tool_slug: 'COMPOSIO_REMOTE_BASH_TOOL' }] })).toBe(true);
  });

  it('is not found in an ordinary call, a plain batch or a call that is not shaped like either', () => {
    expect(touchesSandbox('GMAIL_FETCH_EMAILS', {})).toBe(false);
    expect(touchesSandbox('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_X' }] })).toBe(false);
    expect(touchesSandbox('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: 'x' })).toBe(false);
    expect(touchesSandbox('COMPOSIO_MULTI_EXECUTE_TOOL', null)).toBe(false);
    expect(touchesSandbox('GMAIL_X', { tools: [{ tool_slug: 'COMPOSIO_REMOTE_WORKBENCH' }] })).toBe(false);
    expect(touchesSandbox(undefined, {})).toBe(false);
  });
});

describe('what a job’s request may be', () => {
  const read = (args: unknown, toolkit: string | null = 'crm') => readJobRequest(args, LIMITS, toolkit);

  it('takes code, or steps, and never both or neither', () => {
    expect(read({ code: 'print(1)' })).toMatchObject({ ok: true, value: { steps: ['print(1)'], inputs: [], reads: [] } });
    expect(read({ steps: ['a', 'b'] })).toMatchObject({ ok: true, value: { steps: ['a', 'b'] } });
    for (const args of [{}, { code: '  ' }, { code: 'a', steps: ['b'] }, { steps: [] }, { steps: [1] }, { steps: ['  '] }, 'print(1)', null, [], { code: 5 }]) {
      expect(read(args)).toMatchObject({ ok: false, reason: 'bad_request' });
    }
    expect(read({ code: 'a', surprise: true })).toMatchObject({ ok: false, reason: 'bad_request' });
  });

  it('stops at the Limits for runs, code size and input size', () => {
    expect(read({ steps: ['1', '2', '3', '4'] })).toMatchObject({ ok: false, reason: 'bad_request' });
    expect(read({ code: 'x'.repeat(1001) })).toMatchObject({ ok: false, reason: 'too_big' });
    // Counted in bytes, not characters
    expect(read({ code: 'é'.repeat(501) })).toMatchObject({ ok: false, reason: 'too_big' });
    expect(read({ code: 'a', inputs: [{ name: 'a.txt', content: 'x'.repeat(2001) }] })).toMatchObject({ ok: false, reason: 'too_big' });
    // Base64 is counted as the bytes it holds
    expect(read({ code: 'a', inputs: [{ name: 'a.bin', content: 'A'.repeat(3000), base64: true }] })).toMatchObject({ ok: false, reason: 'too_big' });
    expect(read({ code: 'a', inputs: [{ name: 'a.bin', content: 'A'.repeat(100), base64: true }] })).toMatchObject({ ok: true });
  });

  it('takes inputs only with plain, different names', () => {
    expect(read({ code: 'a', inputs: [{ name: '../a', content: 'x' }] })).toMatchObject({ ok: false });
    expect(read({ code: 'a', inputs: [{ name: 'a.txt' }] })).toMatchObject({ ok: false });
    expect(read({ code: 'a', inputs: [{ name: 'a.txt', content: 'x', base64: 'yes' }] })).toMatchObject({ ok: false });
    expect(read({ code: 'a', inputs: [{ name: 'a.txt', content: 'x' }, { name: 'a.txt', content: 'y' }] })).toMatchObject({ ok: false });
    expect(read({ code: 'a', inputs: 'x' })).toMatchObject({ ok: false });
  });

  it('takes reads only of a tool of the App the job was asked through, and never a provider tool', () => {
    expect(read({ code: 'a', reads: [{ tool: 'CRM_LIST', arguments: { n: 1 } }, { tool: 'crm_get' }] })).toMatchObject({
      ok: true,
      value: { reads: [{ tool: 'CRM_LIST', arguments: { n: 1 }, as: 'read-1.json' }, { tool: 'crm_get', arguments: {}, as: 'read-2.json' }] },
    });
    for (const tool of ['COMPOSIO_REMOTE_WORKBENCH', 'COMPOSIO_MULTI_EXECUTE_TOOL', 'OTHER_LIST', 'CRM', 'CRM LIST', 'CRM_../x']) {
      expect(read({ code: 'a', reads: [{ tool }] })).toMatchObject({ ok: false, reason: 'bad_request' });
    }
    // An App link with no known App cannot read anything
    expect(read({ code: 'a', reads: [{ tool: 'CRM_LIST' }] }, null)).toMatchObject({ ok: false });
    expect(read({ code: 'a', reads: [{ tool: 'CRM_A' }, { tool: 'CRM_B' }, { tool: 'CRM_C' }] })).toMatchObject({ ok: false });
    expect(read({ code: 'a', reads: [{ tool: 'CRM_A', arguments: 'x' }] })).toMatchObject({ ok: false });
    expect(read({ code: 'a', reads: [{ tool: 'CRM_A', as: 'a/b' }] })).toMatchObject({ ok: false });
    // A read’s file may not take the name of an input
    expect(read({ code: 'a', inputs: [{ name: 'read-1.json', content: 'x' }], reads: [{ tool: 'CRM_A' }] })).toMatchObject({ ok: false });
  });

  it('says in the job’s capabilities what the code could reach: nothing of the person’s', () => {
    const request = read({ code: 'a', reads: [{ tool: 'CRM_LIST' }] });
    if (!request.ok) throw new Error('expected a request');
    expect(capabilitySet(request.value, 'crm')).toMatchObject({ credentials: 'none', appTools: 'none', rawRequests: 'off', instant: 'off', reads: ['CRM_LIST'], readsApp: 'crm' });
    const plain = read({ code: 'a' });
    if (!plain.ok) throw new Error('expected a request');
    expect(capabilitySet(plain.value, 'crm').readsApp).toBeNull();
  });
});
