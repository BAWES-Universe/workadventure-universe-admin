/**
 * The file card, the parts that need no database: how a kept file is sealed, which files a job hands over, and how one is read off a machine.
 * The reading runs the real commands in a real shell against a real folder, so the checks that keep a link or a changing file from being handed over are the ones that run on a computer.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cardKey, cardName, mimeOf, openCard, pickFiles, PIECE_BYTES, pieceCommand, probeCommand, readFile, sealCard, shellQuote } from '@/lib/computer-file-cards';
import type { FileEntry, FilesList } from '@/lib/computer-files';

const run = promisify(execFile);
process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);

describe('a kept file', () => {
  const key = cardKey('bot-1', 'file-1');
  it('is sealed so only Universe can open it, and only under its own name', () => {
    const data = Buffer.from('passport scan'.repeat(1000));
    const sealed = sealCard(key, data);
    expect(sealed.includes(Buffer.from('passport'))).toBe(false);
    expect(openCard(key, sealed).equals(data)).toBe(true);
    // Another copy's name, a changed byte and a cut-short copy are all refused
    expect(() => openCard(cardKey('bot-1', 'file-2'), sealed)).toThrow();
    const changed = Buffer.from(sealed);
    changed[20] ^= 1;
    expect(() => openCard(key, changed)).toThrow();
    expect(() => openCard(key, sealed.subarray(0, sealed.length - 3))).toThrow();
    expect(() => openCard(key, Buffer.from('nonsense'))).toThrow();
  });
  it('is sealed differently each time', () => {
    expect(sealCard(key, Buffer.from('same')).equals(sealCard(key, Buffer.from('same')))).toBe(false);
  });
  it('can be empty bytes', () => {
    expect(openCard(key, sealCard(key, Buffer.alloc(0))).length).toBe(0);
  });
});

describe('the name and type of a card', () => {
  it('shows the file’s own name, nothing that is a folder or a trick', () => {
    expect(cardName('Documents/visa_receipt (1).pdf')).toBe('visa_receipt (1).pdf');
    expect(cardName('a/b/c.txt')).toBe('c.txt');
    expect(cardName('x‮fdp.exe')).toBe('x fdp.exe');
    expect(cardName('line\nbreak.txt')).toBe('line break.txt');
    expect(cardName('')).toBe('file');
    expect(cardName('..')).toBe('file');
  });
  it('cuts a long name and keeps its ending', () => {
    const name = cardName(`${'long'.repeat(60)}.pdf`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith('….pdf')).toBe(true);
  });
  it('says what a file is from its ending, and never lets a page or a script be opened as one', () => {
    expect(mimeOf('visa-receipt.PDF')).toBe('application/pdf');
    expect(mimeOf('photo.jpeg')).toBe('image/jpeg');
    expect(mimeOf('page.html')).toBe('application/octet-stream');
    expect(mimeOf('run.sh')).toBe('application/octet-stream');
    expect(mimeOf('noending')).toBe('application/octet-stream');
    expect(mimeOf('.hidden')).toBe('application/octet-stream');
  });
});

const T = (minutes: number) => new Date(Date.UTC(2026, 10, 17, 12, 0) + minutes * 60_000).toISOString();
const entry = (path: string, minutes: number, bytes = 1000): FileEntry => ({ path, bytes, modifiedAt: T(minutes) });
const listOf = (...items: FileEntry[]): FilesList => ({ items, more: false, listedAt: T(30) });
const JOB = { startedAt: new Date(T(0)), endedAt: new Date(T(10)) };
const LIMITS = { count: 5, bytes: 10_000 };
const none = () => false;

describe('which files a job hands over', () => {
  it('takes the ones made in the job’s time, newest first, as many as Limits say', () => {
    const list = listOf(entry('c.pdf', 9), entry('b.pdf', 5), entry('a.pdf', 2));
    expect(pickFiles(list, JOB, LIMITS, none).map((pick) => pick.name)).toEqual(['c.pdf', 'b.pdf', 'a.pdf']);
    expect(pickFiles(list, JOB, { count: 2, bytes: 10_000 }, none).map((pick) => pick.name)).toEqual(['c.pdf', 'b.pdf']);
    expect(pickFiles(list, JOB, { count: 0, bytes: 10_000 }, none)).toEqual([]);
  });
  it('leaves out old files, files made after the job, hidden folders, empty files and files over the size', () => {
    const list = listOf(
      entry('late.pdf', 40),
      entry('.hermes/state.db', 5),
      entry('docs/.cache/x.pdf', 5),
      entry('empty.txt', 5, 0),
      entry('big.zip', 5, 10_001),
      entry('old.pdf', -30),
      entry('fine.pdf', 5, 10_000)
    );
    expect(pickFiles(list, JOB, LIMITS, none).map((pick) => pick.name)).toEqual(['fine.pdf']);
  });
  it('gives a minute either side for the machine’s clock', () => {
    const list = listOf(entry('before.pdf', -0.5), entry('after.pdf', 10.5), entry('toofar.pdf', 11.5));
    expect(pickFiles(list, JOB, LIMITS, none).map((pick) => pick.name).sort()).toEqual(['after.pdf', 'before.pdf']);
  });
  it('leaves out what an earlier job handed over', () => {
    const list = listOf(entry('a.pdf', 5), entry('b.pdf', 6));
    expect(pickFiles(list, JOB, LIMITS, (one) => one.path === 'a.pdf').map((pick) => pick.name)).toEqual(['b.pdf']);
  });
  it('hands over nothing for a job that did not start or a list that is not there', () => {
    expect(pickFiles(null, JOB, LIMITS, none)).toEqual([]);
    expect(pickFiles(listOf(entry('a.pdf', 5)), { startedAt: null, endedAt: null }, LIMITS, none)).toEqual([]);
  });
});

describe('reading a file off a machine', () => {
  let home: string;
  const commands: string[] = [];
  // The machine: every command runs in a real shell with this folder as its home folder
  const machine = {
    async exec(_ref: string, command: string, _options?: { timeoutMs?: number }) {
      commands.push(command);
      try {
        const { stdout } = await run('sh', ['-c', command], { env: { ...process.env, HOME: home }, maxBuffer: 5_000_000 });
        return { exitCode: 0, stdout, stderr: '', truncated: stdout.length > 512 * 1024 };
      } catch (error) {
        const failed = error as { code?: number; stdout?: string };
        return { exitCode: typeof failed.code === 'number' ? failed.code : 1, stdout: failed.stdout ?? '', stderr: '', truncated: false };
      }
    },
  };
  const modified = (path: string): FileEntry => {
    const stat = statSync(join(home, path));
    return { path, bytes: stat.size, modifiedAt: new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toISOString() };
  };
  const later = () => Date.now() + 60_000;

  beforeEach(() => {
    commands.length = 0;
    home = mkdtempSync(join(tmpdir(), 'brick-home-'));
    mkdirSync(join(home, 'Documents'));
    mkdirSync(join(home, '.hermes'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('reads a small file whole', async () => {
    writeFileSync(join(home, 'Documents/visa-receipt.pdf'), Buffer.from('%PDF-1.4 the receipt'));
    const data = await readFile(machine, 'ref', modified('Documents/visa-receipt.pdf'), later());
    expect(data?.toString()).toBe('%PDF-1.4 the receipt');
  });

  it('reads a file that is more than one piece, byte for byte', async () => {
    const bytes = Buffer.alloc(PIECE_BYTES * 2 + 12_345);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
    writeFileSync(join(home, 'Documents/big.bin'), bytes);
    const data = await readFile(machine, 'ref', modified('Documents/big.bin'), later());
    expect(data?.equals(bytes)).toBe(true);
    // A piece fits in the answer a machine can give (512 KB)
    expect(Math.ceil((PIECE_BYTES * 4) / 3)).toBeLessThan(512 * 1024);
  });

  it('reads names with spaces, quotes and dollar signs as names, never as commands', async () => {
    const odd = "Documents/it's a $(touch pwned) `x` ; name.txt";
    writeFileSync(join(home, odd), 'hello');
    const data = await readFile(machine, 'ref', modified(odd), later());
    expect(data?.toString()).toBe('hello');
    expect(existsSync(join(home, 'pwned'))).toBe(false);
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it('refuses a file that is a link, even to a file inside the home folder', async () => {
    writeFileSync(join(home, '.hermes/.env'), 'API_KEY=secret');
    symlinkSync(join(home, '.hermes/.env'), join(home, 'Documents/receipt.pdf'));
    // The list says exactly the size and time of what the link points to, so only the link check can refuse it
    const entryOfLink: FileEntry = { ...modified('.hermes/.env'), path: 'Documents/receipt.pdf' };
    expect(await readFile(machine, 'ref', entryOfLink, later())).toBeNull();
    // The check itself refuses it (not the size or time that differ for a link): exit 4, and nothing is printed
    expect(await machine.exec('ref', probeCommand('Documents/receipt.pdf'))).toMatchObject({ exitCode: 4, stdout: '' });
    expect(await machine.exec('ref', pieceCommand('Documents/receipt.pdf', 0, 100))).toMatchObject({ exitCode: 4, stdout: '' });
  });

  it('refuses a file in a folder that is a link to somewhere else', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'brick-outside-'));
    try {
      writeFileSync(join(outside, 'passwd.txt'), 'root:x');
      symlinkSync(outside, join(home, 'shared'));
      const stat = statSync(join(outside, 'passwd.txt'));
      const fake: FileEntry = { path: 'shared/passwd.txt', bytes: stat.size, modifiedAt: new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toISOString() };
      expect(await readFile(machine, 'ref', fake, later())).toBeNull();
      expect(await machine.exec('ref', pieceCommand('shared/passwd.txt', 0, 100))).toMatchObject({ exitCode: 5, stdout: '' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a file that is not what the list said (its size or time changed)', async () => {
    writeFileSync(join(home, 'Documents/a.txt'), 'one');
    const listed = modified('Documents/a.txt');
    expect(await readFile(machine, 'ref', { ...listed, bytes: listed.bytes + 1 }, later())).toBeNull();
    expect(await readFile(machine, 'ref', { ...listed, modifiedAt: T(1) }, later())).toBeNull();
  });

  it('refuses a file that changes while it is read, and never returns part of one', async () => {
    const bytes = Buffer.alloc(PIECE_BYTES + 10, 7);
    writeFileSync(join(home, 'Documents/live.bin'), bytes);
    utimesSync(join(home, 'Documents/live.bin'), new Date('2026-11-17T12:05:00Z'), new Date('2026-11-17T12:05:00Z'));
    const listed = modified('Documents/live.bin');
    let pieces = 0;
    const changing = {
      async exec(ref: string, command: string, options?: { timeoutMs?: number }) {
        // After the first piece is read the file grows (an agent still writing it)
        if (command.includes('tail -c') && ++pieces === 1) appendFileSync(join(home, 'Documents/live.bin'), 'more');
        return machine.exec(ref, command, options);
      },
    };
    expect(await readFile(changing, 'ref', listed, later())).toBeNull();
  });

  it('gives up when the time is up, and when the machine does not answer', async () => {
    writeFileSync(join(home, 'Documents/a.txt'), 'x'.repeat(10));
    expect(await readFile(machine, 'ref', modified('Documents/a.txt'), Date.now() - 1, () => Date.now())).toBeNull();
    const silent = { exec: async () => ({ exitCode: -1, stdout: '', stderr: '', truncated: false }) };
    expect(await readFile(silent, 'ref', modified('Documents/a.txt'), later())).toBeNull();
    const cut = { exec: async () => ({ exitCode: 0, stdout: '12 1', stderr: '', truncated: true }) };
    expect(await readFile(cut, 'ref', modified('Documents/a.txt'), later())).toBeNull();
  });

  it('asks nothing of the machine but plain reads', () => {
    const command = `${probeCommand('Documents/a.txt')}\n${pieceCommand('Documents/a.txt', 600_000, 300_000)}`;
    expect(command).not.toMatch(/\b(rm|mv|cp|chmod|curl|wget|kill|sudo)\b/);
    expect(pieceCommand('Documents/a.txt', 600_000, 300_000)).toContain('tail -c +600001');
  });
});
