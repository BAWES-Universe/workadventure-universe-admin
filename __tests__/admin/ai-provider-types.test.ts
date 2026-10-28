import { PROVIDER_TYPES, providerTypeLabel, providerTypeOptions } from '@/app/admin/ai-providers/components/provider-state';

/** The super-admin provider form offers only the types the bot server speaks (#704). */
describe('AI provider types', () => {
  it('offers LM Studio, OpenAI and Anthropic, and no voice types', () => {
    expect(PROVIDER_TYPES.map((type) => type.value)).toEqual(['lmstudio', 'openai', 'anthropic']);
    expect(PROVIDER_TYPES.map((type) => type.label)).toEqual(['LMStudio', 'OpenAI', 'Anthropic']);
  });

  it('keeps the same list on the edit page for a row of an offered type', () => {
    expect(providerTypeOptions('openai')).toEqual(PROVIDER_TYPES);
    expect(providerTypeOptions(undefined)).toEqual(PROVIDER_TYPES);
  });

  it('keeps a saved Ultravox or GPT Voice row showing its own type on the edit page', () => {
    expect(providerTypeOptions('ultravox').map((type) => type.value)).toEqual(['lmstudio', 'openai', 'anthropic', 'ultravox']);
    expect(providerTypeOptions('gpt-voice').at(-1)).toEqual({ value: 'gpt-voice', label: 'GPT Voice' });
  });

  it('still names the old types where saved rows are listed', () => {
    expect(providerTypeLabel('ultravox')).toBe('Ultravox');
    expect(providerTypeLabel('gpt-voice')).toBe('GPT Voice');
  });
});
