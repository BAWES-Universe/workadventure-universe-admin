/** @jest-environment node */
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import { createGateway, type Gateway } from '@/lib/egress/gateway';
import { defaultPolicy, mintEgressKey, type PolicyConfig } from '@/lib/egress/policy';

/**
 * The gateway on real sockets. "The internet" is two local servers: the gateway's `resolve` hands out public-looking addresses and its
 * `connect` sends every one of them to a local server that writes down what it was sent, so what is let through is what reaches it.
 */

const SECRET = 'a-test-secret-of-the-gateway';
const OTHER = 'a-secret-nobody-has';

interface Upstream {
  port: number;
  received: Buffer[];
  connections: number;
  close(): Promise<void>;
}

async function upstreamServer(options: { banner?: string; echo?: boolean } = {}): Promise<Upstream> {
  const received: Buffer[] = [];
  const state = { connections: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    state.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    if (options.banner) socket.write(options.banner);
    socket.on('data', (data) => {
      received.push(data);
      if (options.echo !== false) socket.write(Buffer.concat([Buffer.from('echo:'), data]));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: (server.address() as net.AddressInfo).port,
    received,
    get connections() {
      return state.connections;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((done) => server.close(() => done()));
    },
  } as Upstream;
}

let web: Upstream;
let banner: Upstream;
let httpUp: http.Server;
let httpUpPort = 0;
let httpSeen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders }> = [];
let gateway: Gateway;
let gatewayPort = 0;
let policy: PolicyConfig;
let lookups: string[];
let opened: Array<{ address: string; port: number }>;
let logged: Array<{ event: string; detail: Record<string, string | number> }>;
const names: Record<string, string[]> = {
  'allowed.test': ['93.184.216.34'],
  'other.test': ['93.184.216.35'],
  'inside.test': ['10.1.2.3'],
  'mixed.test': ['93.184.216.36', '192.168.0.5'],
  'v6.test': ['2606:2800:220:1:248:1893:25c8:1946'],
  'composio-fronted.test': ['93.184.216.37'],
  'backend.composio.dev': ['104.18.20.5'],
};

const key = (machine = 'machine-1') => mintEgressKey(SECRET, machine);
const basic = (k: { user: string; pass: string }) => `Basic ${Buffer.from(`${k.user}:${k.pass}`).toString('base64')}`;

beforeAll(async () => {
  web = await upstreamServer();
  banner = await upstreamServer({ banner: 'SSH-2.0-testserver\r\n' });
  httpUp = http.createServer((req, res) => {
    httpSeen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello from the web');
  });
  await new Promise<void>((done) => httpUp.listen(0, '127.0.0.1', done));
  httpUpPort = (httpUp.address() as net.AddressInfo).port;
});
afterAll(async () => {
  await web.close();
  await banner.close();
  httpUp.closeAllConnections();
  await new Promise<void>((done) => httpUp.close(() => done()));
});

beforeEach(async () => {
  policy = defaultPolicy();
  lookups = [];
  opened = [];
  logged = [];
  web.received.length = 0;
  banner.received.length = 0;
  gateway = createGateway({
    secret: SECRET,
    policy: () => policy,
    resolve: async (host) => {
      lookups.push(host);
      const found = names[host];
      if (!found) throw new Error('ENOTFOUND');
      return found;
    },
    connect: (address, port) => {
      opened.push({ address, port });
      return net.connect({ host: '127.0.0.1', port: port === 22 ? banner.port : port === 8080 ? httpUpPort : web.port });
    },
    helloWaitMs: 400,
    connectTimeoutMs: 1_000,
    idleMs: 5_000,
    maxPerMachine: 3,
    log: (event, detail) => logged.push({ event, detail }),
  });
  await new Promise<void>((done) => gateway.server.listen(0, '127.0.0.1', done));
  gatewayPort = (gateway.server.address() as net.AddressInfo).port;
});

afterEach(async () => {
  gateway.server.closeAllConnections();
  await new Promise<void>((done) => gateway.server.close(() => done()));
});

/** What the gateway answers to a CONNECT, and the socket when it opened a tunnel. */
function connectTo(authority: string, auth: string | null): Promise<{ status: number; reason: string | null; socket: net.Socket; rest: Buffer }> {
  return new Promise((resolveAnswer, reject) => {
    const socket = net.connect(gatewayPort, '127.0.0.1');
    let buffered = Buffer.alloc(0);
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`));
    const onData = (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const head = buffered.subarray(0, end).toString();
      resolveAnswer({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]), reason: /x-egress-reason: (\S+)/i.exec(head)?.[1] ?? null, socket, rest: buffered.subarray(end + 4) });
    };
    socket.on('data', onData);
  });
}

const closes = (socket: net.Socket, within = 1_500): Promise<boolean> =>
  new Promise((done) => {
    const timer = setTimeout(() => done(false), within);
    socket.once('close', () => {
      clearTimeout(timer);
      done(true);
    });
    socket.on('error', () => undefined);
  });

const nextData = (socket: net.Socket, within = 1_500): Promise<Buffer | null> =>
  new Promise((done) => {
    const timer = setTimeout(() => done(null), within);
    socket.once('data', (data) => {
      clearTimeout(timer);
      done(data);
    });
  });

/** A real ClientHello, as Node's own TLS writes it, captured by a server that does not answer. */
async function helloFor(servername: string): Promise<Buffer> {
  return new Promise((resolveHello) => {
    const server = net.createServer((socket) => {
      socket.once('data', (data) => {
        resolveHello(data);
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const socket = tls.connect({ host: '127.0.0.1', port: (server.address() as net.AddressInfo).port, servername, rejectUnauthorized: false });
      socket.on('error', () => undefined);
    });
  });
}

describe('the computer\'s key', () => {
  it('refuses a connection without one, with one for another secret, with an expired one and with a made-up one', async () => {
    expect((await connectTo('allowed.test:443', null)).status).toBe(407);
    const wrong = mintEgressKey(OTHER, 'machine-1');
    expect((await connectTo('allowed.test:443', basic(wrong))).status).toBe(407);
    const expired = mintEgressKey(SECRET, 'machine-1', Date.now() - 10_000_000, 1000);
    expect((await connectTo('allowed.test:443', basic(expired))).status).toBe(407);
    expect((await connectTo('allowed.test:443', basic({ user: 'machine-1', pass: '9999999999.abc' }))).status).toBe(407);
    expect(opened).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it('does not let a key of one computer be used as another computer\'s', async () => {
    const k = key('machine-1');
    expect((await connectTo('allowed.test:443', basic({ user: 'machine-2', pass: k.pass }))).status).toBe(407);
  });

  it('refuses a key that claims to last for a year', async () => {
    const long = mintEgressKey(SECRET, 'machine-1', Date.now(), 365 * 24 * 3600 * 1000);
    expect((await connectTo('allowed.test:443', basic(long))).status).toBe(407);
  });
});

describe('which names, ports and addresses are refused before anything is looked up or opened', () => {
  it.each([['backend.composio.dev:443'], ['app.composio.dev:443'], ['composio.io:443'], ['COMPOSIO.DEV.:443'], ['console.groq.com:443']])('refuses %s by its name', async (authority) => {
    const answer = await connectTo(authority, basic(key()));
    expect(answer.status).toBe(403);
    expect(answer.reason).toBe('name_refused');
    expect(opened).toEqual([]);
  });

  it('refuses the Universe AI provider names Orbit hands it, and what sits under them', async () => {
    policy = { ...policy, denyNames: ['api.groq.com'] };
    expect((await connectTo('api.groq.com:443', basic(key()))).reason).toBe('name_refused');
    expect((await connectTo('eu.api.groq.com:443', basic(key()))).reason).toBe('name_refused');
  });

  it('does not refuse a name only because it ends in the same letters', async () => {
    names['notcomposio.dev'] = ['93.184.216.40'];
    const answer = await connectTo('notcomposio.dev:443', basic(key()));
    expect(answer.status).toBe(200);
    answer.socket.destroy();
  });

  it.each([['25'], ['3306'], ['53'], ['6379'], ['5432'], ['27017']])('lets port %s through: the internet is open on every port', async (port) => {
    const answer = await connectTo(`allowed.test:${port}`, basic(key()));
    expect(answer.status).toBe(200);
    answer.socket.write('PING\r\n');
    expect((await nextData(answer.socket))?.toString()).toContain('echo:PING');
    answer.socket.destroy();
  });

  it('can still be narrowed by the team (an optional list of ports), and then says so', async () => {
    policy = { ...policy, allowedPorts: [443] };
    const answer = await connectTo('allowed.test:25', basic(key()));
    expect(answer.status).toBe(403);
    expect(answer.reason).toBe('port_refused');
  });

  it.each([['10.0.0.1:443'], ['169.254.169.254:80'], ['127.0.0.1:443'], ['[::1]:443'], ['192.168.1.1:22'], ['[fd00:ec2::254]:80'], ['100.100.100.200:80'], ['[::ffff:10.0.0.1]:443']])('refuses the address %s typed in place of a name', async (authority) => {
    const answer = await connectTo(authority, basic(key()));
    expect(answer.status).toBe(403);
    expect(answer.reason).toBe('internal_address');
    expect(opened).toEqual([]);
  });

  it('refuses our own servers\' addresses', async () => {
    policy = { ...policy, denyCidrs: ['93.184.216.40/29'] };
    expect((await connectTo('93.184.216.41:443', basic(key()))).reason).toBe('internal_address');
  });

  it('refuses a name that resolves inside, even when another answer is public', async () => {
    expect((await connectTo('inside.test:443', basic(key()))).reason).toBe('resolves_inside');
    expect((await connectTo('mixed.test:443', basic(key()))).reason).toBe('resolves_inside');
    expect(opened).toEqual([]);
  });

  it('answers 502 for a name that does not exist', async () => {
    expect((await connectTo('nowhere.test:443', basic(key()))).status).toBe(502);
  });
});

describe('a name that is allowed', () => {
  it('is connected by the address the gateway looked up itself, and what the computer sends reaches the server', async () => {
    const answer = await connectTo('allowed.test:443', basic(key()));
    expect(answer.status).toBe(200);
    expect(opened).toEqual([{ address: '93.184.216.34', port: 443 }]);
    const hello = await helloFor('allowed.test');
    answer.socket.write(hello);
    const echoed = await nextData(answer.socket);
    expect(echoed?.subarray(0, 5).toString()).toBe('echo:');
    expect(Buffer.concat(web.received).equals(hello)).toBe(true);
    answer.socket.destroy();
  });

  it('works over IPv6 answers too', async () => {
    const answer = await connectTo('v6.test:443', basic(key()));
    expect(answer.status).toBe(200);
    expect(opened[0].address).toBe('2606:2800:220:1:248:1893:25c8:1946');
    answer.socket.destroy();
  });

  it('lets a server speak first (SSH) and passes what the computer answers', async () => {
    const answer = await connectTo('allowed.test:22', basic(key()));
    expect(answer.status).toBe(200);
    const first = answer.rest.length > 0 ? answer.rest : await nextData(answer.socket);
    expect(first?.toString()).toContain('SSH-2.0-testserver');
    answer.socket.write('SSH-2.0-client\r\n');
    const echoed = await nextData(answer.socket);
    expect(echoed?.toString()).toContain('echo:SSH-2.0-client');
    answer.socket.destroy();
  });

  it('lets a quiet client of a non-web port stay quiet and judges its first bytes when they come', async () => {
    const answer = await connectTo('allowed.test:22', basic(key()));
    await new Promise((done) => setTimeout(done, 700));
    answer.socket.write(await helloFor('backend.composio.dev'));
    expect(await closes(answer.socket)).toBe(true);
    expect(web.received.length + banner.received.length).toBe(0);
  });
});

describe('a denied name hiding behind an allowed one', () => {
  it('lets a tunnel whose TLS server name differs from the name asked for (sites share addresses), and sends everything on', async () => {
    const answer = await connectTo('allowed.test:443', basic(key()));
    const hello = await helloFor('other.test');
    answer.socket.write(hello);
    expect(await nextData(answer.socket)).not.toBeNull();
    expect(Buffer.concat(web.received).equals(hello)).toBe(true);
    answer.socket.destroy();
  });

  it('closes a tunnel to an allowed name that asks, inside TLS, for Composio, and sends nothing on', async () => {
    const answer = await connectTo('allowed.test:443', basic(key()));
    answer.socket.write(await helloFor('backend.composio.dev'));
    expect(await closes(answer.socket)).toBe(true);
    expect(web.received).toEqual([]);
    expect(logged.some((entry) => entry.detail.reason === 'name_refused')).toBe(true);
  });

  it('closes a tunnel whose Host header (plain http through CONNECT) is Composio', async () => {
    const answer = await connectTo('allowed.test:80', basic(key()));
    answer.socket.write('GET / HTTP/1.1\r\nHost: backend.composio.dev\r\n\r\n');
    expect(await closes(answer.socket)).toBe(true);
    expect(web.received).toEqual([]);
  });

  it('lets the same request through with its own Host', async () => {
    const answer = await connectTo('allowed.test:80', basic(key()));
    answer.socket.write('GET / HTTP/1.1\r\nHost: allowed.test\r\n\r\n');
    const echoed = await nextData(answer.socket);
    expect(echoed?.toString()).toContain('echo:GET / HTTP/1.1');
    answer.socket.destroy();
  });

  it('waits for the rest of a ClientHello that came in two pieces', async () => {
    const answer = await connectTo('allowed.test:443', basic(key()));
    const hello = await helloFor('allowed.test');
    answer.socket.write(hello.subarray(0, 20));
    await new Promise((done) => setTimeout(done, 80));
    expect(web.received).toEqual([]);
    answer.socket.write(hello.subarray(20));
    expect(await nextData(answer.socket)).not.toBeNull();
    expect(Buffer.concat(web.received).equals(hello)).toBe(true);
    answer.socket.destroy();
  });

  it('keeps a quiet connection open (a server may speak first), and still judges what the computer says when it does', async () => {
    const quiet = await connectTo('allowed.test:443', basic(key()));
    expect(await closes(quiet.socket, 800)).toBe(false);
    quiet.socket.write(await helloFor('allowed.test'));
    expect(await nextData(quiet.socket)).not.toBeNull();
    quiet.socket.destroy();
    const sneaky = await connectTo('allowed.test:443', basic(key()));
    await new Promise((done) => setTimeout(done, 600));
    sneaky.socket.write(await helloFor('backend.composio.dev'));
    expect(await closes(sneaky.socket)).toBe(true);
  });
});

describe('a raw address', () => {
  it('is connected at once, like a name, and what the computer sends reaches the server', async () => {
    const answer = await connectTo('93.184.216.34:443', basic(key()));
    expect(answer.status).toBe(200);
    expect(opened).toEqual([{ address: '93.184.216.34', port: 443 }]);
    answer.socket.write(await helloFor('whatever.test'));
    expect(await nextData(answer.socket)).not.toBeNull();
    answer.socket.destroy();
  });

  it('carries anything that is not TLS or HTTP (a database, a game, SSH) and a server that speaks first', async () => {
    const answer = await connectTo('93.184.216.34:5432', basic(key()));
    answer.socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
    expect(await nextData(answer.socket)).not.toBeNull();
    answer.socket.destroy();
    const ssh = await connectTo('93.184.216.40:22', basic(key()));
    expect((await nextData(ssh.rest.length > 0 ? ssh.socket : ssh.socket))?.toString() ?? ssh.rest.toString()).toContain('SSH-2.0-testserver');
    ssh.socket.destroy();
  });

  it('is closed when the name in its TLS opening is Composio, whatever the address', async () => {
    const answer = await connectTo('104.18.20.5:443', basic(key()));
    answer.socket.write(await helloFor('backend.composio.dev'));
    expect(await closes(answer.socket)).toBe(true);
    expect(web.received).toEqual([]);
  });

  it('is closed when its plain http says Composio is the host', async () => {
    const answer = await connectTo('93.184.216.34:80', basic(key()));
    answer.socket.write('GET / HTTP/1.1\r\nHost: app.composio.dev\r\n\r\n');
    expect(await closes(answer.socket)).toBe(true);
    expect(web.received).toEqual([]);
  });
});

describe('plain http through the proxy', () => {
  const via = (url: string, auth: string | null, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; reason: string | null; body: string }>((resolveAnswer, reject) => {
      const request = http.request({ host: '127.0.0.1', port: gatewayPort, method: 'GET', path: url, headers: { Host: new URL(url).host, ...(auth ? { 'Proxy-Authorization': auth } : {}), ...headers } }, (response) => {
        let body = '';
        response.on('data', (data) => (body += data));
        response.on('end', () => resolveAnswer({ status: response.statusCode ?? 0, reason: (response.headers['x-egress-reason'] as string) ?? null, body }));
      });
      request.on('error', reject);
      request.end();
    });

  it('needs the key, and refuses Composio, internal addresses and names that resolve inside', async () => {
    expect((await via('http://allowed.test/x', null)).status).toBe(407);
    expect((await via('http://backend.composio.dev/x', basic(key()))).reason).toBe('name_refused');
    expect((await via('http://169.254.169.254/latest', basic(key()))).reason).toBe('internal_address');
    expect((await via('http://inside.test/x', basic(key()))).reason).toBe('resolves_inside');
    expect(opened).toEqual([]);
  });

  it('passes a request to a raw address too (the internet is open)', async () => {
    const answer = await via(`http://93.184.216.34:8080/x`, basic(key()));
    expect(answer.status).toBe(200);
    expect(answer.body).toBe('hello from the web');
  });

  it('passes an allowed request with its own Host and without the proxy\'s headers', async () => {
    httpSeen = [];
    const answer = await via('http://allowed.test:8080/path?q=1', basic(key()), { 'X-Thing': 'kept', 'Proxy-Connection': 'keep-alive' });
    expect(answer.status).toBe(200);
    expect(answer.body).toBe('hello from the web');
    expect(httpSeen).toHaveLength(1);
    expect(httpSeen[0].method).toBe('GET');
    expect(httpSeen[0].url).toBe('/path?q=1');
    expect(httpSeen[0].headers.host).toBe('allowed.test:8080');
    expect(httpSeen[0].headers['x-thing']).toBe('kept');
    expect(httpSeen[0].headers['proxy-authorization']).toBeUndefined();
    expect(httpSeen[0].headers['proxy-connection']).toBeUndefined();
    expect(opened).toEqual([{ address: '93.184.216.34', port: 8080 }]);
  });

  it('answers its own health without a key', async () => {
    const answer = await new Promise<{ status: number; body: string }>((resolveAnswer, reject) => {
      http
        .get({ host: '127.0.0.1', port: gatewayPort, path: '/__egress/health' }, (response) => {
          let body = '';
          response.on('data', (data) => (body += data));
          response.on('end', () => resolveAnswer({ status: response.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body).ok).toBe(true);
  });
});

describe('whoami', () => {
  const ask = (auth: string | null) =>
    new Promise<{ status: number; body: string }>((resolveAnswer, reject) => {
      http
        .get({ host: '127.0.0.1', port: gatewayPort, path: '/__egress/whoami', headers: auth ? { 'Proxy-Authorization': auth } : {} }, (response) => {
          let body = '';
          response.on('data', (data) => (body += data));
          response.on('end', () => resolveAnswer({ status: response.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });

  it('names the computer for a good key and refuses any other', async () => {
    const good = await ask(basic(key('machine-7')));
    expect(good.status).toBe(200);
    expect(JSON.parse(good.body)).toEqual({ ok: true, machine: 'machine-7' });
    expect((await ask(null)).status).toBe(407);
    expect((await ask(basic(mintEgressKey(OTHER, 'machine-7')))).status).toBe(407);
  });
});

describe('limits', () => {
  it('holds one computer to its open connections and tells it so', async () => {
    const open: net.Socket[] = [];
    for (let i = 0; i < 3; i++) {
      const answer = await connectTo('allowed.test:22', basic(key('busy-machine')));
      expect(answer.status).toBe(200);
      open.push(answer.socket);
    }
    const fourth = await connectTo('allowed.test:22', basic(key('busy-machine')));
    expect(fourth.status).toBe(429);
    // Another computer is not held back by it
    const other = await connectTo('allowed.test:22', basic(key('quiet-machine')));
    expect(other.status).toBe(200);
    for (const socket of [...open, other.socket]) socket.destroy();
  });
});

describe('WebSocket and what the gateway measures', () => {
  const rawProxied = (head: string): Promise<{ socket: net.Socket; first: Buffer | null }> =>
    new Promise((resolveRaw, reject) => {
      const socket = net.connect(gatewayPort, '127.0.0.1');
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write(head);
        nextData(socket).then((first) => resolveRaw({ socket, first }));
      });
    });
  const upgrade = (url: string, auth: string | null) =>
    `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZQ==\r\nSec-WebSocket-Version: 13\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`;

  it('carries a WebSocket tunnelled with CONNECT (wss:// and ws://), both ways', async () => {
    const answer = await connectTo('allowed.test:443', basic(key()));
    answer.socket.write(await helloFor('allowed.test'));
    expect(await nextData(answer.socket)).not.toBeNull();
    answer.socket.write(Buffer.from([0x81, 0x84, 1, 2, 3, 4, 5, 6, 7, 8]));
    expect((await nextData(answer.socket))?.includes(Buffer.from('echo:'))).toBe(true);
    answer.socket.destroy();
  });

  it('carries an upgrade sent as a proxied request, without the proxy’s headers and with its own Host', async () => {
    const { socket, first } = await rawProxied(upgrade('http://allowed.test/chat', basic(key())));
    const text = first?.toString() ?? '';
    expect(text).toContain('echo:GET /chat HTTP/1.1');
    expect(text).toContain('Host: allowed.test');
    expect(text.toLowerCase()).toContain('upgrade: websocket');
    expect(text.toLowerCase()).not.toContain('proxy-authorization');
    socket.destroy();
  });

  it('needs the key for an upgrade, and refuses Composio and internal addresses in one', async () => {
    expect((await rawProxied(upgrade('http://allowed.test/chat', null))).first?.toString()).toContain('407');
    const composio = await rawProxied(upgrade('http://backend.composio.dev/ws', basic(key())));
    expect(composio.first?.toString()).toContain('403');
    expect(composio.first?.toString().toLowerCase()).toContain('name_refused');
    expect((await rawProxied(upgrade('http://169.254.169.254/ws', basic(key())))).first?.toString().toLowerCase()).toContain('internal_address');
    expect(web.received).toEqual([]);
  });

  it('says what it carried and refused, for sizing from real traffic and not from a guess', async () => {
    const before = await new Promise<{ connections: number; refused: number; bytesToInternet: number; bytesFromInternet: number }>((resolveHealth, reject) => {
      http.get({ host: '127.0.0.1', port: gatewayPort, path: '/__egress/health' }, (response) => {
        let body = '';
        response.on('data', (data) => (body += data));
        response.on('end', () => resolveHealth(JSON.parse(body)));
      }).on('error', reject);
    });
    expect(before).toMatchObject({ connections: 0, refused: 0, bytesToInternet: 0, bytesFromInternet: 0 });
    const answer = await connectTo('allowed.test:443', basic(key()));
    answer.socket.write(await helloFor('allowed.test'));
    await nextData(answer.socket);
    await connectTo('backend.composio.dev:443', basic(key()));
    const after = await new Promise<{ connections: number; refused: number; bytesToInternet: number; bytesFromInternet: number }>((resolveHealth, reject) => {
      http.get({ host: '127.0.0.1', port: gatewayPort, path: '/__egress/health' }, (response) => {
        let body = '';
        response.on('data', (data) => (body += data));
        response.on('end', () => resolveHealth(JSON.parse(body)));
      }).on('error', reject);
    });
    expect(after.connections).toBe(1);
    expect(after.refused).toBe(1);
    expect(after.bytesToInternet).toBeGreaterThan(0);
    expect(after.bytesFromInternet).toBeGreaterThan(0);
    answer.socket.destroy();
  });
});
