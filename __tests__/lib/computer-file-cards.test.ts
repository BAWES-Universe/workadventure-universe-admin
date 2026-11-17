/**
 * The file card, the parts that need no database: how a kept file is sealed, which files a job hands over, and how one is read off a machine.
 * The reading runs the real commands in a real shell against a real folder, so the checks that keep a link or a changing file from being handed over are the ones that run on a computer.
 */
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cardName, insideFolder, madeInJob, mimeOf, outputFolder, outputListCommand, pickFiles, PIECE_BYTES, pieceCommand, probeCommand, readFile, shellQuote, uniqueName } from '@/lib/computer-file-cards';
import type { FileEntry, FilesList } from '@/lib/computer-files';

const run = promisify(execFile);
process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);

describe('the name a result is kept under', () => {
  it('is the file’s own name when no other result of the job has it', () => {
    expect(uniqueName('report.pdf', new Set())).toBe('report.pdf');
    expect(uniqueName('report.pdf', new Set(['other.pdf']))).toBe('report.pdf');
  });
  it('gets a number before its ending when it is taken, and never repeats one', () => {
    expect(uniqueName('report.pdf', new Set(['report.pdf']))).toBe('report (2).pdf');
    expect(uniqueName('report.pdf', new Set(['report.pdf', 'report (2).pdf']))).toBe('report (3).pdf');
    expect(uniqueName('notes', new Set(['notes']))).toBe('notes (2)');
  });
  it('stays within what a result’s name may be, keeping the ending', () => {
    const long = `${'a'.repeat(115)}.xlsx`;
    const next = uniqueName(long, new Set([long]));
    expect(next.length).toBeLessThanOrEqual(120);
    expect(next.endsWith(' (2).xlsx')).toBe(true);
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
// What was on the machine before the job began: only so files saved elsewhere can be named (never handed over)
const BEFORE = listOf(entry('old.pdf', -30), entry('Documents/taxes-2025.pdf', -600), entry('.hermes/state.db', -2));
const LIMITS = { count: 5, bytes: 10_000 };
const none = () => false;
const JOB = 'job-1';
const FOLDER = outputFolder(JOB);
const mine = (name: string, minutes: number, bytes = 1000) => entry(`${FOLDER}/${name}`, minutes, bytes);

describe('which files a job hands over', () => {
  it('is the job’s own output folder: the folder is the proof, so nothing depends on when a file was touched', () => {
    expect(FOLDER).toBe('Outputs/job-1');
    const list = listOf(mine('c.pdf', 9), mine('b.pdf', 5), mine('a.pdf', 2));
    expect(pickFiles(list, FOLDER, LIMITS, none).map((pick) => pick.name)).toEqual(['c.pdf', 'b.pdf', 'a.pdf']);
    expect(pickFiles(list, FOLDER, { count: 2, bytes: 10_000 }, none).map((pick) => pick.name)).toEqual(['c.pdf', 'b.pdf']);
    expect(pickFiles(list, FOLDER, { count: 0, bytes: 10_000 }, none)).toEqual([]);
  });
  it('never takes a file outside the folder, however new, nor another job’s folder, nor one that only looks like it', () => {
    const list = listOf(
      entry('just-made.pdf', 9),
      entry('Documents/new-taxes.pdf', 9),
      entry('Outputs/job-2/theirs.pdf', 9),
      entry('Outputs/job-10/theirs.pdf', 9),
      entry('Outputs/job-1-copy/x.pdf', 9),
      entry('Outputs/job-1', 9),
      mine('ok.pdf', 1)
    );
    expect(pickFiles(list, FOLDER, LIMITS, none).map((pick) => pick.entry.path)).toEqual([`${FOLDER}/ok.pdf`]);
  });
  it('takes nothing with a way out of the folder, an empty part or a hidden part', () => {
    expect(insideFolder(`${FOLDER}/a.pdf`, FOLDER)).toBe(true);
    expect(insideFolder(`${FOLDER}/sub/a.pdf`, FOLDER)).toBe(true);
    for (const bad of [`${FOLDER}/../secret.pdf`, `${FOLDER}/./a.pdf`, `${FOLDER}//a.pdf`, `${FOLDER}/.hidden/a.pdf`, `${FOLDER}/.a.pdf`, `${FOLDER}/`, FOLDER, 'Outputs/job-1x/a.pdf', '../Outputs/job-1/a.pdf']) {
      expect(insideFolder(bad, FOLDER)).toBe(false);
    }
  });
  it('leaves out empty files and files over the size', () => {
    const list = listOf(mine('empty.txt', 5, 0), mine('big.zip', 5, 10_001), mine('fine.pdf', 5, 10_000));
    expect(pickFiles(list, FOLDER, LIMITS, none).map((pick) => pick.name)).toEqual(['fine.pdf']);
  });
  it('leaves out what was handed over before', () => {
    const list = listOf(mine('a.pdf', 5), mine('b.pdf', 6));
    expect(pickFiles(list, FOLDER, LIMITS, (one) => one.path.endsWith('/a.pdf')).map((pick) => pick.name)).toEqual(['b.pdf']);
  });
  it('hands over nothing when there is no list', () => {
    expect(pickFiles(null, FOLDER, LIMITS, none)).toEqual([]);
  });
  it('is not given a file just because a job running beside it touched the machine at the same time: each job has its own folder', () => {
    const list = listOf(mine('mine.pdf', 5), entry('Outputs/job-2/other.pdf', 5));
    expect(pickFiles(list, FOLDER, LIMITS, none).map((pick) => pick.name)).toEqual(['mine.pdf']);
    expect(pickFiles(list, outputFolder('job-2'), LIMITS, none).map((pick) => pick.name)).toEqual(['other.pdf']);
  });
});

describe('what a job saved elsewhere, only named', () => {
  it('is the files on the end list whose path was not on the list from before: by path alone, never by when they were touched', () => {
    const end = listOf(entry('a.pdf', 5), entry('old.pdf', -30), entry('touched-since.pdf', 8));
    const before = listOf(entry('old.pdf', -30), entry('touched-since.pdf', -20));
    expect(madeInJob(end, before).map((one) => one.path)).toEqual(['a.pdf']);
  });
  it('is nothing without both lists', () => {
    expect(madeInJob(null, listOf())).toEqual([]);
    expect(madeInJob(listOf(entry('a.pdf', 1)), null)).toEqual([]);
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

  it('lists only the job’s own folder, plain files only: no link, no hidden folder, nothing of another job, and nothing when there is no folder', async () => {
    mkdirSync(join(home, 'Outputs/job-1/sub'), { recursive: true });
    mkdirSync(join(home, 'Outputs/job-1/.cache'), { recursive: true });
    mkdirSync(join(home, 'Outputs/job-2'), { recursive: true });
    writeFileSync(join(home, 'Outputs/job-1/a.pdf'), 'a');
    writeFileSync(join(home, 'Outputs/job-1/sub/b.pdf'), 'bb');
    writeFileSync(join(home, 'Outputs/job-1/.cache/c.pdf'), 'c');
    writeFileSync(join(home, 'Outputs/job-2/other.pdf'), 'o');
    writeFileSync(join(home, 'elsewhere.pdf'), 'e');
    symlinkSync('/etc/passwd', join(home, 'Outputs/job-1/passwd.pdf'));
    const listed = await machine.exec('ref', outputListCommand('job-1'));
    expect(listed.exitCode).toBe(0);
    const paths = listed.stdout.trim().split('\n').map((line) => line.split('\t')[2]).sort();
    expect(paths).toEqual(['Outputs/job-1/a.pdf', 'Outputs/job-1/sub/b.pdf']);
    // A job with no folder has made nothing to hand over
    expect((await machine.exec('ref', outputListCommand('job-9'))).stdout).toBe('');
    // A folder that is a link to somewhere else is not listed
    symlinkSync(join(home, 'Documents'), join(home, 'Outputs/job-3'));
    writeFileSync(join(home, 'Documents/secret.pdf'), 's');
    expect((await machine.exec('ref', outputListCommand('job-3'))).stdout).toBe('');
  });

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
