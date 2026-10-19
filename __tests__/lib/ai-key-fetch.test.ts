import { EventEmitter } from 'events';
import https from 'https';
import { lookup } from 'dns/promises';
import { AddressError, checkPublicHttpsUrl, isPublicAddress, parsePublicHttpsUrl, safeGet } from '@/lib/ai-key-fetch';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
const lookupMock = lookup as unknown as jest.Mock;

function problem(run: () => unknown): Promise<string | null> {
  return Promise.resolve()
    .then(run)
    .then(
      () => null,
      (error) => (error instanceof AddressError ? error.problem : `other:${String(error)}`),
    );
}

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e',
  ])('allows the public address %s', (ip) => expect(isPublicAddress(ip)).toBe(true));

  it.each([
    '0.0.0.0', '10.0.0.5', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.10',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', '192.0.2.1',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
  ])('refuses the private, loopback or reserved address %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it('refuses anything that is not an address', () => {
    expect(isPublicAddress('lm.example.com')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });
});

describe('parsePublicHttpsUrl', () => {
  it('accepts an https name, with a port and a path', () => {
    expect(parsePublicHttpsUrl('https://lm.example.com').hostname).toBe('lm.example.com');
    expect(parsePublicHttpsUrl('  https://random-words.trycloudflare.com:8443/v1 ').port).toBe('8443');
  });

  it.each([
    ['http://lm.example.com', 'not-https'],
    ['ftp://lm.example.com', 'not-https'],
    ['lm.example.com', 'not-https'],
    ['', 'not-https'],
    ['https://user:pass@lm.example.com', 'credentials'],
    ['https://127.0.0.1', 'not-a-name'],
    ['https://127.1', 'not-a-name'],
    ['https://2130706433', 'not-a-name'],
    ['https://0x7f.0.0.1', 'not-a-name'],
    ['https://[::1]', 'not-a-name'],
    ['https://[::ffff:7f00:1]', 'not-a-name'],
    ['https://8.8.8.8', 'not-a-name'],
    ['https://localhost', 'not-a-name'],
    ['https://app.localhost', 'not-a-name'],
    ['https://intranet', 'not-a-name'],
  ])('refuses %s', async (raw, expected) => {
    expect(await problem(() => parsePublicHttpsUrl(raw))).toBe(expected);
  });
});

describe('checkPublicHttpsUrl', () => {
  beforeEach(() => lookupMock.mockReset());

  it('returns the one address the connection will go to', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const checked = await checkPublicHttpsUrl('https://lm.example.com/v1/models');
    expect(checked.address).toBe('93.184.216.34');
    expect(checked.family).toBe(4);
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a name that resolves to a private address', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.1.20', family: 4 }]);
    expect(await problem(() => checkPublicHttpsUrl('https://nas.example.com'))).toBe('private');
  });

  it('refuses a name when even one of its addresses is private', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]);
    expect(await problem(() => checkPublicHttpsUrl('https://rebind.example.com'))).toBe('private');
  });

  it('refuses a name that resolves to the cloud metadata address, loopback or an IPv6 loopback', async () => {
    for (const address of ['169.254.169.254', '127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      lookupMock.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
      expect(await problem(() => checkPublicHttpsUrl('https://sneaky.example.com'))).toBe('private');
    }
  });

  it('says a name that does not exist does not exist', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await problem(() => checkPublicHttpsUrl('https://nope.example.com'))).toBe('unresolved');
    lookupMock.mockResolvedValue([]);
    expect(await problem(() => checkPublicHttpsUrl('https://nope.example.com'))).toBe('unresolved');
  });

  it('never looks anything up for an address that is already refused', async () => {
    await problem(() => checkPublicHttpsUrl('https://127.0.0.1'));
    await problem(() => checkPublicHttpsUrl('http://lm.example.com'));
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe('safeGet', () => {
  type RequestOptions = { hostname: string; servername: string; lookup: (host: string, options: object, callback: (...args: unknown[]) => void) => void; path: string; headers: Record<string, string> };
  let requestSpy: jest.SpyInstance;
  let seen: RequestOptions | null;

  function fakeRequest(respond: (res: EventEmitter & { statusCode?: number }, req: EventEmitter & { destroy: jest.Mock; end: () => void }) => void) {
    requestSpy = jest.spyOn(https, 'request').mockImplementation(((options: RequestOptions, callback: (res: unknown) => void) => {
      seen = options;
      const req = Object.assign(new EventEmitter(), { destroy: jest.fn(), end: () => respond(Object.assign(new EventEmitter(), {}) as never, req) });
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      req.end = () => {
        callback(res);
        respond(res, req);
      };
      return req;
    }) as never);
  }

  const checked = { url: new URL('https://lm.example.com/v1/models'), address: '93.184.216.34', family: 4 as const };
  afterEach(() => requestSpy?.mockRestore());

  it('connects to the address that was checked, with the name for the certificate, and never looks the name up again', async () => {
    fakeRequest((res) => {
      res.emit('data', Buffer.from('{"data":[]}'));
      res.emit('end');
    });
    const result = await safeGet(checked, { headers: { Authorization: 'Bearer x' } });
    expect(result).toEqual({ ok: true, status: 200, body: '{"data":[]}' });
    expect(seen?.hostname).toBe('lm.example.com');
    expect(seen?.servername).toBe('lm.example.com');
    expect(seen?.path).toBe('/v1/models');
    expect(seen?.headers.Authorization).toBe('Bearer x');
    const single = jest.fn();
    seen!.lookup('lm.example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const all = jest.fn();
    seen!.lookup('lm.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
  });

  it('hands a redirect back as it is and follows nothing', async () => {
    fakeRequest((res) => {
      (res as { statusCode?: number }).statusCode = 302;
      res.emit('end');
    });
    const result = await safeGet(checked);
    expect(result).toMatchObject({ ok: true, status: 302 });
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('stops reading an answer that is too large', async () => {
    let destroyed: jest.Mock | undefined;
    fakeRequest((res, req) => {
      destroyed = req.destroy;
      res.emit('data', Buffer.alloc(600));
      res.emit('data', Buffer.alloc(600));
    });
    expect(await safeGet(checked, { maxBytes: 1000 })).toEqual({ ok: false, reason: 'too-large' });
    expect(destroyed).toHaveBeenCalled();
  });

  it('gives up when nothing answers in time', async () => {
    jest.useFakeTimers();
    requestSpy = jest.spyOn(https, 'request').mockImplementation((() => Object.assign(new EventEmitter(), { destroy: jest.fn(), end: jest.fn() })) as never);
    const pending = safeGet(checked, { timeoutMs: 5000 });
    jest.advanceTimersByTime(5001);
    expect(await pending).toEqual({ ok: false, reason: 'timeout' });
    jest.useRealTimers();
  });

  it('says unreachable when the connection fails', async () => {
    requestSpy = jest.spyOn(https, 'request').mockImplementation((() => {
      const req = Object.assign(new EventEmitter(), { destroy: jest.fn(), end: () => req.emit('error', new Error('ECONNREFUSED')) });
      return req;
    }) as never);
    expect(await safeGet(checked)).toEqual({ ok: false, reason: 'unreachable' });
  });
});
