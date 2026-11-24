import { cleanStepLabel, hasSecretShape, STEP_LABEL_FALLBACK } from '@/lib/computer-redact';

const KEY = `cjt_${'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9f'.slice(0, 43)}`;

describe('a step label never carries a secret', () => {
  it('turns the real shapes seen on dev, and the other places a key can sit in a command, into the plain phrase', () => {
    const risky = [
      // What dev showed: an env assignment holding the job's own relay key, then "+ 7 commands"
      `T=${KEY} + 7 commands`,
      `T=${KEY} curl -s https://relay.example.test/v1/models + 7 commands`,
      `export OPENAI_API_KEY=sk-proj-abcdefghijkl1234 && python run.py`,
      `HOME=/root PASSWORD=hunter2 ./go.sh`,
      `curl -H "Authorization: Bearer ${KEY}" https://relay.example.test/v1/models`,
      `curl -H 'authorization: bearer abcdef123456' https://x.test`,
      `curl -H "X-Api-Key: abc123" https://x.test`,
      `Bearer ${KEY}`,
      `git clone https://user:ghp_abcdefghijkl1234@github.com/o/r`,
      `git clone https://someone:pw@example.test/o/r.git`,
      `curl -u admin:secret https://x.test`,
      `login --password hunter2`,
      `set token ghp_abcdefghijklmnop1234`,
      `slack xoxb-1234567890-abcdefghij`,
      `aws AKIAABCDEFGHIJKLMNOP`,
      `jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0`,
      KEY,
    ];
    for (const text of risky) {
      expect(hasSecretShape(text)).toBe(true);
      expect(cleanStepLabel(text)).toBe(STEP_LABEL_FALLBACK);
      // Nothing of the line survives, whatever follows the secret
      expect(cleanStepLabel(`${text} and then more words`)).toBe(STEP_LABEL_FALLBACK);
    }
  });

  it('finds a command at the start of any line of the label as it was written, not only where the joined line begins (CodeRabbit: the lines were joined first, and the assignment then sat after plain words)', () => {
    const risky = [
      'Checking service\nPASSWORD=hunter2 curl https://example.test',
      'Checking service\r\nPASSWORD=hunter2 curl https://example.test',
      'PASSWORD=hunter2\nChecking service',
      'Checking\nthe service\n  \tAPI_TOKEN=abc123 run.sh',
      'Checking service\tPASSWORD=hunter2 curl https://example.test',
      'Checking service\u2028SECRET=x',
    ];
    for (const text of risky) {
      expect(hasSecretShape(text)).toBe(true);
      expect(cleanStepLabel(text)).toBe(STEP_LABEL_FALLBACK);
      expect(cleanStepLabel(`${text}\nand then more words`)).toBe(STEP_LABEL_FALLBACK);
    }
    // Ordinary words over several lines stay as they are, on one line
    expect(cleanStepLabel('Checking service\nthen writing the report\n\tand sending it')).toBe('Checking service then writing the report and sending it');
    expect(cleanStepLabel('Opening the page\nwith ?plan=2&tab=3 in it')).toBe('Opening the page with ?plan=2&tab=3 in it');
    expect(cleanStepLabel('Setting up\nwidth is 10 in the sheet')).toBe('Setting up width is 10 in the sheet');
  });

  it('keeps an ordinary label as it is, on one line and short, and hides only a key-like run in a file name', () => {
    expect(cleanStepLabel('Reading the inbox')).toBe('Reading the inbox');
    expect(cleanStepLabel('  Step 2: writing   the\nreport\t')).toBe('Step 2: writing the report');
    expect(cleanStepLabel('Opening https://example.com/pricing?plan=2&tab=3')).toBe('Opening https://example.com/pricing?plan=2&tab=3');
    expect(cleanStepLabel('Setting width=10 in the sheet')).toBe('Setting width=10 in the sheet');
    // An assignment where a command begins is never told apart from a secret one: the plain phrase, which costs nothing
    for (const command of ['A=1 run it', 'echo hi; B=2 run', 'x && C=3 y', 'ls | D=4 z', '(E=5 cmd)', 'sudo F=6 cmd', 'env G=7 cmd']) expect(cleanStepLabel(command)).toBe(STEP_LABEL_FALLBACK);
    expect(cleanStepLabel('Reading quarterly_report_2026_final_v2_draft.csv')).toBe('Reading ….csv');
    expect(cleanStepLabel('Typing in the user field and the e-mail box')).toBe('Typing in the user field and the e-mail box');
    expect(cleanStepLabel('x'.repeat(300))).toHaveLength(200);
    expect(Array.from(cleanStepLabel('é'.repeat(300)) ?? '')).toHaveLength(200);
  });

  it('Sentry on #1025 (S1): real credentials in a header or a flag are still hidden, and plain words that only look like one are kept', () => {
    const real = [
      'Basic dXNlcjpwYXNz',
      'basic dXNlcjpwYXNz',
      'BASIC dXNlcjpwYXNz',
      'Basic YWRtaW46c2VjcmV0',
      'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0',
      'Bearer abc_def_ghi',
      'bearer abcdef123456',
      'curl -H "Authorization: Basic dXNlcjpwYXNz" https://x.test',
      'Cookie: sid=abc',
      'set-cookie: a=b',
      'Cookie=sid123',
      'login --password hunter2',
      'x --token=abc',
      'run -auth x',
      'curl --api-key abc',
      '--password hunter2',
      'run "--token=abc"',
    ];
    for (const text of real) {
      expect(hasSecretShape(text)).toBe(true);
      expect(cleanStepLabel(`${text} and then more words`)).toBe(STEP_LABEL_FALLBACK);
    }
    const plain = ['Basic information', 'Basic instructions', 'Basic Information about the visa', 'BASIC INSTRUCTIONS', 'basic input/output', 'basic set-up steps', 'Basic e-mail', 'Bearer of news', 'Cookie: ', 'Accept the Cookie:', 'pre-auth login', 're-auth page', 'post-token refresh now'];
    for (const text of plain) {
      expect(hasSecretShape(text)).toBe(false);
      expect(cleanStepLabel(text)).toBe(text.trim());
    }
  });

  it('Opus on acfe2a2e (R1, R2): a credential flag is hidden after any non-word character, and Bearer hides anything that is not one plain word', () => {
    const hidden = [
      // R1: the flag follows a character the first anchor did not list
      'Ran `--password hunter2`',
      'mysql,--password hunter2',
      '[--token abc]',
      '{--secret=abc}',
      'a|--token x',
      'x&&--token y',
      'run "--token=abc"',
      // R2
      'Bearer abc-def-ghi',
      'Bearer ABCDEFGHIJKL',
      'Bearer abc.def',
      'Bearer tok/en.ab-cd',
      'Bearer dXNlcjpwYXNz',
      'BEARER abcdef1',
      'Bearer abcdefgh=',
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0',
      'bearer abcdef123456',
      'Bearer cjt_abc123',
      // The Cookie change
      'Cookie: sid=abc',
    ];
    for (const text of hidden) {
      expect(hasSecretShape(text)).toBe(true);
      expect(cleanStepLabel(text)).toBe(STEP_LABEL_FALLBACK);
    }
    const shown = [
      'pre-auth login',
      're-auth token now',
      'non-secret value',
      'use pre-token flow',
      'Bearer Authentication',
      'Using Bearer authentication.',
      'Bearer authentication, then',
      'bearer instrument',
      'Bearer Token',
      'bearer bonds',
      'Cookie:',
    ];
    for (const text of shown) {
      expect(hasSecretShape(text)).toBe(false);
      expect(cleanStepLabel(text)).toBe(text);
    }
  });

  it('says nothing when there is nothing', () => {
    expect(cleanStepLabel(null)).toBeNull();
    expect(cleanStepLabel(undefined)).toBeNull();
    expect(cleanStepLabel('   \n ')).toBeNull();
  });
});
