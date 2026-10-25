import { Eye, TriangleAlert, Wrench } from 'lucide-react';

export type ModelCapFacts = { tools?: boolean; vision?: boolean };

/**
 * What a model can do, from what its provider says: Tools and Vision with an icon each (no box), or "No tools" in amber
 * when the provider says it can't. Nothing when the provider says nothing. `skip` leaves out what the list already said once.
 */
export function ModelCaps({ facts, skip = {} }: { facts: ModelCapFacts | undefined; skip?: { tools?: boolean; vision?: boolean } }) {
  const item = 'inline-flex items-center gap-1';
  const parts = [
    !skip.tools && facts?.tools === true && <span key="t" className={item}><Wrench size={13} aria-hidden="true" />Tools</span>,
    !skip.tools && facts?.tools === false && <span key="n" className={`${item} text-[#F5C451]`}><TriangleAlert size={13} aria-hidden="true" />No tools</span>,
    !skip.vision && facts?.vision === true && <span key="v" className={item}><Eye size={13} aria-hidden="true" />Vision</span>,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{parts}</span>;
}

/** What every model in a list has, said once above the list instead of on each row: "All 5 Claude models have Vision." */
export function sharedCaps(models: string[], facts: Record<string, ModelCapFacts>): { tools: boolean; vision: boolean } {
  const every = (key: 'tools' | 'vision') => models.length > 1 && models.every((id) => facts[id]?.[key] === true);
  return { tools: every('tools'), vision: every('vision') };
}
