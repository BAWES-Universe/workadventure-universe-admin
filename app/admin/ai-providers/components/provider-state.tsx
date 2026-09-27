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
