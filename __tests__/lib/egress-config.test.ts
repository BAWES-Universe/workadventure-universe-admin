import { applyCommand, egressConfig, egressProblem, hostsBlockNames, keyFor, networkFor, sameNetwork } from '@/lib/egress/config';
import { verifyEgressKey } from '@/lib/egress/policy';

const SECRET = 'a-gateway-secret-of-at-least-24-characters';
const env = (over: Record<string, string | undefined>) => ({ EGRESS_GATEWAY_SECRET: SECRET, EGRESS_GATEWAYS: '5.78.10.20:3128', ...over }) as unknown as NodeJS.ProcessEnv;

describe('the gateways a computer may reach', () => {
  it('reads public addresses with a port (3128 when none) and names on 443, once each', () => {
    expect(egressConfig(env({ EGRESS_GATEWAYS: '5.78.10.20:3128, 95.216.3.4 ,5.78.10.20:3128,gw.example.com:443' }))).toEqual({
      gateways: [
        { host: '5.78.10.20', port: 3128 },
        { host: '95.216.3.4', port: 3128 },
        { host: 'gw.example.com', port: 443 },
      ],
      secret: SECRET,
    });
  });

  it('is null (so nothing is made) without a long enough secret or without gateways', () => {
    expect(egressConfig(env({ EGRESS_GATEWAY_SECRET: 'short' }))).toBeNull();
    expect(egressConfig(env({ EGRESS_GATEWAY_SECRET: undefined }))).toBeNull();
    expect(egressConfig(env({ EGRESS_GATEWAYS: '' }))).toBeNull();
    expect(egressConfig(env({ EGRESS_GATEWAYS: undefined }))).toBeNull();
    expect(egressProblem(env({ EGRESS_GATEWAY_SECRET: 'short' }))).toContain('EGRESS_GATEWAY_SECRET');
    expect(egressProblem(env({ EGRESS_GATEWAYS: '' }))).toContain('EGRESS_GATEWAYS');
    expect(egressProblem(env({}))).toBeNull();
  });

  it('refuses the whole setting when one entry is wrong, so a typo is never half applied', () => {
    for (const bad of ['5.78.10.20:3128,10.0.0.5:3128', '5.78.10.20:0', '5.78.10.20:70000', '[2001:db8::1]:3128', 'gw.example.com:3128', '127.0.0.1:3128', '169.254.169.254:80', 'a,b,c,d,e,f,g,h,i']) {
      expect(egressConfig(env({ EGRESS_GATEWAYS: bad }))).toBeNull();
    }
  });

  it('writes the rule as the gateways’ addresses and nothing else, and recognises it as Agent37 keeps it (a bare address as /32, names in lower case)', () => {
    const config = egressConfig(env({ EGRESS_GATEWAYS: '5.78.10.20:3128,5.78.10.20:8080,GW.Example.com:443' }))!;
    const wanted = networkFor(config);
    expect(wanted).toEqual({ allow: ['5.78.10.20', 'gw.example.com'] });
    expect(sameNetwork({ allow: ['5.78.10.20/32', 'gw.example.com'] } as never, wanted)).toBe(true);
    expect(sameNetwork({ allow: ['gw.example.com', '5.78.10.20'] } as never, wanted)).toBe(true);
    expect(sameNetwork('allow-all' as never, wanted)).toBe(false);
    expect(sameNetwork('deny-all' as never, wanted)).toBe(false);
    expect(sameNetwork(undefined, wanted)).toBe(false);
    expect(sameNetwork({ allow: ['5.78.10.20/32'] } as never, wanted)).toBe(false);
    expect(sameNetwork({ allow: ['5.78.10.20/32', 'gw.example.com', '1.1.1.1'] } as never, wanted)).toBe(false);
    expect(sameNetwork({ allow: ['0.0.0.0/0'] } as never, wanted)).toBe(false);
  });

  it('makes a key for one computer that the gateway accepts and that lasts days, not forever', () => {
    const config = egressConfig(env({}))!;
    const now = Date.UTC(2026, 10, 17);
    const key = keyFor(config, 'machine-1', now);
    expect(verifyEgressKey(SECRET, key.user, key.pass, now + 60_000)).toEqual({ ok: true, machine: 'machine-1' });
    expect(verifyEgressKey(SECRET, key.user, key.pass, now + 5 * 86_400_000)).toEqual({ ok: false });
    expect(verifyEgressKey('another-secret-another-secret-12345', key.user, key.pass, now)).toEqual({ ok: false });
  });

  it('builds the command that puts the settings on a computer: the secret never travels, only that computer’s key', () => {
    const config = egressConfig(env({}))!;
    const command = applyCommand(config, 'machine-1', ['composio.dev', 'bad name; rm -rf /'], Date.UTC(2026, 10, 17));
    expect(command.startsWith('universe-egress apply composio.dev <<\'EGRESS_JSON\'\n')).toBe(true);
    expect(command).not.toContain(SECRET);
    expect(command).not.toContain('rm -rf');
    const body = JSON.parse(command.split('\n')[1]);
    expect(body).toMatchObject({ gateways: ['5.78.10.20:3128'], user: 'machine-1' });
    expect(command.trimEnd().endsWith('EGRESS_JSON')).toBe(true);
  });

  it('keeps Composio and the Universe AI names out of the computer’s hosts file as an extra layer, only whole names', () => {
    const names = hostsBlockNames(['api.openai.com', 'OpenRouter.ai', '10.0.0.1', 'not a name', 'api.openai.com']);
    expect(names).toEqual(expect.arrayContaining(['composio.dev', 'backend.composio.dev', 'api.openai.com', 'openrouter.ai']));
    expect(names).not.toContain('10.0.0.1');
    expect(names.every((name) => /^[a-z0-9.-]+$/.test(name))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});
