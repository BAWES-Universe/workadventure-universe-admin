/** @jest-environment node */
import {
  checkResolved,
  checkTarget,
  defaultPolicy,
  inAnyRange,
  isInternalAddress,
  mintEgressKey,
  nameDenied,
  normalizeHost,
  readClientHello,
  readHttpHost,
  splitAuthority,
  verifyEgressKey,
} from '@/lib/egress/policy';

describe('addresses a computer must never reach', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.100.100.200', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.0.8', '198.18.0.1',
    '224.0.0.1', '240.0.0.1', '255.255.255.255', '168.63.129.16',
    '::', '::1', 'fe80::1', 'fd00:ec2::254', 'fc00::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:a00:1', '64:ff9b::a00:1', '2002:a00:1::1', '2001:db8::1', '2001::1', 'fec0::1',
    'not-an-address', '',
  ])('%s is internal', (address) => expect(isInternalAddress(address)).toBe(true));

  it.each(['93.184.216.34', '1.1.1.1', '8.8.8.8', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])('%s is public', (address) =>
    expect(isInternalAddress(address)).toBe(false),
  );

  it('matches our own ranges, a v4-mapped address included', () => {
    expect(inAnyRange('203.0.114.7', ['203.0.114.0/24'])).toBe(true);
    expect(inAnyRange('203.0.115.7', ['203.0.114.0/24'])).toBe(false);
    expect(inAnyRange('::ffff:203.0.114.7', ['203.0.114.0/24'])).toBe(true);
    expect(inAnyRange('203.0.114.7', ['203.0.114.7'])).toBe(true);
  });
});

describe('names', () => {
  it('normalizes a host and refuses what cannot be one', () => {
    expect(normalizeHost('Example.COM.')).toBe('example.com');
    expect(normalizeHost('[2606:4700:4700::1111]')).toBe('2606:4700:4700::1111');
    expect(normalizeHost('bücher.example')).toBe('xn--bcher-kva.example');
    expect(normalizeHost('a b.example')).toBeNull();
    expect(normalizeHost('fe80::1%eth0')).toBeNull();
    expect(normalizeHost('')).toBeNull();
    expect(normalizeHost('x'.repeat(300))).toBeNull();
  });

  it('refuses a denied name and everything under it, and not a name that only ends in the same letters', () => {
    const config = { denyNames: ['api.groq.com'] };
    expect(nameDenied('composio.dev', config)).toBe(true);
    expect(nameDenied('backend.composio.dev', config)).toBe(true);
    expect(nameDenied('a.b.composio.io', config)).toBe(true);
    expect(nameDenied('api.groq.com', config)).toBe(true);
    expect(nameDenied('eu.api.groq.com', config)).toBe(true);
    expect(nameDenied('notcomposio.dev', config)).toBe(false);
    expect(nameDenied('groq.com', config)).toBe(false);
    expect(nameDenied('example.com', config)).toBe(false);
  });

  it('reads a CONNECT line', () => {
    expect(splitAuthority('Example.com:443')).toEqual({ host: 'example.com', port: 443 });
    expect(splitAuthority('[2606:4700::1]:443')).toEqual({ host: '2606:4700::1', port: 443 });
    expect(splitAuthority('example.com')).toBeNull();
    expect(splitAuthority('example.com:0')).toBeNull();
    expect(splitAuthority('example.com:99999')).toBeNull();
    expect(splitAuthority('a b:443')).toBeNull();
  });
});

describe('the checks that need no lookup, and the one on what a name resolved to', () => {
  const config = defaultPolicy();
  it('lets an ordinary target be', () => {
    expect(checkTarget('example.com', 443, config)).toEqual({ ok: true });
    expect(checkTarget('93.184.216.34', 22, config)).toEqual({ ok: true });
    // Every port is open unless the team narrows it
    for (const port of [25, 53, 3306, 5432, 6379, 27017, 65535]) expect(checkTarget('example.com', port, config)).toEqual({ ok: true });
  });
  it('refuses by port, name and internal address, each with its own reason', () => {
    expect(checkTarget('example.com', 25, { ...config, allowedPorts: [443] })).toMatchObject({ ok: false, reason: 'port_refused' });
    expect(checkTarget('backend.composio.dev', 443, config)).toMatchObject({ ok: false, reason: 'name_refused' });
    expect(checkTarget('169.254.169.254', 80, config)).toMatchObject({ ok: false, reason: 'internal_address' });
  });
  it('refuses a name when any of its answers is internal or ours, or when it has none', () => {
    expect(checkResolved(['93.184.216.34'], config)).toEqual({ ok: true });
    expect(checkResolved(['93.184.216.34', '10.0.0.1'], config)).toMatchObject({ ok: false, reason: 'resolves_inside' });
    expect(checkResolved(['203.0.114.7'], { denyCidrs: ['203.0.114.0/24'] })).toMatchObject({ ok: false, reason: 'resolves_inside' });
    expect(checkResolved([], config)).toMatchObject({ ok: false, reason: 'no_address' });
  });
});

describe('what the first bytes say', () => {
  it('reads plain http hosts and waits for the headers', () => {
    expect(readHttpHost(Buffer.from('GET / HTTP/1.1\r\nHost: Example.com:8080\r\n\r\n'))).toEqual({ kind: 'http', host: 'example.com' });
    expect(readHttpHost(Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\n'))).toEqual({ kind: 'need_more' });
    expect(readHttpHost(Buffer.from('GET / HTTP/1.1\r\nAccept: */*\r\n\r\n'))).toEqual({ kind: 'http', host: null });
    expect(readHttpHost(Buffer.from('GET / HTT'))).toEqual({ kind: 'need_more' });
    expect(readHttpHost(Buffer.from('SSH-2.0-OpenSSH_9.6\r\n'))).toEqual({ kind: 'not_http' });
    expect(readHttpHost(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0x10, 0x20, 0x30, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49])).kind).toBe('not_http');
  });

  it('does not take a tunnel for plain http because of a lookalike line', () => {
    expect(readHttpHost(Buffer.from('GET / HTTP/2.0\r\nHost: a.test\r\n\r\n')).kind).toBe('not_http');
  });

  it('says need_more for a short TLS record and not_tls for the rest', () => {
    expect(readClientHello(Buffer.from([0x16, 0x03, 0x01]))).toEqual({ kind: 'need_more' });
    expect(readClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x30, 0x01]))).toEqual({ kind: 'need_more' });
    expect(readClientHello(Buffer.from('GET / HTTP/1.1\r\n'))).toEqual({ kind: 'not_tls' });
    // A record that claims more than TLS allows
    expect(readClientHello(Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff, 0x01]))).toEqual({ kind: 'not_tls' });
    // A first record that is not a handshake hello
    expect(readClientHello(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x02, 0x00, 0x00, 0x00]))).toEqual({ kind: 'not_tls' });
  });

  it('survives a hello that lies about its own lengths', () => {
    const lie = Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x00, 0x2a, 0x01, 0x00, 0x00, 0x26, 0x03, 0x03]), Buffer.alloc(32), Buffer.from([0xff, 0x00, 0x00, 0x00, 0x00])]);
    expect(readClientHello(lie).kind === 'not_tls' || readClientHello(lie).kind === 'tls').toBe(true);
  });
});

describe('a computer\'s key', () => {
  const secret = 'a-secret-that-is-long-enough-for-this';
  it('is good for its own computer until it ends', () => {
    const now = 1_700_000_000_000;
    const key = mintEgressKey(secret, 'abc123', now);
    expect(verifyEgressKey(secret, key.user, key.pass, now + 1000)).toEqual({ ok: true, machine: 'abc123' });
    expect(verifyEgressKey(secret, 'other', key.pass, now + 1000)).toEqual({ ok: false });
    expect(verifyEgressKey(secret, key.user, key.pass, key.expiresAt + 1)).toEqual({ ok: false });
    expect(verifyEgressKey('another-secret-that-is-long-too!!', key.user, key.pass, now + 1000)).toEqual({ ok: false });
    expect(verifyEgressKey(secret, key.user, `${key.pass}x`, now + 1000)).toEqual({ ok: false });
    expect(verifyEgressKey('', key.user, key.pass, now)).toEqual({ ok: false });
  });
});
