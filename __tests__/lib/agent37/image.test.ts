/**
 * The image every Brick computer is made from: what is in it, that its scripts work (the model address and the take-over fence are run
 * for real here), and how Orbit builds it on Agent37 a step at a time. What cannot be run here (the screen, the browser, Hermes) is
 * proven on the first real machine.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';

jest.mock('@/lib/db', () => ({ prisma: {} }));

import { IMAGE_NAME, IMAGE_PORT, ensureImage, imageContext, tarOf, type ImageState, type ImageStore } from '@/lib/agent37/image';
import { DOCKERFILE, IMAGE_SETUP_VERSION, imageFiles, LOCAL_MODEL_PORT } from '@/lib/agent37/image-files';
import type { Agent37Client, TemplateBuild } from '@/lib/agent37/client';

const folder = mkdtempSync(join(tmpdir(), 'universe-image-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const have = (command: string) => spawnSync('sh', ['-c', `command -v ${command}`]).status === 0;
const hasPython = have('python3');
const python = hasPython ? it : it.skip;

const write = () => {
  const dir = join(folder, 'image');
  mkdirSync(dir, { recursive: true });
  for (const file of imageFiles()) writeFileSync(join(dir, file.name), file.text, { mode: file.mode });
  return dir;
};

describe('what is in the image', () => {
  it('builds on the base image, keeps its entrypoint, writes nothing into the masked home folder, and copies every file it has', () => {
    expect(DOCKERFILE.split('\n')[0]).toMatch(/^FROM ghcr\.io\/agent37-platform\/hermes-base:/);
    expect(DOCKERFILE).not.toMatch(/^\s*(ENTRYPOINT|CMD)\b/m);
    expect(DOCKERFILE).not.toContain('/home/node');
    expect(DOCKERFILE.trim().split('\n').at(-1)).toBe('USER node');
    expect(DOCKERFILE).toContain('BROWSER_CDP_URL=http://127.0.0.1:9222');
    for (const file of imageFiles().filter((entry) => entry.name !== 'Dockerfile')) {
      expect(DOCKERFILE).toContain(`/usr/local/bin/${file.name}`);
      expect(DOCKERFILE).toMatch(new RegExp(`COPY [^\\n]*\\b${file.name}\\b`));
    }
  });

  it('holds no key and no address of ours: the computer’s only credential is the job’s own, written when it runs', () => {
    for (const file of imageFiles()) expect(file.text).not.toMatch(/sk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9_-]{20,}|AGENT37_API_KEY/);
  });

  it('packs into a gzipped folder with the Dockerfile at its root, and the same files always give the same bytes', () => {
    const a = imageContext();
    const b = imageContext();
    expect(a.hash).toBe(b.hash);
    expect(a.gzipped.equals(b.gzipped)).toBe(true);
    const dir = join(folder, 'unpacked');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(folder, 'context.tgz'), a.gzipped);
    const unpacked = spawnSync('tar', ['-xzf', join(folder, 'context.tgz'), '-C', dir]);
    expect(unpacked.status).toBe(0);
    for (const file of imageFiles()) expect(readFileSync(join(dir, file.name), 'utf8')).toBe(file.text);
    expect(gunzipSync(a.gzipped).length % 512).toBe(0);
  });

  it('changes its hash when a file changes, so a new build starts by itself', () => {
    const files = imageFiles();
    const same = tarOf(files);
    const changed = tarOf(files.map((file) => (file.name === 'universe-up' ? { ...file, text: file.text + '\n# change' } : file)));
    expect(same.equals(changed)).toBe(false);
    expect(IMAGE_SETUP_VERSION).toBeTruthy();
  });

  python('has scripts that are well formed', () => {
    const dir = write();
    for (const name of ['universe-up', 'universe-supervise', 'universe-clean', 'universe-files', 'universe-mark']) expect(spawnSync('sh', ['-n', join(dir, name)]).status).toBe(0);
    for (const name of ['universe-proxy', 'universe-fence']) {
      const compiled = spawnSync('python3', ['-c', `import ast,sys;ast.parse(open(sys.argv[1]).read())`, join(dir, name)]);
      expect(compiled.status).toBe(0);
    }
  });

  it('lists the files a person would look for, newest first, without hidden folders or the tools’ own', () => {
    const dir = write();
    const home = mkdtempSync(join(tmpdir(), 'universe-home-'));
    mkdirSync(join(home, 'visa'), { recursive: true });
    mkdirSync(join(home, '.hidden'));
    mkdirSync(join(home, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(home, 'visa', 'form.pdf'), 'abc');
    writeFileSync(join(home, 'notes.txt'), 'hello world');
    writeFileSync(join(home, '.hidden', 'secret'), 'x');
    writeFileSync(join(home, 'node_modules', 'x', 'y.js'), 'x');
    utimesSync(join(home, 'notes.txt'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    const run = spawnSync('sh', [join(dir, 'universe-files')], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split('\n').map((line) => line.split('\t'));
    expect(lines.map((parts) => parts[2])).toEqual(['visa/form.pdf', 'notes.txt']);
    expect(lines.map((parts) => parts[0])).toEqual(['3', '11']);
    rmSync(home, { recursive: true, force: true });
  });

  it('writes Hermes’ config once, pointing only at the local model address, and says when Hermes must be restarted', () => {
    const up = imageFiles().find((file) => file.name === 'universe-up')!.text;
    expect(up).toContain(`base_url: http://127.0.0.1:${LOCAL_MODEL_PORT}/v1`);
    expect(up).toContain('api_mode: chat_completions');
    expect(up).toContain('restart=1');
    expect(up).toContain('ready=1');
    expect(up).toMatch(/ready=0 reason=(browser|model_address|screen)/);
  });

  it('keeps the restart pending until the machine has really restarted, whatever else fails in between', () => {
    const up = imageFiles().find((file) => file.name === 'universe-up')!.text;
    // The setup marker no longer stands for "restarted": the pending restart is its own marker, kept with the machine's first process
    expect(up).toContain('restart.pending');
    expect(up.indexOf('restart.pending')).toBeLessThan(up.indexOf('ready=0 reason=browser'));
    expect(up).toMatch(/echo "ready=1 restart=\$restart"/);
  });

  it('clears the browser under the same lock as the supervisor and proves it gone before the profile is removed', () => {
    const clean = imageFiles().find((file) => file.name === 'universe-clean')!.text;
    expect(clean).toContain('up.lock');
    expect(clean.indexOf('pgrep -x chromium')).toBeLessThan(clean.indexOf('rm -rf'));
    expect(clean.indexOf('rm -rf')).toBeLessThan(clean.indexOf('universe-up --child'));
  });
});

describe('what the scripts the fence keeps may run', () => {
  const script = (name: string) => imageFiles().find((file) => file.name === name)!.text;

  it('start from a fixed PATH, so a program the agent put first in its own PATH is never one the supervisor runs', () => {
    for (const name of ['universe-supervise', 'universe-up', 'universe-clean']) {
      const text = script(name);
      const line = text.split('\n').find((one) => one.startsWith('PATH='));
      expect(line).toBeDefined();
      // Whatever PATH the agent starts it with, `sleep` is the system's
      const run = spawnSync('sh', ['-c', `${line}; export PATH; command -v sleep`], { env: { ...process.env, PATH: `${folder}:/bin:/usr/bin`, HOME: folder }, encoding: 'utf8' });
      expect(run.stdout.trim()).toMatch(/^\/(usr\/)?bin\/sleep$/);
      // and it is set before the first program is run
      const first = Math.min(...['mkdir', 'sleep', 'pkill'].map((word) => text.indexOf(word)).filter((at) => at >= 0));
      expect(text.indexOf(line!)).toBeLessThan(first);
    }
  });

  it('keeps the restart pending when the machine’s first process cannot be read, until one can be told', () => {
    const up = script('universe-up');
    expect(up).toMatch(/if \[ -z "\$INIT" \]; then restart=1\n/);
    expect(up).not.toMatch(/-z "\$INIT" \]; then restart=1; rm -f/);
  });

  it('marks the profile before it is removed, unmarks it only when it is proved gone, and removes it before any job when the mark is left', () => {
    const clean = script('universe-clean');
    expect(clean.indexOf('profile.dirty')).toBeLessThan(clean.indexOf('pkill -x chromium'));
    expect(clean).toContain('reason=profile_not_removed');
    expect(clean.indexOf('reason=profile_not_removed')).toBeLessThan(clean.indexOf('rm -f "$STATE/profile.dirty"'));
    expect(clean.indexOf('rm -f "$STATE/profile.dirty"')).toBeLessThan(clean.indexOf('universe-up --child'));
    const up = script('universe-up');
    expect(up).toContain('reason=profile_not_cleared');
    // done before the browser is started
    expect(up.indexOf('profile.dirty')).toBeLessThan(up.indexOf('nohup setsid chromium'));
  });
});

describe('the local model address', () => {
  let relay: Server;
  let relayBase: string;
  const seen: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void;

  beforeAll(async () => {
    relay = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        handler(req, res);
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    relayBase = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => relay.close(() => resolve())));
  beforeEach(() => {
    seen.length = 0;
    handler = (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
  });

  async function withProxy(run: (base: string, home: string) => Promise<void>) {
    const dir = write();
    const home = mkdtempSync(join(folder, 'home-'));
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const child = spawn('python3', [join(dir, 'universe-proxy')], { env: { ...process.env, HOME: home, UNIVERSE_PROXY_PORT: String(port) }, stdio: 'ignore' });
    try {
      for (let tries = 0; tries < 50; tries++) {
        const up = await fetch(`http://127.0.0.1:${port}/v1/models`).then(() => true).catch(() => false);
        if (up) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await run(`http://127.0.0.1:${port}`, home);
    } finally {
      child.kill('SIGKILL');
    }
  }
  const setRelay = (home: string, token: string, path = '') => {
    mkdirSync(join(home, '.universe'), { recursive: true });
    writeFileSync(join(home, '.universe', 'relay.json'), JSON.stringify({ url: `${relayBase}${path}`, token }));
  };

  python('says there is no key yet, in the shape a client reads, until the job’s key is written', async () => {
    await withProxy(async (base) => {
      const answer = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
      expect(answer.status).toBe(503);
      expect((await answer.json()).error.code).toBe('no_relay');
      expect(seen).toHaveLength(0);
    });
  });

  python('passes a call on with the job’s key in place of whatever the caller sent, and reads the key again on the next call', async () => {
    await withProxy(async (base, home) => {
      setRelay(home, 'cjt_first', '/prefix');
      const call = () => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer universe-local' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
      expect((await (await call()).json()).ok).toBe(true);
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/prefix/v1/chat/completions', auth: 'Bearer cjt_first' });
      expect(JSON.parse(seen[0].body).messages[0].content).toBe('hi');
      // a new key is picked up with nothing restarted
      setRelay(home, 'cjt_second', '/prefix');
      await call();
      expect(seen[1].auth).toBe('Bearer cjt_second');
    });
  });

  python('passes the answer back as it comes, and the relay’s refusals as they are', async () => {
    await withProxy(async (base, home) => {
      setRelay(home, 'cjt_x');
      handler = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => {
          res.write('data: two\n\n');
          res.end();
        }, 300);
      };
      const answer = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
      const reader = answer.body!.getReader();
      const first = await reader.read();
      const at = Date.now();
      // the first part arrives before the relay has finished
      expect(new TextDecoder().decode(first.value)).toContain('data: one');
      let rest = '';
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        rest += new TextDecoder().decode(part.value);
      }
      expect(rest).toContain('data: two');
      expect(Date.now() - at).toBeGreaterThanOrEqual(150);

      handler = (_req, res) => res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'insufficient_quota' } }));
      const refused = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
      expect(refused.status).toBe(429);
      expect((await refused.json()).error.code).toBe('insufficient_quota');
    });
  });

  python('says the address could not be reached, never hangs or shows an address or key', async () => {
    await withProxy(async (base, home) => {
      mkdirSync(join(home, '.universe'), { recursive: true });
      writeFileSync(join(home, '.universe', 'relay.json'), JSON.stringify({ url: 'http://127.0.0.1:9', token: 'cjt_secret' }));
      const answer = await fetch(`${base}/v1/models`);
      expect(answer.status).toBe(502);
      const text = await answer.text();
      expect(text).toContain('upstream_unreachable');
      expect(text).not.toContain('cjt_secret');
      expect(text).not.toContain('127.0.0.1:9');
    });
  });
});

describe('the take-over fence', () => {
  // Run in a process space of its own, so only what the scenario starts can be touched
  const isolated = hasPython && spawnSync('unshare', ['--pid', '--fork', '--mount-proc', 'true']).status === 0;
  (isolated ? it : it.skip)('stops what the agent started, keeps the gateway and the browser, and proves none is left', () => {
    const dir = write();
    mkdirSync(join(dir, 'bin'), { recursive: true });
    // Two real libraries the agent could preload into a short wait. Each clears LD_PRELOAD from its own environment, then leaves a note
    // that it ran (so the test knows the code really loaded). The second also copies its code into nameless memory and unmaps itself.
    mkdirSync(join(dir, 'agent'), { recursive: true });
    const cleared = `
#define _GNU_SOURCE
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
extern char **environ;
static void clear_and_note(const char *note) {
  for (char **p = environ; *p; p++) if (!strncmp(*p, "LD_", 3)) memset(*p, 0, strlen(*p));
  int fd = open(note, O_WRONLY | O_CREAT, 0644);
  if (fd >= 0) { write(fd, "ran", 3); close(fd); }
}
`;
    writeFileSync(join(dir, 'agent', 'wipe.c'), `${cleared}
#include <stdlib.h>
__attribute__((constructor)) static void w(void) { const char *note = getenv("NOTE_FILE"); if (note) clear_and_note(note); }
`);
    writeFileSync(
      join(dir, 'agent', 'hide.c'),
      `${cleared}
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
__attribute__((naked, noinline)) static void stub(void *ranges, long count) {
  __asm__ volatile(
    "mov %rdi,%r8\\n mov %rsi,%r9\\n"
    "1: test %r9,%r9\\n jz 2f\\n mov (%r8),%rdi\\n mov 8(%r8),%rsi\\n mov $11,%eax\\n syscall\\n add $16,%r8\\n dec %r9\\n jmp 1b\\n"
    "2: mov $34,%eax\\n syscall\\n jmp 2b\\n");
}
__attribute__((constructor)) static void h(void) {
  uintptr_t ranges[64][2]; long count = 0; char line[4096];
  FILE *f = fopen("/proc/self/maps", "r");
  if (!f) _exit(101);
  while (fgets(line, sizeof(line), f)) {
    unsigned long a, b;
    if (strstr(line, "hide.so") && count < 64 && sscanf(line, "%lx-%lx", &a, &b) == 2) { ranges[count][0] = a; ranges[count][1] = b - a; count++; }
  }
  fclose(f);
  void *copy = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (copy == MAP_FAILED) _exit(103);
  memcpy(copy, (void *)stub, 256);
  if (mprotect(copy, 4096, PROT_READ | PROT_EXEC)) _exit(104);
  clear_and_note("${dir}/agent/hide.ran");
  ((void (*)(void *, long))copy)(ranges, count);
  _exit(105);
}
`,
    );
    const scenario = `
export HOME=${dir}/home
mkdir -p $HOME ${dir}/agent /run/universe
# the folder of the note is a private one here, so the real machine's is never touched
mount -t tmpfs tmpfs /run/universe
echo "unmarked: $(python3 ${dir}/universe-fence --check; echo rc=$?)"
cp /bin/sh ${dir}/bin/chromium
python3 -c "
import socket, subprocess, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('127.0.0.1', 3737)); s.listen()
subprocess.Popen(['sleep', '300'])
time.sleep(300)" &
GW=$!
# the real browser: a program root owns, started with the supervisor's own profile and debugging address
${dir}/bin/chromium -c 'sleep 2; sleep 300; true' --user-data-dir=$HOME/.config/universe-chromium --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 &
BR=$!
# the computer's own parts: running before the note is written, under any name
sh -c 'sleep 306' &
OWN=$!
sleep 1
echo "mark: $(sh ${dir}/universe-mark)"
echo "mark again: $(sh ${dir}/universe-mark)"
sleep 1
# what the agent can start: the same words from a program it owns, a script called chromium, a real program with other arguments
cp /bin/sh ${dir}/agent/chromium && chown 65534:65534 ${dir}/agent/chromium
${dir}/agent/chromium -c 'sleep 303; true' --user-data-dir=$HOME/.config/universe-chromium --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 &
A1=$!
printf 'import time\\ntime.sleep(304)\\n' > ${dir}/agent/chromium.py
python3 ${dir}/agent/chromium.py /usr/local/bin/universe-proxy &
A2=$!
cp /bin/sh ${dir}/bin/x11vnc
${dir}/bin/x11vnc -c 'sleep 305; true' -display :99 -rfbport 5901 &
A3=$!
# the same kind of thing, started after the note: the agent's
sh -c 'sleep 307' &
LATE=$!
setsid sleep 301 </dev/null >/dev/null 2>&1 &
# a short wait is what the computer's own start-up loop runs, and it stops the computer when one is killed: it is never touched
sleep 9 </dev/null >/dev/null 2>&1 &
SHORT=$!
# the same wait started in a session of its own (what anything the agent runs is): not the start-up loop's, so not spared
setsid sleep 9 </dev/null >/dev/null 2>&1 &
OTHER=$!
# the same short wait with agent code loaded into it: not one
LD_PRELOAD=/nonexistent/agent.so sleep 9 </dev/null >/dev/null 2>&1 &
LOADED=$!
# and with its environment wiped by the library itself (the mapped library still shows)
if command -v cc >/dev/null 2>&1 && cc -shared -fPIC -o ${dir}/agent/wipe.so ${dir}/agent/wipe.c 2>/dev/null; then
  NOTE_FILE=${dir}/agent/wipe.ran LD_PRELOAD=${dir}/agent/wipe.so sleep 9 </dev/null >/dev/null 2>&1 &
  WIPED=$!
  # the same library in a folder every user can write to and that looks like part of the system (/dev/shm)
  mkdir -p /dev/shm/universe-fence-test && cp ${dir}/agent/wipe.so /dev/shm/universe-fence-test/wipe.so
  NOTE_FILE=${dir}/agent/shm.ran LD_PRELOAD=/dev/shm/universe-fence-test/wipe.so sleep 9 </dev/null >/dev/null 2>&1 &
  SHM=$!
fi
# and with the library gone from the map: its code copied into nameless memory, the library unmapped (x86-64 only)
if [ "$(uname -m)" = x86_64 ] && command -v cc >/dev/null 2>&1 && cc -shared -fPIC -o ${dir}/agent/hide.so ${dir}/agent/hide.c 2>/dev/null; then
  LD_PRELOAD=${dir}/agent/hide.so sleep 9 </dev/null >/dev/null 2>&1 &
  HIDDEN=$!
fi
sh -c 'sleep 302' &
# the desktop's own program names, started by the agent: a screen of its own on another display, a window manager that runs a command,
# and what a window manager the agent made starts
cp /bin/sh ${dir}/bin/Xvfb
${dir}/bin/Xvfb -c 'sleep 308; true' :100 &
X1=$!
cp /bin/sh ${dir}/bin/openbox
${dir}/bin/openbox -c 'sleep 309; true' --startup 'sleep 1' &
X2=$!
${dir}/bin/openbox -c 'sleep 310 & wait; true' &
X3=$!
sleep 1
for p in $A1 $A2 $A3 $LATE; do kill -0 $p 2>/dev/null && echo "agent-up"; done
# the preloaded code is really in place before the fence runs: the cleared one still maps its library with no LD_ left, the hidden one has
# unmapped its library and runs from nameless code
if [ -n "$WIPED" ]; then grep -q wipe.so /proc/$WIPED/maps && ! tr '\\0' '\\n' < /proc/$WIPED/environ | grep -q '^LD_' && echo "wipe-in-place"; fi
if [ -n "$HIDDEN" ]; then ! grep -q hide.so /proc/$HIDDEN/maps && awk 'NF == 5 && $2 ~ /x/ { found = 1 } END { exit !found }' /proc/$HIDDEN/maps && echo "hide-in-place"; fi
echo "before: $(python3 ${dir}/universe-fence --check)"
python3 ${dir}/universe-fence
echo "after: $(python3 ${dir}/universe-fence --check)"
for p in $GW $BR; do kill -0 $p 2>/dev/null && echo "alive" || echo "dead"; done
for p in $A1 $A2 $A3 $LATE; do kill -0 $p 2>/dev/null && echo "agent-alive" || echo "agent-dead"; done
for p in $X1 $X2 $X3; do kill -0 $p 2>/dev/null && echo "desktop-name-alive" || echo "desktop-name-dead"; done
pgrep -fx 'sleep 310' >/dev/null && echo "desktop-child-alive" || echo "desktop-child-dead"
kill -0 $OWN 2>/dev/null && echo "own-alive" || echo "own-dead"
kill -0 $SHORT 2>/dev/null && echo "short-alive" || echo "short-dead"
kill -0 $OTHER 2>/dev/null && echo "other-alive" || echo "other-dead"
kill -0 $LOADED 2>/dev/null && echo "loaded-alive" || echo "loaded-dead"
if [ -n "$SHM" ]; then [ -f ${dir}/agent/shm.ran ] && echo "shm-loaded"; kill -0 $SHM 2>/dev/null && echo "shm-alive" || echo "shm-dead"; rm -rf /dev/shm/universe-fence-test; fi
if [ -n "$WIPED" ]; then [ -f ${dir}/agent/wipe.ran ] && echo "wipe-loaded"; kill -0 $WIPED 2>/dev/null && echo "wiped-alive" || echo "wiped-dead"; fi
if [ -n "$HIDDEN" ]; then [ -f ${dir}/agent/hide.ran ] && echo "hide-loaded"; kill -0 $HIDDEN 2>/dev/null && echo "hidden-alive" || echo "hidden-dead"; fi
# a child the browser started after the note, below a part that was running before it, is the browser's own
pgrep -P $BR -x sleep >/dev/null && echo "late-child-alive" || echo "late-child-dead"
`;
    const run = spawnSync('unshare', ['--pid', '--fork', '--mount-proc', 'sh', '-c', scenario], { encoding: 'utf8', timeout: 60_000 });
    // Without the note nothing is stopped and nothing is proved; the note is written once per boot
    expect(run.stdout).toMatch(/unmarked: unmarked=1\s+rc=3/);
    expect(run.stdout).toMatch(/mark: marked=1\n/);
    expect(run.stdout).toMatch(/mark again: marked=1 kept=1/);
    expect(run.stdout).toMatch(/before: remaining=[1-9]/);
    expect(run.stdout).toMatch(/killed=[1-9]/);
    expect(run.stdout).toMatch(/after: remaining=0/);
    expect(run.stdout.match(/(^|\n)alive/g)).toHaveLength(2);
    expect(run.stdout).not.toMatch(/(^|\n)dead/);
    // Whatever wears the desktop's name or words is the agent's, and goes
    expect(run.stdout.match(/agent-up/g)).toHaveLength(4);
    expect(run.stdout.match(/agent-dead/g)).toHaveLength(4);
    expect(run.stdout).not.toContain('agent-alive');
    // The desktop's program names are no cover: another screen, a window manager running a command, and what it starts all go
    expect(run.stdout.match(/desktop-name-dead/g)).toHaveLength(3);
    expect(run.stdout).not.toContain('desktop-name-alive');
    expect(run.stdout).toContain('desktop-child-dead');
    // What was running before the note is the computer's own, whatever it is called
    expect(run.stdout).toContain('own-alive');
    // A short sleep is left, and does not count as something the agent has running
    expect(run.stdout).toContain('short-alive');
    // ... but only the one process 1 started; the same wait in a session of its own is the agent's
    expect(run.stdout).toContain('other-dead');
    // A short wait with a loader override in its environment is the agent's code, and goes
    expect(run.stdout).toContain('loaded-dead');
    // ... also when the library wipes the variable from inside, and when it has copied itself into nameless memory and unmapped itself.
    // Each library leaves a note that its code ran, so a missing compiler cannot make this pass by accident: without one, it is skipped.
    const compiler = spawnSync('sh', ['-c', 'command -v cc']).status === 0;
    if (compiler) {
      expect(run.stdout).toContain('wipe-loaded');
      expect(run.stdout).toContain('wipe-in-place');
      expect(run.stdout).toContain('wiped-dead');
      expect(run.stdout).toContain('shm-loaded');
      expect(run.stdout).toContain('shm-dead');
      if (process.arch === 'x64') {
        expect(run.stdout).toContain('hide-loaded');
        expect(run.stdout).toContain('hide-in-place');
        expect(run.stdout).toContain('hidden-dead');
      }
    }
    expect(run.stdout).not.toContain('wiped-alive');
    expect(run.stdout).not.toContain('hidden-alive');
    expect(run.stdout).not.toContain('shm-alive');
    // What a desktop part started after the note is kept, even when the part itself was already kept for being older
    expect(run.stdout).toContain('late-child-alive');
  });
});

describe('building the image on Agent37', () => {
  const T0 = new Date('2026-11-15T12:00:00Z');
  const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

  function setup(builds: Array<Partial<TemplateBuild>> = []) {
    let saved: ImageState | null = null;
    const store: ImageStore = { get: async () => saved, set: async (value) => void (saved = value) };
    const calls: string[] = [];
    const uploaded: Uint8Array[] = [];
    let polls = 0;
    const fail: { create?: boolean; upload?: boolean; start?: boolean } = {};
    const client = {
      async createTemplateBuild(input: { name: string; sizeBytes: number; defaultPort?: number }) {
        calls.push(`create:${input.name}:${input.defaultPort}:${input.sizeBytes}`);
        if (fail.create) throw new Error('refused');
        return { id: `build-${calls.length}`, uploadUrl: 'https://upload.example.test/x' };
      },
      async uploadTemplateContext(_url: string, bytes: Uint8Array) {
        calls.push('upload');
        if (fail.upload) throw new Error('upload refused');
        uploaded.push(bytes);
      },
      async startTemplateBuild(id: string) {
        calls.push(`start:${id}`);
        if (fail.start) throw new Error('start refused');
      },
      async templateBuild(id: string): Promise<TemplateBuild> {
        calls.push(`poll:${id}`);
        const next = builds[Math.min(polls++, builds.length - 1)] ?? { status: 'building' };
        return { status: 'building', log: '', error: null, template: null, ...next };
      },
    } as unknown as Agent37Client;
    return { store, client, calls, uploaded, fail, state: () => saved, set: (value: ImageState | null) => (saved = value) };
  }

  it('starts a build of its content when there is none: packs, uploads, starts, and keeps the build’s id', async () => {
    const w = setup();
    const state = await ensureImage(w.client, w.store, T0);
    expect(state).toMatchObject({ state: 'building', hash: imageContext().hash, failures: 0 });
    expect(w.calls[0]).toMatch(new RegExp(`^create:${IMAGE_NAME}:${IMAGE_PORT}:\\d+$`));
    expect(w.calls.slice(1)).toEqual(['upload', `start:${state.buildId}`]);
    expect(w.uploaded[0].length).toBe(imageContext().gzipped.length);
  });

  it('does not start a build when another sweep holds the right to, and records the build only for the one that does', async () => {
    const w = setup();
    let claims = 0;
    const store: ImageStore = { ...w.store, claim: async (hash, now) => (++claims === 1 ? { hash, state: 'building', buildId: null, revision: null, startedAt: now.toISOString(), failures: 0, error: null } : null) };
    const [a, b] = await Promise.all([ensureImage(w.client, store, T0), ensureImage(w.client, store, T0)]);
    expect(w.calls.filter((call) => call.startsWith('create:'))).toHaveLength(1);
    expect([a.state, b.state]).toEqual(['building', 'building']);
  });

  it('is ready when the build succeeded, with the revision it published, and then does nothing more', async () => {
    const w = setup([{ status: 'building' }, { status: 'succeeded', template: { revision: 3, imageDigest: 'sha256:x' } }]);
    await ensureImage(w.client, w.store, T0);
    expect((await ensureImage(w.client, w.store, minutes(1))).state).toBe('building');
    const ready = await ensureImage(w.client, w.store, minutes(5));
    expect(ready).toMatchObject({ state: 'ready', revision: 3 });
    const before = w.calls.length;
    await ensureImage(w.client, w.store, minutes(10));
    expect(w.calls.length).toBe(before);
  });

  it('starts a new build when the content changed, even though the old one is ready', async () => {
    const w = setup();
    w.set({ hash: 'older', state: 'ready', buildId: 'b0', revision: 1, startedAt: T0.toISOString(), failures: 0, error: null });
    const state = await ensureImage(w.client, w.store, minutes(1));
    expect(state).toMatchObject({ state: 'building', hash: imageContext().hash });
    expect(w.calls[0]).toContain('create:');
  });

  it('records a failed build with its reason, and tries again only after a wait that doubles', async () => {
    const w = setup([{ status: 'failed', error: { code: 'build_failed', message: 'apt could not find chromium' } }]);
    await ensureImage(w.client, w.store, T0);
    const failed = await ensureImage(w.client, w.store, minutes(1));
    expect(failed).toMatchObject({ state: 'failed', failures: 1, error: 'apt could not find chromium' });
    // within the wait: nothing new is started
    const calls = w.calls.length;
    await ensureImage(w.client, w.store, minutes(3));
    expect(w.calls.length).toBe(calls);
    // after it: a new build, and the next wait is longer
    expect((await ensureImage(w.client, w.store, minutes(6))).state).toBe('building');
    await ensureImage(w.client, w.store, minutes(7));
    expect(w.state()).toMatchObject({ state: 'failed', failures: 2 });
    const second = w.calls.length;
    await ensureImage(w.client, w.store, minutes(15));
    expect(w.calls.length).toBe(second);
    await ensureImage(w.client, w.store, minutes(17));
    expect(w.calls.length).toBeGreaterThan(second);
  });

  it('counts a build that was made but could not be uploaded or started as failed, not as building for ever', async () => {
    for (const step of ['upload', 'start'] as const) {
      const w = setup();
      w.fail[step] = true;
      const state = await ensureImage(w.client, w.store, T0);
      expect(state).toMatchObject({ state: 'failed', failures: 1 });
      expect(w.state()?.state).toBe('failed');
    }
    const w = setup();
    w.fail.create = true;
    expect((await ensureImage(w.client, w.store, T0)).state).toBe('failed');
  });

  it('ends a build that can no longer be read once it has gone on for more than an hour, and waits while it is young', async () => {
    const w = setup();
    const state = await ensureImage(w.client, w.store, T0);
    (w.client as unknown as { templateBuild: () => Promise<never> }).templateBuild = async () => {
      throw new Error('404');
    };
    expect((await ensureImage(w.client, w.store, minutes(10))).state).toBe('building');
    const ended = await ensureImage(w.client, w.store, minutes(61));
    expect(ended).toMatchObject({ state: 'failed', buildId: state.buildId, failures: 1 });
  });

  it('counts the wait before a new try from when the build failed, not from when it started', async () => {
    const w = setup([{ status: 'failed', error: { code: 'build_failed', message: 'x' } as never }]);
    await ensureImage(w.client, w.store, T0);
    // The build ran for 50 minutes and then failed
    const failed = await ensureImage(w.client, w.store, minutes(50));
    expect(failed).toMatchObject({ state: 'failed', failures: 1, failedAt: minutes(50).toISOString() });
    const creates = () => w.calls.filter((call) => call.startsWith('create:')).length;
    expect(creates()).toBe(1);
    // A moment later nothing is started again, even though it began long ago
    await ensureImage(w.client, w.store, minutes(51));
    expect(creates()).toBe(1);
  });

  it('ends a build that has gone on for more than an hour', async () => {
    const w = setup();
    await ensureImage(w.client, w.store, T0);
    expect((await ensureImage(w.client, w.store, minutes(30))).state).toBe('building');
    expect((await ensureImage(w.client, w.store, minutes(61))).state).toBe('failed');
  });
});
