/** On or off, for a provider or a bot: a neutral outline pill, a green dot only when it's on. */
export function EnabledPill({ enabled }: { enabled: boolean }) {
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-foreground/15 px-2.5 text-[11px] font-semibold text-foreground/85">
      <i
        aria-hidden="true"
        className={enabled ? 'h-1.5 w-1.5 rounded-full bg-green-500' : 'h-1.5 w-1.5 rounded-full bg-muted-foreground/50'}
      />
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

export const PROVIDER_TYPE_LABEL: Record<string, string> = {
  lmstudio: 'LMStudio',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ultravox: 'Ultravox',
  'gpt-voice': 'GPT Voice',
};

export function providerTypeLabel(type: string): string {
  return PROVIDER_TYPE_LABEL[type] ?? type;
}

/** The types a new provider can be: the ones the bot server speaks. Ultravox and GPT Voice are left out until it does (#704). */
export const PROVIDER_TYPES = ['lmstudio', 'openai', 'anthropic'].map((value) => ({ value, label: providerTypeLabel(value) }));

/** The types on the edit page: a saved row of a type no longer offered keeps showing it, so it can still be edited or deleted. */
export function providerTypeOptions(current?: string): { value: string; label: string }[] {
  if (!current || PROVIDER_TYPES.some((type) => type.value === current)) return PROVIDER_TYPES;
  return [...PROVIDER_TYPES, { value: current, label: providerTypeLabel(current) }];
}
