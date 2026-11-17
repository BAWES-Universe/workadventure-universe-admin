import http from 'node:http';
import net from 'node:net';
import { promises as dns } from 'node:dns';
import {
  HELLO_LIMIT,
  WEB_PORTS,
  checkResolved,
  checkTarget,
  isIpLiteral,
  nameDenied,
  readBasic,
  readClientHello,
  readHttpHost,
  splitAuthority,
  normalizeHost,
  verifyEgressKey,
  type PolicyConfig,
  type Refusal,
} from './policy';

/**
 * Universe's egress gateway: the one place a Brick computer's traffic goes out from. The computer's Agent37 network rule lists only the
 * gateways' addresses, so a program on the computer that ignores the proxy has no internet at all (it fails closed, it never goes direct).
 *
 * It is an HTTP proxy (CONNECT for HTTPS, SSH, Git; plain requests for http://). For each connection it:
 *  1. asks for the computer's key (one computer, short-lived, made by Orbit) and refuses without one;
 *  2. refuses a port a job does not need, a denied name (Composio, the Universe AI providers) and an internal address typed in place of a name;
 *  3. looks the name up ITSELF (the computer's own DNS never matters) and refuses it when any answer is internal, then connects to that address;
 *  4. reads the first bytes the computer sends: the TLS server name (SNI) or the HTTP Host must be the name asked for, so one name cannot hide
 *     behind another; a raw address is only let through when the name in those bytes is allowed and resolves to that address.
 * It never opens encrypted traffic, so what a page says stays between the computer and the site (the limit that remains is domain fronting
 * through a network that hides one name behind another: the call still has no key and no money behind it).
 */

export interface GatewayOptions {
  /** Checks a computer's key (the same secret Orbit signs with). */
  secret: string;
  /** The rules, read for every connection so a refreshed deny list counts at once. */
  policy: () => PolicyConfig;
  /** Answers a name with its addresses. Default: this server's own DNS. */
  resolve?: (host: string) => Promise<string[]>;
  /** Opens a connection to a checked address. Default: a plain TCP connect. */
  connect?: (address: string, port: number) => net.Socket;
  now?: () => number;
  /** Open connections one computer may hold at once. */
  maxPerMachine?: number;
  /** Connections open at once across all computers. */
  maxTotal?: number;
  /** A connection with nothing sent either way for this long is closed. */
  idleMs?: number;
  /** How long the first bytes of a web connection (or of one to a bare address) are waited for. */
  helloWaitMs?: number;
  connectTimeoutMs?: number;
  /** One line per refusal and per limit: a name and a reason, never a path, a key or what was sent. */
  log?: (event: string, detail: Record<string, string | number>) => void;
}

const defaultResolve = async (host: string): Promise<string[]> => {
  const answers = await Promise.race([
    dns.lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns_timeout')), 5_000).unref()),
  ]);
  return answers.map((answer) => answer.address);
};

const defaultConnect = (address: string, port: number) => net.connect({ host: address, port, allowHalfOpen: false });

const STATUS_TEXT: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 407: 'Proxy Authentication Required', 429: 'Too Many Requests', 502: 'Bad Gateway', 504: 'Gateway Timeout' };

function refuseSocket(socket: import('node:stream').Duplex, status: number, reason: string) {
  const extra = status === 407 ? 'Proxy-Authenticate: Basic realm="universe-egress"\r\n' : '';
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n${extra}X-Egress-Reason: ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export interface Gateway {
  server: http.Server;
  /** Connections open now, for the health page. */
  open(): number;
}

export function createGateway(options: GatewayOptions): Gateway {
  const resolve = options.resolve ?? defaultResolve;
  const connect = options.connect ?? defaultConnect;
  const now = options.now ?? Date.now;
  const maxPerMachine = options.maxPerMachine ?? 64;
  const maxTotal = options.maxTotal ?? 2_000;
  const idleMs = options.idleMs ?? 10 * 60 * 1000;
  const helloWaitMs = options.helloWaitMs ?? 10_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const log = options.log ?? (() => undefined);
  const held = new Map<string, number>();
  let total = 0;

  const take = (machine: string): boolean => {
    if (total >= maxTotal || (held.get(machine) ?? 0) >= maxPerMachine) return false;
    held.set(machine, (held.get(machine) ?? 0) + 1);
    total++;
    return true;
  };
  const give = (machine: string) => {
    const left = (held.get(machine) ?? 1) - 1;
    if (left <= 0) held.delete(machine);
    else held.set(machine, left);
    total = Math.max(0, total - 1);
  };

  const authenticate = (header: string | undefined): { ok: true; machine: string } | { ok: false } => {
    const given = readBasic(header);
    if (!given) return { ok: false };
    return verifyEgressKey(options.secret, given.user, given.pass, now());
  };

  /** The addresses a name may be connected to, or the reason it may not. */
  const addressesOf = async (host: string, policy: PolicyConfig): Promise<{ ok: true; addresses: string[] } | Refusal> => {
    if (isIpLiteral(host)) return { ok: true, addresses: [host] };
    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch {
      return { ok: false, status: 502, reason: 'no_address' };
    }
    const checked = checkResolved(addresses, policy);
    return checked.ok ? { ok: true, addresses } : checked;
  };

  /** Connects to the first of the addresses that answers. */
  const open = (addresses: string[], port: number): Promise<net.Socket> =>
    new Promise((resolveSocket, reject) => {
      const tryAt = (index: number) => {
        if (index >= addresses.length) return reject(new Error('unreachable'));
        const socket = connect(addresses[index], port);
        const timer = setTimeout(() => socket.destroy(new Error('connect_timeout')), connectTimeoutMs);
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.removeAllListeners('error');
          resolveSocket(socket);
        });
        socket.once('error', () => {
          clearTimeout(timer);
          socket.destroy();
          tryAt(index + 1);
        });
      };
      tryAt(0);
    });

  type Verdict = { allow: true } | { allow: false; reason: string } | { allow: 'wait' };

  /**
   * What the first bytes say, against the name that was asked for. For a bare address (`literal`) the name in the bytes must be allowed and
   * must resolve to that very address; for a name, it must be that name.
   */
  const judge = async (bytes: Buffer, asked: string, literal: boolean, policy: PolicyConfig): Promise<Verdict> => {
    let said: string | null;
    if (bytes[0] === 0x16) {
      const hello = readClientHello(bytes);
      if (hello.kind === 'need_more') return bytes.length >= HELLO_LIMIT ? { allow: false, reason: 'bad_hello' } : { allow: 'wait' };
      if (hello.kind === 'not_tls') return { allow: false, reason: 'bad_hello' };
      said = hello.sni;
    } else {
      const request = readHttpHost(bytes);
      if (request.kind === 'need_more') return { allow: 'wait' };
      if (request.kind === 'not_http') return literal ? { allow: false, reason: 'address_without_name' } : { allow: true };
      said = request.host;
    }
    if (said === null) return literal ? { allow: false, reason: 'address_without_name' } : { allow: true };
    if (said === '?' || isIpLiteral(said)) return { allow: false, reason: 'name_not_valid' };
    if (nameDenied(said, policy)) return { allow: false, reason: 'name_refused' };
    if (!literal) return said === asked ? { allow: true } : { allow: false, reason: 'name_mismatch' };
    const found = await addressesOf(said, policy);
    if (!found.ok) return { allow: false, reason: found.reason };
    return found.addresses.includes(asked) ? { allow: true } : { allow: false, reason: 'name_does_not_match_address' };
  };

  const server = http.createServer();
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  // ---------- CONNECT: HTTPS, SSH, Git ----------
  server.on('connect', async (req, client: net.Socket, head: Buffer) => {
    client.on('error', () => client.destroy());
    const auth = authenticate(req.headers['proxy-authorization']);
    if (!auth.ok) return refuseSocket(client, 407, 'key');
    const target = splitAuthority(req.url ?? '');
    if (!target) return refuseSocket(client, 400, 'target');
    const policy = options.policy();
    const checked = checkTarget(target.host, target.port, policy);
    if (!checked.ok) {
      log('refused', { host: target.host, port: target.port, reason: checked.reason });
      return refuseSocket(client, checked.status, checked.reason);
    }
    if (!take(auth.machine)) {
      log('limit', { machine: auth.machine });
      return refuseSocket(client, 429, 'limit');
    }
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        give(auth.machine);
      }
    };
    client.once('close', release);
    const literal = isIpLiteral(target.host);
    let upstream: net.Socket | null = null;
    const close = () => {
      client.destroy();
      upstream?.destroy();
    };
    try {
      let chunks: Buffer[] = head && head.length > 0 ? [head] : [];
      const decide = async (): Promise<Verdict> => (chunks.length === 0 ? { allow: 'wait' } : judge(Buffer.concat(chunks), target.host, literal, policy));

      if (!literal) {
        const found = await addressesOf(target.host, policy);
        if (!found.ok) {
          log('refused', { host: target.host, port: target.port, reason: found.reason });
          return refuseSocket(client, found.status, found.reason);
        }
        try {
          upstream = await open(found.addresses, target.port);
        } catch {
          return refuseSocket(client, 502, 'unreachable');
        }
        upstream.on('error', close);
        upstream.setTimeout(idleMs, close);
        upstream.once('close', close);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Whatever the server says first (SSH, a mail banner) goes straight to the computer; what the computer says first is read before it is sent on
        upstream.pipe(client);
      } else {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      }
      client.setTimeout(idleMs, close);

      // The computer's first bytes decide: they are held until they are judged
      const verdict = await new Promise<Verdict>((resolveVerdict) => {
        let done = false;
        const finish = (v: Verdict) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          client.off('data', onData);
          client.off('end', onEnd);
          resolveVerdict(v);
        };
        // A bare address, or a web port, that says nothing is not waited on forever; another port may be server-first and simply be quiet
        const timer = setTimeout(() => finish(literal || WEB_PORTS.includes(target.port) ? { allow: false, reason: 'silent' } : { allow: 'wait' }), helloWaitMs);
        const check = async () => {
          const v = await decide().catch(() => ({ allow: false, reason: 'judge_failed' }) as Verdict);
          if (v.allow !== 'wait') finish(v);
        };
        const onData = (data: Buffer) => {
          chunks.push(data);
          void check();
        };
        const onEnd = () => finish({ allow: false, reason: 'closed' });
        client.on('data', onData);
        client.on('end', onEnd);
        void check();
      });
      if (verdict.allow === false) {
        log('refused', { host: target.host, port: target.port, reason: verdict.reason });
        return close();
      }
      if (verdict.allow === 'wait') {
        // Server-first and quiet on a port that is not the web: the first bytes are still judged when they come, and held until they are
        let pending: Buffer = Buffer.concat(chunks);
        let judged = false;
        let order: Promise<void> = Promise.resolve();
        client.on('data', (data: Buffer) => {
          order = order.then(async () => {
            if (!judged) {
              pending = Buffer.concat([pending, data]);
              const v = await judge(pending, target.host, false, policy).catch(() => ({ allow: false, reason: 'judge_failed' }) as Verdict);
              if (v.allow === 'wait') return;
              if (v.allow === false) {
                log('refused', { host: target.host, port: target.port, reason: v.reason });
                return close();
              }
              judged = true;
              upstream?.write(pending);
              return;
            }
            upstream?.write(data);
          });
        });
        return;
      }
      if (literal) {
        // The bytes proved the name, which resolves to this address: now, and only now, the connection is opened
        try {
          upstream = await open([target.host], target.port);
        } catch {
          return close();
        }
        upstream.on('error', close);
        upstream.setTimeout(idleMs, close);
        upstream.once('close', close);
        upstream.pipe(client);
      }
      for (const chunk of chunks) upstream?.write(chunk);
      chunks = [];
      client.pipe(upstream as net.Socket);
    } catch {
      close();
    }
  });

  // ---------- Plain http:// requests, and the gateway's own health ----------
  server.on('request', async (req, res) => {
    if ((req.url ?? '').startsWith('/')) {
      if (req.url === '/__egress/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ ok: true, open: total }));
      }
      // The computer asks who the gateway takes it for: proves the key is good end to end (the forwarder on the computer adds it)
      if (req.url === '/__egress/whoami') {
        const who = authenticate(req.headers['proxy-authorization']);
        res.writeHead(who.ok ? 200 : 407, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(who.ok ? { ok: true, machine: who.machine } : { ok: false }));
      }
      res.writeHead(404);
      return res.end();
    }
    const fail = (status: number, reason: string) => {
      if (!res.headersSent) res.writeHead(status, { 'x-egress-reason': reason, ...(status === 407 ? { 'proxy-authenticate': 'Basic realm="universe-egress"' } : {}), connection: 'close' });
      res.end();
    };
    const auth = authenticate(req.headers['proxy-authorization']);
    if (!auth.ok) return fail(407, 'key');
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      return fail(400, 'target');
    }
    if (url.protocol !== 'http:') return fail(400, 'target');
    const host = normalizeHost(url.hostname);
    const port = url.port ? Number(url.port) : 80;
    if (!host) return fail(400, 'target');
    const policy = options.policy();
    const checked = checkTarget(host, port, policy);
    if (!checked.ok) {
      log('refused', { host, port, reason: checked.reason });
      return fail(checked.status, checked.reason);
    }
    // A bare address has no name to back it: plain http carries a Host, and it must be the name that resolves to this address
    if (isIpLiteral(host)) {
      log('refused', { host, port, reason: 'address_without_name' });
      return fail(403, 'address_without_name');
    }
    if (!take(auth.machine)) {
      log('limit', { machine: auth.machine });
      return fail(429, 'limit');
    }
    res.once('close', () => give(auth.machine));
    const found = await addressesOf(host, policy);
    if (!found.ok) {
      log('refused', { host, port, reason: found.reason });
      return fail(found.status, found.reason);
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (/^(proxy-|connection$|keep-alive$|te$|trailer$|upgrade$)/i.test(name) || value === undefined) continue;
      headers[name] = value;
    }
    headers.host = url.host;
    headers.connection = 'close';
    let socket: net.Socket;
    try {
      socket = await open(found.addresses, port);
    } catch {
      return fail(502, 'unreachable');
    }
    const upstream = http.request({ method: req.method, path: `${url.pathname}${url.search}`, headers, createConnection: () => socket, timeout: idleMs });
    upstream.on('response', (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => fail(502, 'unreachable'));
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) refuseSocket(socket, 400, 'request');
    else socket.destroy();
  });

  return { server, open: () => total };
}
