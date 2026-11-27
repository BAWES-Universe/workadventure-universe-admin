/**
 * The record of where a computer's browser went (R06): the image's `universe-visits`, run for real against a pretend browser that speaks the
 * DevTools protocol over a real WebSocket. What it must keep (host and path of each page and each post), what it must never keep (a query
 * string, a fragment, a sign-in name in the address, a header, a body), and what it says about itself (when it was connected, whether it is
 * running). The listener was also run against a real Chromium by hand (see the pull request); a browser cannot be a test dependency here.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('@/lib/db', () => ({ prisma: {} }));

import { imageFiles } from '@/lib/agent37/image-files';
import { cleanHost, cleanPath, parseReadBack, type VisitLine } from '@/lib/computer-visits';

const hasPython = spawnSync('sh', ['-c', 'command -v python3']).status === 0;
const python = hasPython ? it : it.skip;
const folder = mkdtempSync(join(tmpdir(), 'universe-visits-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const script = join(folder, 'universe-visits');
writeFileSync(script, imageFiles().find((file) => file.name === 'universe-visits')!.text, { mode: 0o755 });

/** A WebSocket server that is as much of one as DevTools needs: the handshake, text messages in (masked) and out. */
function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : payload.length < 65536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]) : null;
  if (!head) throw new Error('too long for this test');
  return Buffer.concat([head, payload]);
}

function* messagesOf(state: { buffer: Buffer }): Generator<string> {
  for (;;) {
    const b = state.buffer;
    if (b.length < 2) return;
    let size = b[1] & 0x7f;
    let at = 2;
    if (size === 126) {
      if (b.length < 4) return;
      size = b.readUInt16BE(2);
      at = 4;
    }
    const masked = (b[1] & 0x80) !== 0;
    if (b.length < at + (masked ? 4 : 0) + size) return;
    const mask = masked ? b.subarray(at, at + 4) : null;
    const payload = Buffer.from(b.subarray(at + (masked ? 4 : 0), at + (masked ? 4 : 0) + size));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    state.buffer = b.subarray(at + (masked ? 4 : 0) + size);
    if ((b[0] & 0x0f) === 1) yield payload.toString();
  }
}

interface Pretend {
  server: Server;
  port: number;
  sockets: Socket[];
  connections: number;
  /** What to say once the listener has attached to the page (and let it go), through a socket. */
  script: (say: (message: unknown) => void) => void;
  /** Keeps the first connection open after the page has done its things (a browser that is still there). */
  hold: boolean;
  /** The page has done its things. */
  done: Promise<void>;
  close: () => void;
}

async function pretendBrowser(script: Pretend['script'], hold = false): Promise<Pretend> {
  const pretend = { sockets: [], connections: 0, script, hold } as unknown as Pretend;
  let finish: () => void = () => undefined;
  pretend.done = new Promise<void>((resolve) => (finish = resolve));
  pretend.server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${pretend.port}/devtools/browser/abc` }));
  });
  pretend.server.on('upgrade', (req, socket: Socket) => {
    pretend.sockets.push(socket);
    const first = pretend.connections++ === 0;
    const key = String(req.headers['sec-websocket-key']);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')}\r\n\r\n`);
    const say = (message: unknown) => socket.write(frame(JSON.stringify(message)));
    const state = { buffer: Buffer.alloc(0) };
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      for (const text of messagesOf(state)) {
        const message = JSON.parse(text) as { id: number; method: string; sessionId?: string };
        say({ id: message.id, result: message.method === 'Target.getTargets' ? { targetInfos: [] } : {} });
        if (message.method === 'Target.setAutoAttach' && !message.sessionId && first) {
          say({ method: 'Target.attachedToTarget', params: { sessionId: 'S-PAGE', waitingForDebugger: true, targetInfo: { targetId: 'T1', type: 'page' } } });
          say({ method: 'Target.attachedToTarget', params: { sessionId: 'S-FRAME', waitingForDebugger: true, targetInfo: { targetId: 'T2', type: 'iframe' } } });
        }
        // The listener lets the page go last, so everything it asked for is in place: the pretend page now does its things
        if (message.method === 'Runtime.runIfWaitingForDebugger' && message.sessionId === 'S-PAGE' && first) {
          pretend.script(say);
          finish();
          if (!pretend.hold) setTimeout(() => socket.end(), 300);
        }
      }
    });
  });
  await new Promise<void>((resolve) => pretend.server.listen(0, '127.0.0.1', resolve));
  pretend.port = (pretend.server.address() as { port: number }).port;
  pretend.close = () => {
    for (const socket of pretend.sockets) socket.destroy();
    pretend.server.close();
  };
  return pretend;
}

const until = async (check: () => boolean, ms = 12_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const readBack = (home: string, since = 0) => {
  const run = spawnSync('python3', [script, 'read', String(since)], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  expect(run.status).toBe(0);
  return run.stdout;
};

describe('the record of where the browser went (the listener on the computer)', () => {
  let listener: ChildProcess | null = null;
  afterEach(() => {
    listener?.kill('SIGKILL');
    listener = null;
  });

  python('keeps host and path of each page and each post, and nothing else of them', async () => {
    const home = mkdtempSync(join(folder, 'home-'));
    const pretend = await pretendBrowser((say) => {
      const page = { sessionId: 'S-PAGE' };
      const frameNavigated = (frame: object) => say({ method: 'Page.frameNavigated', sessionId: 'S-PAGE', params: { frame } });
      const post = (url: string, method: string, type: string, session = 'S-PAGE') =>
        say({ method: 'Network.requestWillBeSent', sessionId: session, params: { requestId: 'r', type, request: { url, method, postData: 'card=4242&secretbody=1', headers: { Cookie: 'sid=secretcookie' } } } });
      void page;
      // A page, with a sign-in name, an upper case host, the scheme's own port, a query string and a fragment
      frameNavigated({ id: 'F1', url: 'https://user:hunter2@Shop.Example:443/cart/?item=1&token=abc#top' });
      // A frame inside it is not where the browser went
      frameNavigated({ id: 'F2', parentId: 'F1', url: 'https://ads.example/inside' });
      // The page's own form, twice in a row, with a private link in its path
      post('https://shop.example/checkout/AbCdEfGhIjKlMnOpQrStUvWx12345/pay?card=4242#x', 'POST', 'Document');
      post('https://shop.example/checkout/AbCdEfGhIjKlMnOpQrStUvWx12345/pay?card=4242#x', 'POST', 'Document');
      // Reading is not a post, and neither is a browser's own question
      post('https://shop.example/read?x=1', 'GET', 'Document');
      post('https://shop.example/read', 'OPTIONS', 'Fetch');
      // A script's post, on another port; a post from a frame in another process; one to an address that is not a web page
      post('https://api.shop.example:8443/track?id=77', 'PUT', 'Fetch');
      post('https://pay.example/frame/step', 'POST', 'XHR', 'S-FRAME');
      post('http://[::1]:3000/local', 'DELETE', 'Fetch');
      post('wss://socket.example/live', 'POST', 'Other');
      // The page moves without loading, a frame we do not know of moves, and a page that did not load
      say({ method: 'Page.navigatedWithinDocument', sessionId: 'S-PAGE', params: { frameId: 'F1', url: 'https://shop.example/cart/confirm?ok=1#done' } });
      say({ method: 'Page.navigatedWithinDocument', sessionId: 'S-PAGE', params: { frameId: 'F9', url: 'https://elsewhere.example/hidden' } });
      say({ method: 'Page.frameNavigated', sessionId: 'S-FRAME', params: { frame: { id: 'F3', url: 'https://pay.example/frame' } } });
      frameNavigated({ id: 'F1', url: 'chrome-error://chromewebdata/', unreachableUrl: 'https://down.example/page?x=1' });
      frameNavigated({ id: 'F1', url: 'about:blank' });
      frameNavigated({ id: 'F1', url: 'data:text/html,secret' });
    });
    try {
      listener = spawn('python3', [script, 'run'], { env: { ...process.env, HOME: home, UNIVERSE_DEVTOOLS_PORT: String(pretend.port) }, stdio: 'ignore' });
      const log = join(home, '.universe', 'visits.jsonl');
      // The pretend browser closes after its page is done: the listener writes what it held and says the connection ended
      await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('"k":"off"'));
      listener.kill('SIGKILL');
      const raw = readFileSync(log, 'utf8');
      for (const secret of ['hunter2', 'user:', 'item=1', 'token=abc', '#top', 'card=4242', '4242', 'secretbody', 'secretcookie', 'AbCdEfGhIjKlMnOpQrStUvWx12345', 'id=77', 'x=1', 'ok=1', '#done', 'secret', 'hidden', 'ads.example', 'socket.example']) {
        expect(raw).not.toContain(secret);
      }
      const back = parseReadBack(readBack(home));
      const visits = back.lines.filter((line): line is VisitLine => line.kind === 'visit' || line.kind === 'post');
      expect(visits.map((line) => [line.kind, line.method, line.host, line.path, line.count, line.form, line.failed])).toEqual([
        ['visit', 'GET', 'shop.example', '/cart/', 1, false, false],
        ['post', 'POST', 'shop.example', '/checkout/…/pay', 2, true, false],
        ['post', 'PUT', 'api.shop.example:8443', '/track', 1, false, false],
        ['post', 'POST', 'pay.example', '/frame/step', 1, false, false],
        ['post', 'DELETE', '[::1]:3000', '/local', 1, false, false],
        ['visit', 'GET', 'shop.example', '/cart/confirm', 1, false, false],
        ['visit', 'GET', 'down.example', '/page', 1, false, true],
      ]);
      // It says it was connected, and that the connection ended
      expect(back.lines.filter((line) => line.kind === 'on' || line.kind === 'off').map((line) => line.kind)).toEqual(['on', 'off']);
      expect(back.ended).toBe(true);
      expect(back.now).toBeGreaterThan(Date.now() - 60_000);
    } finally {
      pretend.close();
    }
  }, 30_000);

  python('puts the last seconds before a read in the read, while the browser is still connected', async () => {
    const home = mkdtempSync(join(folder, 'home-'));
    const pretend = await pretendBrowser((say) => {
      say({ method: 'Page.frameNavigated', sessionId: 'S-PAGE', params: { frame: { id: 'F1', url: 'https://last.example/just-now' } } });
      say({ method: 'Network.requestWillBeSent', sessionId: 'S-PAGE', params: { type: 'Document', request: { url: 'https://last.example/send?x=1', method: 'POST' } } });
    }, true);
    try {
      listener = spawn('python3', [script, 'run'], { env: { ...process.env, HOME: home, UNIVERSE_DEVTOOLS_PORT: String(pretend.port) }, stdio: 'ignore' });
      await pretend.done;
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Not yet 3 seconds quiet, so the listener still holds the last line in memory; the read asks it to write it out first
      const back = parseReadBack(readBack(home));
      expect(back.alive).toBe(true);
      expect(back.lines.filter((line): line is VisitLine => line.kind === 'visit' || line.kind === 'post').map((line) => [line.kind, line.path])).toEqual([
        ['visit', '/just-now'],
        ['post', '/send'],
      ]);
      // and the listener goes on: a second read finds the same, not twice
      expect(parseReadBack(readBack(home)).lines.filter((line) => line.kind === 'post')).toHaveLength(1);
    } finally {
      pretend.close();
    }
  }, 30_000);

  python('connects again when the browser comes back, and says when it was away', async () => {
    const home = mkdtempSync(join(folder, 'home-'));
    const pretend = await pretendBrowser((say) => say({ method: 'Page.frameNavigated', sessionId: 'S-PAGE', params: { frame: { id: 'F1', url: 'https://one.example/a' } } }));
    try {
      listener = spawn('python3', [script, 'run'], { env: { ...process.env, HOME: home, UNIVERSE_DEVTOOLS_PORT: String(pretend.port) }, stdio: 'ignore' });
      const log = join(home, '.universe', 'visits.jsonl');
      await until(() => existsSync(log) && (readFileSync(log, 'utf8').match(/"k":"on"/g) ?? []).length >= 2);
      const kinds = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).k);
      expect(kinds).toEqual(['on', 'visit', 'off', 'on']);
      // The browser (its DevTools address) still answered when the connection went: nobody was watching it for that stretch
      const lines = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.find((entry) => entry.k === 'off').b).toBe(1);
      expect(parseReadBack(readBack(home)).lines.find((entry) => entry.kind === 'off')).toMatchObject({ kind: 'off', open: true });
      // From a moment after everything: the last thing it said about the connection is that it is on, and the listener runs
      const out = readBack(home, Date.now() + 60_000);
      expect(out).toContain('state=on');
      expect(out).toContain('alive=1');
      expect(out).not.toContain('line=');
      listener.kill('SIGKILL');
      // Asked until it says so (a fixed wait was too short when the machine running the tests is busy)
      await until(() => readBack(home).includes('alive=0'));
      expect(readBack(home)).toContain('alive=0');
    } finally {
      pretend.close();
    }
  }, 30_000);

  python('says the browser itself was gone when it is not there to answer, so nothing could have been opened', async () => {
    const home = mkdtempSync(join(folder, 'home-'));
    const pretend = await pretendBrowser((say) => say({ method: 'Page.frameNavigated', sessionId: 'S-PAGE', params: { frame: { id: 'F1', url: 'https://one.example/a' } } }), true);
    try {
      listener = spawn('python3', [script, 'run'], { env: { ...process.env, HOME: home, UNIVERSE_DEVTOOLS_PORT: String(pretend.port) }, stdio: 'ignore' });
      await pretend.done;
      pretend.close();
      const log = join(home, '.universe', 'visits.jsonl');
      await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('"k":"off"'));
      const off = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((entry) => entry.k === 'off');
      expect(off.b).toBe(0);
      const back = parseReadBack(readBack(home));
      expect(back.lines.find((entry) => entry.kind === 'off')).toMatchObject({ kind: 'off', open: false });
      expect(parseReadBack(readBack(home, Date.now() + 60_000))).toMatchObject({ state: 'off', stateOpen: false });
    } finally {
      pretend.close();
    }
  }, 30_000);

  python('keeps the file small: older lines go, and a cut line says so, keeping the last connection line', () => {
    const home = mkdtempSync(join(folder, 'home-'));
    mkdirSync(join(home, '.universe'), { recursive: true });
    const lines = [JSON.stringify({ k: 'on', at: 1 })];
    for (let i = 0; i < 9000; i++) lines.push(JSON.stringify({ k: 'post', at: 1000 + i, m: 'POST', h: 'busy.example', p: `/p/${i}`, n: 1 }));
    writeFileSync(join(home, '.universe', 'visits.jsonl'), lines.join('\n') + '\n');
    // The listener's own writer does the cut: load it and write one more line
    const run = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("uv", sys.argv[1])
spec = importlib.util.spec_from_loader("uv", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)
mod.Log().write({"k": "post", "at": 99999, "m": "POST", "h": "busy.example", "p": "/last", "n": 1})`,
        script,
      ],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    const kept = readFileSync(join(home, '.universe', 'visits.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(kept.length).toBeLessThan(1700);
    expect(kept[0].k).toBe('cut');
    expect(kept.some((entry) => entry.k === 'on')).toBe(true);
    expect(kept.at(-1).p).toBe('/last');
  });

  python('cuts an address the same way the reading side does, so nothing the listener keeps is cut again differently', () => {
    const urls = [
      'https://Example.com/a/b?x=1#y',
      'http://example.com:80/plain',
      'https://example.com:443/',
      'https://example.com:8443/AbCd1234EfGh5678IjKl9012MnOp/reset',
      'https://example.com/share/550e8400-e29b-41d4-a716-446655440000',
      'https://example.com/files/v1-3fa9c2d41b7e8a905c6d1e2f/download',
      'https://example.com/af/AbCdEfGhIjKlMnOpQrStUvWxYz',
      'https://example.com/t/abcdefghijklmnop0123456789ab',
      'https://example.com/how-to-apply-for-a-visa-in-2026-step-by-step',
      'https://example.com/%E2%9C%93/path',
      // the same codes written with percent signs, twice over, or behind an encoded slash, are cut like the plain ones
      'https://example.com/reset/%41bCdEfGhIjKlMnOpQrStUvWxYz',
      'https://example.com/reset/%2541bCdEfGhIjKlMnOpQrStUvWxYz',
      'https://example.com/share/x%2F550e8400-e29b-41d4-a716-446655440000',
      'https://example.com/a%20readable%20part',
      'http://[2001:db8::1]:8080/x',
      'https://user:pw@example.com',
    ];
    const run = spawnSync(
      'python3',
      [
        '-c',
        `import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("uv", sys.argv[1])
spec = importlib.util.spec_from_loader("uv", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)
print(json.dumps([mod.cut(url) for url in json.loads(sys.argv[2])]))`,
        script,
        JSON.stringify(urls),
      ],
      { encoding: 'utf8' },
    );
    expect(run.status).toBe(0);
    const cut = JSON.parse(run.stdout) as Array<[string, string] | null>;
    expect(cut).toEqual([
      ['example.com', '/a/b'],
      ['example.com', '/plain'],
      ['example.com', '/'],
      ['example.com:8443', '/…/reset'],
      ['example.com', '/share/…'],
      ['example.com', '/files/\u2026/download'],
      ['example.com', '/af/\u2026'],
      ['example.com', '/t/\u2026'],
      ['example.com', '/how-to-apply-for-a-visa-in-2026-step-by-step'],
      ['example.com', '/%E2%9C%93/path'],
      ['example.com', '/reset/\u2026'],
      ['example.com', '/reset/\u2026'],
      ['example.com', '/share/\u2026'],
      ['example.com', '/a%20readable%20part'],
      ['[2001:db8::1]:8080', '/x'],
      ['example.com', '/'],
    ]);
    // Every one of them passes the reading side unchanged: the same host, and the same path
    for (const pair of cut) {
      expect(cleanHost(pair![0])).toBe(pair![0]);
      expect(cleanPath(pair![1])).toBe(pair![1]);
    }
  });
});
