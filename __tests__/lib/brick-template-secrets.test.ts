import { blocksSharing, findInText } from '@/lib/brick-template-secrets';

const kinds = (text: string) => findInText(text, 'instructions').map((finding) => `${finding.kind}:${finding.what}`);

describe('the secret check of the look before sharing', () => {
  it('finds keys, tokens and passwords the way people paste them', () => {
    expect(kinds('use sk-proj-abcdefghijklmnopqrstuvwxyz123456 for the API')).toEqual(['secret:an AI or API key']);
    expect(kinds('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 works')).toEqual(['secret:a GitHub token']);
    expect(kinds('-----BEGIN RSA PRIVATE KEY-----')).toEqual(['secret:a private key']);
    // Built in two pieces so no fake key sits in the file for push protection to flag
    expect(kinds(`keys ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`)).toEqual(['secret:an AWS key']);
    expect(kinds('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).toEqual(['secret:a bearer token']);
    expect(kinds('connect to postgres://admin:hunter2pass@db.example.com/app')).toEqual(['secret:a link with a password in it']);
    expect(kinds('the password is Summer2026!x')).toEqual(['secret:a password or key written out']);
    expect(kinds('api key: abcd1234efgh5678')).toEqual(['secret:a password or key written out']);
    // Written as an assignment, a password needs no digit
    expect(kinds('password: correct-horse-battery-staple')).toEqual(['secret:a password or key written out']);
    expect(kinds('secret = correcthorsebatterystaple')).toEqual(['secret:a password or key written out']);
    expect(kinds('xoxb-123456789012-abcdefghij')).toEqual(['secret:a Slack token']);
    expect(kinds('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toEqual(['secret:a sign-in token']);
  });

  it('still finds a long mixed key that is not part of a link path', () => {
    expect(kinds('the key is Ab3dEf6hIj9lMn2pQr5tUv8xYz1BcDe4FgHi7Jk0')).toEqual(['secret:a long key-like string']);
  });

  it('says a secret once, under its most specific name', () => {
    const found = findInText('sk-proj-abcdefghijklmnopqrstuvwxyz123456abcdefghij', 'instructions');
    expect(found).toHaveLength(1);
    expect(found[0].what).toBe('an AI or API key');
  });

  it('shows where it was and the first characters only, never the whole value', () => {
    const [finding] = findInText('use sk-proj-abcdefghijklmnopqrstuvwxyz123456 now', 'routine 2');
    expect(finding).toEqual({ kind: 'secret', where: 'routine 2', what: 'an AI or API key', sample: 'sk-pro…' });
    expect(JSON.stringify(finding)).not.toContain('abcdefghijklmnop');
  });

  it('leaves ordinary instructions alone', () => {
    expect(kinds('You keep my family recipes. Ask me which one I want, then send it. The password is something I give you each time.')).toEqual([]);
    expect(kinds('Check https://example.com/recipes/pasta-with-tomato-sauce-and-basil every morning')).toEqual([]);
    expect(kinds('Check https://example.com/recipes/ChickenAndVegetableSoupForFamilyDinner2026 every morning')).toEqual([]);
    expect(kinds('Be brief and kind. Reply in English.')).toEqual([]);
    expect(findInText('', 'x')).toEqual([]);
    expect(findInText(null, 'x')).toEqual([]);
  });

  it('warns about an email address or a phone number without blocking', () => {
    const found = findInText('write to sara@example.com or call +965 5555 1234', 'instructions');
    expect(found.map((finding) => `${finding.kind}:${finding.what}`)).toEqual(['detail:an email address', 'detail:a phone number']);
    expect(blocksSharing(found)).toBe(false);
  });

  it('finds a phone number at the end of a sentence', () => {
    expect(kinds('For the shop call +965 5555 1234.')).toEqual(['detail:a phone number']);
  });

  it('blocks sharing only when a secret was found', () => {
    expect(blocksSharing([])).toBe(false);
    expect(blocksSharing(findInText('password: Summer2026!x', 'instructions'))).toBe(true);
  });
});
