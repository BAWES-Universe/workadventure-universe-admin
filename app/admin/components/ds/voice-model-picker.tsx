'use client';

import type { VoiceModel } from '@/lib/voice-providers';
import { lendModelId } from '@/lib/voice-lend-model';
import { Tick } from './model-picker';

const GROUPS = [
  { kind: 'recognition', title: 'Listens' },
  { kind: 'speech', title: 'Speaks' },
] as const;

/**
 * A voice key's models under Listens and Speaks (#749). `browse` lists them; `many` ticks the ones a lend allows, each named as
 * "kind:id" so a listening and a speaking model with one id are told apart.
 */
export function VoiceModelPicker({
  models,
  mode,
  picked = [],
  onChange,
  label,
}: {
  models: VoiceModel[];
  mode: 'browse' | 'many';
  picked?: string[];
  onChange?: (picked: string[]) => void;
  label: string;
}) {
  const on = new Set(picked);
  function toggle(id: string) {
    if (!onChange) return;
    onChange(on.has(id) ? picked.filter((entry) => entry !== id) : [...picked, id]);
  }
  return (
    <div className="grid gap-3" role="group" aria-label={label} data-testid="voice-model-picker">
      {GROUPS.map(({ kind, title }) => {
        const list = models.filter((model) => model.kind === kind);
        if (list.length === 0) return null;
        return (
          <div key={kind} className="grid gap-1.5" data-testid={`voice-models-${kind}`}>
            <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</h4>
            <div className="grid gap-1.5">
              {list.map((model) => {
                const id = lendModelId(model);
                const picked = on.has(id);
                const text = model.label || model.id;
                return mode === 'browse' ? (
                  <div key={id} className="min-h-11 rounded-xl px-3 py-2.5 text-sm font-medium [overflow-wrap:anywhere]" data-testid="model-row">
                    {text}
                  </div>
                ) : (
                  <button
                    key={id}
                    type="button"
                    role="checkbox"
                    aria-checked={picked}
                    onClick={() => toggle(id)}
                    data-picked={picked}
                    className={`flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
                      picked ? 'border-[rgba(167,139,250,.7)] bg-[rgba(134,41,252,.14)] font-bold' : 'border-transparent hover:border-foreground/15'
                    }`}
                    data-testid="model-row"
                  >
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{text}</span>
                    <Tick on={picked} />
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
