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

  it('says nothing when there is nothing', () => {
    expect(cleanStepLabel(null)).toBeNull();
    expect(cleanStepLabel(undefined)).toBeNull();
    expect(cleanStepLabel('   \n ')).toBeNull();
  });
});
