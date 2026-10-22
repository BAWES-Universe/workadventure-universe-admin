/**
 * The catalog of AI key kinds (#374): the seven that exist keep behaving exactly as before, now as data. These rows are
 * the no-regression list for the move from if-statements to catalog fields.
 */
import { AI_KEY_KINDS, authHeaders, isTypedEndpoint, kindInfo, typedEndpoint, writeModelId } from '@/lib/ai-key-kinds';
import { cleanModelIds, keyTarget } from '@/lib/ai-key-models';

describe('the seven kinds, exactly as they were', () => {
  const row = (kind: string) => {
    const info = kindInfo(kind)!;
    return { providerType: info.providerType, group: info.group, address: info.address, apiKey: info.apiKey, base: info.base, tokenLimitField: info.tokenLimitField };
  };

  it('keeps the same ids, in the same order', () => {
    expect(AI_KEY_KINDS.map((entry) => entry.kind)).toEqual(['lmstudio', 'ollama', 'openrouter', 'gemini', 'nim', 'openai', 'deepseek']);
  });

  it.each([
    ['lmstudio', { providerType: 'lmstudio', group: 'own-computer', address: 'required', apiKey: 'optional' }],
    ['ollama', { providerType: 'lmstudio', group: 'own-computer', address: 'required', apiKey: 'optional' }],
    ['openrouter', { providerType: 'openai', group: 'hosted', address: 'none', apiKey: 'required', base: 'https://openrouter.ai/api/v1' }],
    ['gemini', { providerType: 'openai', group: 'hosted', address: 'none', apiKey: 'required', base: 'https://generativelanguage.googleapis.com/v1beta/openai' }],
    ['nim', { providerType: 'openai', group: 'hosted', address: 'optional', apiKey: 'required', base: 'https://integrate.api.nvidia.com/v1' }],
    ['openai', { providerType: 'openai', group: 'hosted', address: 'none', apiKey: 'required', base: 'https://api.openai.com/v1', tokenLimitField: 'max_completion_tokens' }],
    ['deepseek', { providerType: 'openai', group: 'hosted', address: 'none', apiKey: 'required', base: 'https://api.deepseek.com' }],
  ])('%s keeps how it is reached', (kind, expected) => {
    expect(row(kind)).toMatchObject(expected);
  });

  it('gives every kind the OpenAI chat format, a Bearer key, and the default key check, apart from OpenRouter', () => {
    for (const info of AI_KEY_KINDS) {
      expect(info.protocol).toBe('openai');
      expect(info.auth).toBe('bearer');
      expect(info.keyCheck).toEqual(info.kind === 'openrouter' ? { type: 'key-info', paths: ['/key', '/auth/key'] } : { type: 'models' });
    }
  });
});

describe('the three provider quirks are catalog fields', () => {
  it('NVIDIA NIM saves a typed address with /v1, and every other kind saves just the address', () => {
    expect(keyTarget({ kind: 'nim', address: 'https://nim.example.com/anything' })).toMatchObject({ ok: true, target: { endpoint: 'https://nim.example.com/v1', modelsUrl: 'https://nim.example.com/v1/models' } });
    expect(keyTarget({ kind: 'lmstudio', address: 'https://lm.example.com/v1' })).toMatchObject({ ok: true, target: { endpoint: 'https://lm.example.com', modelsUrl: 'https://lm.example.com/v1/models' } });
    expect(keyTarget({ kind: 'nim', address: '' })).toMatchObject({ ok: true, target: { endpoint: 'https://integrate.api.nvidia.com/v1', modelsUrl: 'https://integrate.api.nvidia.com/v1/models' } });
    expect(typedEndpoint(kindInfo('nim')!, 'https://x.example')).toBe('https://x.example/v1');
    expect(typedEndpoint(kindInfo('ollama')!, 'https://x.example')).toBe('https://x.example');
  });

  it('Gemini model ids lose their models/ prefix, and no other kind’s do', () => {
    expect(writeModelId('models/gemini-flash-latest', 'gemini')).toBe('gemini-flash-latest');
    expect(writeModelId('models/gemini-flash-latest', 'openrouter')).toBe('models/gemini-flash-latest');
    expect(writeModelId('  gpt-4.1 ', 'openai')).toBe('gpt-4.1');
    expect(writeModelId('models/x', 'not-a-kind')).toBe('models/x');
    expect(cleanModelIds(['models/gemini-b', 'models/gemini-a', 'gemini-a'], 'gemini')).toEqual(['gemini-a', 'gemini-b']);
  });

  it('OpenRouter alone has key-info paths; no other kind asks anything but the model list', () => {
    expect(AI_KEY_KINDS.filter((info) => info.keyCheck.type === 'key-info').map((info) => info.kind)).toEqual(['openrouter']);
  });
});

describe('helpers', () => {
  it('sends a key as a Bearer header, and nothing when there is none', () => {
    expect(authHeaders(kindInfo('openai')!, 'sk-1')).toEqual({ Authorization: 'Bearer sk-1' });
    expect(authHeaders(kindInfo('lmstudio')!, '')).toEqual({});
  });

  it('knows a typed address from the provider’s own', () => {
    const nim = kindInfo('nim')!;
    expect(isTypedEndpoint(nim, 'https://integrate.api.nvidia.com/v1')).toBe(false);
    expect(isTypedEndpoint(nim, 'https://mine.example.com/v1')).toBe(true);
    expect(isTypedEndpoint(kindInfo('deepseek')!, 'https://api.deepseek.com')).toBe(false);
    expect(isTypedEndpoint(kindInfo('lmstudio')!, 'https://api.deepseek.com')).toBe(true);
    expect(isTypedEndpoint(null, null)).toBe(true);
  });
});
