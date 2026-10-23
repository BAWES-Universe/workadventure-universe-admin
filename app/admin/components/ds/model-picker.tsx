'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronDown, Eye, Wrench } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { PickChip } from '@/components/ui/choice';
import { ProviderLogo } from './provider-logo';
import { ModelCaps, sharedCaps, type ModelCapFacts } from './model-caps';

/** Makers whose ids carry a prefix ("openai/gpt-5-mini") or a known start ("claude-"), with their name and mark. */
const MAKERS: { match: RegExp; key: string; label: string; logo?: string }[] = [
  { match: /^(anthropic\/|claude)/, key: 'anthropic', label: 'Anthropic', logo: 'anthropic' },
  { match: /^(openai\/|gpt-|o\d|chatgpt)/, key: 'openai', label: 'OpenAI', logo: 'openai' },
  { match: /^(google\/|gemini|gemma)/, key: 'google', label: 'Google', logo: 'google' },
  { match: /^(deepseek)/, key: 'deepseek', label: 'DeepSeek', logo: 'deepseek' },
  { match: /^(meta-llama\/|llama)/, key: 'meta-llama', label: 'Meta', logo: 'llama' },
  { match: /^(mistralai\/|mistral|codestral|magistral|devstral|ministral)/, key: 'mistralai', label: 'Mistral', logo: 'mistral' },
  { match: /^(qwen)/, key: 'qwen', label: 'Qwen', logo: 'alibaba' },
  { match: /^(moonshotai\/|kimi)/, key: 'moonshotai', label: 'Moonshot AI', logo: 'moonshotai' },
  { match: /^(x-ai\/|grok)/, key: 'x-ai', label: 'xAI', logo: 'xai' },
  { match: /^(z-ai\/|glm)/, key: 'z-ai', label: 'Z.ai', logo: 'zai' },
  { match: /^(nvidia\/)/, key: 'nvidia', label: 'NVIDIA', logo: 'nvidia' },
  { match: /^(xiaomi\/|mimo)/, key: 'xiaomi', label: 'Xiaomi', logo: 'xiaomi' },
  { match: /^(minimax\/)/, key: 'minimax', label: 'MiniMax' },
  { match: /^(cohere\/)/, key: 'cohere', label: 'Cohere' },
  { match: /^(amazon\/)/, key: 'amazon', label: 'Amazon' },
  { match: /^(microsoft\/)/, key: 'microsoft', label: 'Microsoft' },
  { match: /^(perplexity\/)/, key: 'perplexity', label: 'Perplexity' },
  { match: /^(nousresearch\/)/, key: 'nousresearch', label: 'Nous Research' },
  { match: /^(baidu\/)/, key: 'baidu', label: 'Baidu' },
  { match: /^(ibm-granite\/)/, key: 'ibm-granite', label: 'IBM' },
  { match: /^(openrouter\/)/, key: 'openrouter', label: 'OpenRouter', logo: 'openrouter' },
  { match: /^(arcee-ai\/)/, key: 'arcee-ai', label: 'Arcee AI' },
  { match: /^(ai21\/)/, key: 'ai21', label: 'AI21' },
  { match: /^(stepfun-ai\/)/, key: 'stepfun-ai', label: 'StepFun' },
  { match: /^(sao10k\/)/, key: 'sao10k', label: 'Sao10K' },
  { match: /^(thedrummer\/)/, key: 'thedrummer', label: 'TheDrummer' },
  { match: /^(bytedance\/)/, key: 'bytedance', label: 'ByteDance' },
  { match: /^(liquid\/)/, key: 'liquid', label: 'Liquid AI' },
];

type Maker = { key: string; label: string; logo?: string };

/** Who made a model, from its id: the part before "/" on OpenRouter-style ids, or a known start. */
export function makerOf(id: string): Maker {
  const known = MAKERS.find((maker) => maker.match.test(id.toLowerCase()));
  if (known) return known;
  const prefix = id.includes('/') ? id.split('/')[0] : '';
  if (!prefix) return { key: '', label: 'Other' };
  return { key: prefix, label: prefix.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) };
}

/** The id without its maker's prefix: "openai/gpt-5-mini" shows as "gpt-5-mini" under OpenAI. */
const shortId = (id: string) => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);

/** A tick box drawn inside a row that is itself the checkbox (the row is the 44px target). */
function Tick({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" data-checked={on} className="grid h-5 w-5 shrink-0 place-content-center rounded-[6px] border-2 border-foreground/30 text-white data-[checked=true]:border-transparent data-[checked=true]:bg-[image:var(--brand-gradient)]">
      {on && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
    </span>
  );
}

/** More models than this and the makers start folded: open one, or search, to see its models. */
const FOLD_FROM = 24;
/** Folded makers past this many wait behind "Show all makers", biggest first. */
const MAKERS_SHOWN = 8;

/**
 * A key's models, for any size of list: search, Tools and Vision filters, and one group per maker when there is more
 * than one maker (OpenRouter's hundreds fold into a few dozen makers). `mode` says what a row does: nothing ("browse"),
 * tick on and off ("many", for the models a universe may use), or pick one ("one", for a bot's model).
 */
export function ModelPicker({
  models,
  facts,
  mode,
  picked = [],
  onChange,
  label,
  open: openFirst = [],
}: {
  models: string[];
  facts: Record<string, ModelCapFacts>;
  mode: 'browse' | 'many' | 'one';
  picked?: string[];
  onChange?: (picked: string[]) => void;
  label: string;
  /** Makers shown open at first. */
  open?: string[];
}) {
  const [find, setFind] = useState('');
  const [tools, setTools] = useState(false);
  const [vision, setVision] = useState(false);
  const [opened, setOpened] = useState<Set<string>>(new Set(openFirst));
  const [allMakers, setAllMakers] = useState(false);
  const shared = sharedCaps(models, facts);
  const hasTools = !shared.tools && models.some((id) => facts[id]?.tools === true);
  const hasVision = !shared.vision && models.some((id) => facts[id]?.vision === true);
  const needle = find.trim().toLowerCase();
  const filtering = needle !== '' || tools || vision;

  const groups = useMemo(() => {
    const byMaker = new Map<string, { maker: Maker; ids: string[] }>();
    for (const id of models) {
      if (needle && !id.toLowerCase().includes(needle)) continue;
      if (tools && facts[id]?.tools !== true) continue;
      if (vision && facts[id]?.vision !== true) continue;
      const maker = makerOf(id);
      const group = byMaker.get(maker.key) ?? { maker, ids: [] };
      group.ids.push(id);
      byMaker.set(maker.key, group);
    }
    return [...byMaker.values()].sort((a, b) => b.ids.length - a.ids.length || a.maker.label.localeCompare(b.maker.label));
  }, [models, facts, needle, tools, vision]);

  const makers = new Set(models.map((id) => makerOf(id).key)).size;
  const grouped = makers > 1;
  const shown = groups.reduce((total, group) => total + group.ids.length, 0);
  // Folded only while the list is long: a search or filter that leaves a few models shows them all
  const folded = grouped && shown > FOLD_FROM;
  const pickedSet = new Set(picked);

  function toggle(id: string) {
    if (!onChange) return;
    if (mode === 'one') onChange([id]);
    else onChange(pickedSet.has(id) ? picked.filter((entry) => entry !== id) : [...picked, id]);
  }

  function row(id: string, groupShared = { tools: false, vision: false }) {
    const on = pickedSet.has(id);
    const title = grouped ? shortId(id) : id;
    const caps = <ModelCaps facts={facts[id]} skip={{ tools: shared.tools || groupShared.tools, vision: shared.vision || groupShared.vision }} />;
    if (mode === 'browse') {
      return (
        <div key={id} className="min-h-11 rounded-xl px-3 py-2.5 text-sm [overflow-wrap:anywhere]" data-testid="model-row">
          <span className="font-medium">{title}</span>
          {caps}
        </div>
      );
    }
    return (
      <button
        key={id}
        type="button"
        role={mode === 'one' ? 'radio' : 'checkbox'}
        aria-checked={on}
        onClick={() => toggle(id)}
        data-picked={on}
        className={`flex min-h-11 w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors ${
          on ? 'border-[rgba(167,139,250,.7)] bg-[rgba(134,41,252,.14)] font-bold' : 'border-transparent hover:border-foreground/15'
        }`}
        data-testid="model-row"
      >
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {title}
          {caps}
        </span>
        {mode === 'many' && <Tick on={on} />}
      </button>
    );
  }

  return (
    <div className="grid gap-3" data-testid="model-picker">
      {models.length > 8 && (
        <Input type="search" aria-label={`Search ${label}`} placeholder={grouped ? `Search ${models.length} models or makers` : `Search ${models.length} models`} value={find} onChange={(event) => setFind(event.target.value)} className="h-11 rounded-xl" />
      )}
      {(hasTools || hasVision) && (
        <div className="flex flex-wrap gap-2" aria-label="Show only models with">
          {hasTools && (
            <PickChip picked={tools} onClick={() => setTools((on) => !on)}>
              {!tools && <Wrench size={15} aria-hidden="true" />}
              Tools
            </PickChip>
          )}
          {hasVision && (
            <PickChip picked={vision} onClick={() => setVision((on) => !on)}>
              {!vision && <Eye size={15} aria-hidden="true" />}
              Vision
            </PickChip>
          )}
        </div>
      )}
      {(shared.tools || shared.vision) && (
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground [&>span]:mt-0 [&>span]:text-sm">
          All {models.length} have <ModelCaps facts={{ tools: shared.tools || undefined, vision: shared.vision || undefined }} />
        </p>
      )}
      {filtering && <p className="text-[13px] text-muted-foreground">{shown === 0 ? 'No model matches that.' : `${shown} ${shown === 1 ? 'model' : 'models'}${grouped ? ` from ${groups.length} ${groups.length === 1 ? 'maker' : 'makers'}` : ''}`}</p>}
      {mode === 'many' && picked.length > 0 && (
        <p className="text-[13px] text-muted-foreground" data-testid="picked-count">
          {picked.length} picked: {picked.map(shortId).join(', ')}
        </p>
      )}
      <div role={mode === 'one' ? 'radiogroup' : 'group'} aria-label={label} className="grid gap-1.5">
        {!grouped && groups[0]?.ids.map((id) => row(id))}
        {grouped &&
          groups.filter((group, index) => !folded || allMakers || filtering || index < MAKERS_SHOWN || group.ids.some((id) => pickedSet.has(id))).map(({ maker, ids }) => {
            const isOpen = !folded || opened.has(maker.key);
            const pickedHere = ids.filter((id) => pickedSet.has(id)).length;
            // What every model of this maker has is said once, on the maker's row
            const groupShared = sharedCaps(ids, facts);
            return (
              <div key={maker.key} className={`rounded-2xl border ${isOpen && folded ? 'border-foreground/10 bg-foreground/[.03]' : 'border-transparent'}`}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  disabled={!folded}
                  onClick={() => setOpened((now) => { const next = new Set(now); if (next.has(maker.key)) next.delete(maker.key); else next.add(maker.key); return next; })}
                  className="flex min-h-11 w-full items-center gap-3 rounded-2xl px-2 py-1.5 text-left disabled:cursor-default"
                  data-testid="maker-row"
                >
                  <ProviderLogo info={maker.logo ? { logo: maker.logo } : { plainIcon: undefined }} size={22} slot={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{maker.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {ids.length} {ids.length === 1 ? 'model' : 'models'}
                      {pickedHere > 0 && ` · ${pickedHere} picked`}
                    </span>
                    {isOpen && (groupShared.tools || groupShared.vision) && (
                      <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground [&>span]:mt-0">
                        All have <ModelCaps facts={{ tools: (groupShared.tools && !shared.tools) || undefined, vision: (groupShared.vision && !shared.vision) || undefined }} />
                      </span>
                    )}
                  </span>
                  {folded && <ChevronDown size={18} aria-hidden="true" className={`shrink-0 text-muted-foreground transition-transform ${isOpen ? '' : '-rotate-90'}`} />}
                </button>
                {isOpen && <div className="grid gap-1 pb-1.5 pl-[42px] pr-1">{ids.map((id) => row(id, groupShared))}</div>}
              </div>
            );
          })}
        {grouped && folded && !filtering && groups.length > MAKERS_SHOWN && (
          <button type="button" onClick={() => setAllMakers((on) => !on)} className="min-h-11 w-fit rounded-full border border-foreground/15 px-4 text-sm font-semibold" data-testid="all-makers">
            {allMakers ? 'Show fewer makers' : `Show all ${groups.length} makers`}
          </button>
        )}
      </div>
    </div>
  );
}
