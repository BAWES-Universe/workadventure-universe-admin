'use client';

// The parts the Grants sheets share (spec v3 sections 2, 7a and 11): a labelled group, the three-part preview, the "Give credit to…"
// recipients picker and the save helpers. Built only from Orbit's own parts. Nothing here knows an amount: they all come from a super admin.

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PickCard, Radio } from '@/components/ui/choice';
import { WokaAvatar } from '../../components/profile-card';
import { clashLine, previewRows, type AudienceView, type ClashView, type PersonView, type PreviewRequest, type PreviewView, type Recipients, type Seg } from '@/lib/grants-view';

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <h3 className="text-sm font-semibold">{label}</h3>
      {children}
    </div>
  );
}

export const Words = ({ parts }: { parts: Seg[] }) => (
  <>
    {parts.map((part, index) => (typeof part === 'string' ? <Fragment key={index}>{part}</Fragment> : <b key={index}>{part.b}</b>))}
  </>
);

/** The preview before saving: who gets what, the most credit issued, what it can cost us. Three numbers, never one. */
export function Preview({ request, preview, loading }: { request: PreviewRequest; preview: PreviewView | null; loading: boolean }) {
  const rows = preview?.problem ? [['Who gets what', [preview.problem]] as [string, Seg[]]] : previewRows(request, preview?.numbers ?? null);
  return (
    <div className="grid gap-0 overflow-hidden rounded-xl bg-foreground/[.04]" data-testid="grants-preview" aria-busy={loading}>
      {rows.map(([label, text], index) => (
        <div key={`${label}${index}`} className="grid gap-0.5 border-b border-foreground/[.06] px-3.5 py-2.5 last:border-b-0">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
          <span className="text-sm">
            <Words parts={text} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Two group rules that disagree for the same people: said with their names, and the save stays shut until one is chosen. */
export function Clash({ clash, choice, onChoose }: { clash: ClashView; choice: 'this' | 'other' | null; onChoose: (choice: 'this' | 'other') => void }) {
  return (
    <div className="grid gap-2 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3.5 py-3" data-testid="grants-clash">
      <span className="flex items-start gap-2 text-sm">
        <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-amber-300" />
        <span>
          <Words parts={clashLine(clash)} />
        </span>
      </span>
      <div role="radiogroup" aria-label="Which rule applies" className="grid gap-2">
        <PickCard role="radio" picked={choice === 'this'} onClick={() => onChoose('this')} indicator={<Radio checked={choice === 'this'} />} title={`This one, ${clash.thisText}`} />
        <PickCard role="radio" picked={choice === 'other'} onClick={() => onChoose('other')} indicator={<Radio checked={choice === 'other'} />} title={`${clash.other.name}, ${clash.other.text}`} />
      </div>
    </div>
  );
}

export function SheetButtons({ go, disabled, saving, onCancel }: { go: string; disabled?: boolean; saving?: boolean; onCancel: () => void }) {
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" className="h-11 px-5" onClick={onCancel} disabled={saving}>
        Cancel
      </Button>
      <Button type="submit" className="h-11 px-5" disabled={disabled || saving} data-testid="grants-save">
        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
        {go}
      </Button>
    </div>
  );
}

export interface Sent {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
  error: string | null;
}

/** One request to the grants routes. A failure says why in a line a person can read, and never throws. */
export async function sendJson(url: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): Promise<Sent> {
  try {
    const { authenticatedFetch } = await import('@/lib/client-auth');
    const response = await authenticatedFetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data: Record<string, unknown> | null = null;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
    if (response.ok) return { ok: true, status: response.status, data, error: null };
    return { ok: false, status: response.status, data, error: typeof data?.error === 'string' ? data.error : 'That didn’t save. Check your connection and try again.' };
  } catch {
    return { ok: false, status: 0, data: null, error: 'That didn’t save. Check your connection and try again.' };
  }
}

/**
 * The preview for what the sheet shows now. It waits for a pause in typing, and only the latest answer shows: a slower answer to
 * older figures never lands on top of the figures now on the sheet. `null` asks for nothing (the sheet is closed or not ready).
 */
export function usePreview(request: PreviewRequest | null): { preview: PreviewView | null; loading: boolean } {
  // The answer is kept with the request it was for, and shown only while that is the request now made: figures of $5 are not left on screen under $50.
  // Nothing is set while an effect starts: loading is simply "a request is made and its answer is not the one kept".
  const [answer, setAnswer] = useState<{ preview: PreviewView; key: string } | null>(null);
  const latest = useRef(0);
  const key = request ? JSON.stringify(request) : null;
  useEffect(() => {
    const mine = ++latest.current;
    if (!key) return;
    const timer = setTimeout(async () => {
      const result = await sendJson('/api/admin/grants/preview', 'POST', JSON.parse(key));
      if (mine !== latest.current) return;
      if (result.ok && result.data) setAnswer({ preview: result.data as unknown as PreviewView, key });
      else setAnswer({ preview: { numbers: null, clash: null, problem: result.error ?? 'The preview isn’t available right now.' }, key });
    }, 250);
    return () => clearTimeout(timer);
  }, [key]);
  const current = key !== null && answer?.key === key;
  return { preview: current ? answer.preview : null, loading: key !== null && !current };
}

/**
 * Runs `reset` while rendering, once each time one of `deps` changes and `when` holds: state that has to start again with what it is about
 * (a sheet that opens, the rule being edited). It is the way React documents for this, with no effect that sets state and no extra paint
 * of the old values.
 */
export function useResetWhen(when: boolean, deps: readonly unknown[], reset: () => void): void {
  const [seen, setSeen] = useState<readonly unknown[] | null>(null);
  const changed = seen === null || seen.length !== deps.length || deps.some((dep, index) => !Object.is(dep, seen[index]));
  if (changed) {
    setSeen(deps);
    if (when) reset();
  }
}

// ---- The recipients picker ----

export type RecipientKind = 'all' | 'new_from' | 'people' | 'universe';

export interface RecipientDraft {
  kind: RecipientKind;
  people: PersonView[];
  universe: { id: string; name: string } | null;
  /** "new people from" a day, as a date box holds it. */
  from: string;
  /** A universe's members: only who is in it now (default), or also people who join before the end. */
  changing: boolean;
  joinerCap: string;
}

export const emptyDraft = (kind: RecipientKind = 'all'): RecipientDraft => ({ kind, people: [], universe: null, from: '', changing: false, joinerCap: '' });

export const RECIPIENT_CHOICES: Record<RecipientKind, { title: string; description: string }> = {
  all: { title: 'All signed-in members', description: 'Everyone with an account. Guests keep their own rules.' },
  new_from: { title: 'New people from a date', description: 'Accounts made on or after a date you pick.' },
  people: { title: 'People you pick', description: 'One person or several. Saved as these people.' },
  universe: { title: 'A universe’s members', description: 'People who joined it, not people who only visited.' },
};

/** The draft as the routes take it, or null while it is not complete (no people, no universe, no date). */
export function recipientsOf(draft: RecipientDraft): Recipients | null {
  if (draft.kind === 'all') return { kind: 'all' };
  if (draft.kind === 'new_from') return draft.from ? { kind: 'new_from', from: draft.from } : null;
  if (draft.kind === 'people') return draft.people.length ? { kind: 'people', userIds: draft.people.map((person) => person.id) } : null;
  if (!draft.universe) return null;
  if (!draft.changing) return { kind: 'universe', universeId: draft.universe.id, mode: 'snapshot' };
  const cap = Number(draft.joinerCap);
  // A changing group is only complete with a cap on how many can join (the gift's end date ends it too), so it is never open-ended
  return Number.isInteger(cap) && cap >= 1 ? { kind: 'universe', universeId: draft.universe.id, mode: 'changing' } : null;
}

export const draftOfAudience = (audience: AudienceView): RecipientDraft => ({
  ...emptyDraft(audience.kind),
  people: audience.people,
  universe: audience.universe,
});

type Match = { id: string; name: string; woka?: string[]; detail?: string };

/** Search by name, one search at a time: only the latest answer shows. */
function Finder({ kind, onPick, picked }: { kind: 'people' | 'universes'; onPick: (match: Match) => void; picked: string[] }) {
  const [q, setQ] = useState('');
  // The results are kept with the search they answer: after typing on, the rows of the earlier search are not offered
  // A search that failed is kept the same way (no rows), so it is only said while it is the search now made
  const [found, setFound] = useState<{ q: string; kind: string; matches: Match[] | null } | null>(null);
  const answered = found && found.q === q && found.kind === kind ? found : null;
  const matches = answered?.matches ?? null;
  const failed = !!answered && answered.matches === null;
  const latest = useRef(0);
  useEffect(() => {
    const mine = ++latest.current;
    const timer = setTimeout(async () => {
      const result = await sendJson(`/api/admin/grants/find?kind=${kind}&q=${encodeURIComponent(q)}`, 'GET');
      if (mine !== latest.current) return;
      if (result.ok && result.data && Array.isArray(result.data.results)) setFound({ q, kind, matches: result.data.results as Match[] });
      else setFound({ q, kind, matches: null });
    }, 200);
    return () => clearTimeout(timer);
  }, [q, kind]);
  return (
    <div className="grid gap-2" data-testid={`grants-find-${kind}`}>
      <Input className="h-11" type="search" aria-label={kind === 'people' ? 'Search people by name' : 'Search universes by name'} placeholder={kind === 'people' ? 'Search people by name' : 'Search universes by name'} value={q} onChange={(event) => setQ(event.target.value)} />
      {failed && <p className="text-sm text-muted-foreground">The search isn’t available right now.</p>}
      {matches && matches.length === 0 && <p className="text-sm text-muted-foreground">Nobody by that name.</p>}
      {matches && matches.length > 0 && (
        <div className="grid gap-1">
          {matches
            .filter((match) => !picked.includes(match.id))
            .map((match) => (
              <button key={match.id} type="button" onClick={() => onPick(match)} className="flex min-h-11 items-center gap-3 rounded-xl border bg-card px-3 py-1.5 text-left text-sm hover:border-foreground/30">
                {kind === 'people' && <WokaAvatar layers={match.woka ?? []} name={match.name} size={32} />}
                <span className="min-w-0 flex-1 truncate font-semibold">{match.name}</span>
                {match.detail && <span className="text-xs text-muted-foreground">{match.detail}</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Give credit to…": who a gift or a default is for. Being picked gives no rooms, apps or admin rights. People are stored by account
 * id, so the picker shows names and Wokas and nothing else about them.
 */
export function RecipientPicker({ allow, draft, onChange }: { allow: RecipientKind[]; draft: RecipientDraft; onChange: (draft: RecipientDraft) => void }) {
  return (
    <div className="grid gap-4" data-testid="grants-recipients">
      <div role="radiogroup" aria-label="Give credit to" className="grid gap-2">
        {allow.map((kind) => (
          <PickCard key={kind} role="radio" picked={draft.kind === kind} onClick={() => onChange({ ...draft, kind })} indicator={<Radio checked={draft.kind === kind} />} title={RECIPIENT_CHOICES[kind].title} description={RECIPIENT_CHOICES[kind].description} />
        ))}
      </div>
      {draft.kind === 'new_from' && <Input type="date" className="h-11" aria-label="From" value={draft.from} onChange={(event) => onChange({ ...draft, from: event.target.value })} />}
      {draft.kind === 'people' && (
        <Group label="People you picked">
          <div className="flex flex-wrap gap-2">
            {draft.people.map((person) => (
              <span key={person.id} className="flex min-h-11 items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-1 text-sm font-semibold" data-testid="grants-picked">
                <WokaAvatar layers={person.woka} name={person.name} size={32} />
                {person.name}
                <button type="button" aria-label={`Remove ${person.name}`} className="grid h-9 w-9 place-content-center rounded-full hover:bg-foreground/[.08]" onClick={() => onChange({ ...draft, people: draft.people.filter((other) => other.id !== person.id) })}>
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            ))}
            {draft.people.length === 0 && (
              <span className="flex min-h-11 items-center gap-1 rounded-full border border-dashed px-3 text-sm text-muted-foreground">
                <Plus size={14} aria-hidden="true" /> Add someone
              </span>
            )}
          </div>
          <Finder kind="people" picked={draft.people.map((person) => person.id)} onPick={(match) => onChange({ ...draft, people: [...draft.people, { id: match.id, name: match.name, woka: match.woka ?? [] }] })} />
        </Group>
      )}
      {draft.kind === 'universe' && (
        <Group label="Universe">
          {draft.universe ? (
            <div className="flex min-h-11 items-center gap-3 rounded-xl border bg-card px-3 py-2">
              <span className="min-w-0 flex-1 text-sm font-semibold">{draft.universe.name}</span>
              <button type="button" className="text-sm font-semibold text-primary" onClick={() => onChange({ ...draft, universe: null })}>
                Change
              </button>
            </div>
          ) : (
            <Finder kind="universes" picked={[]} onPick={(match) => onChange({ ...draft, universe: { id: match.id, name: match.name } })} />
          )}
        </Group>
      )}
    </div>
  );
}

/** A group of faces and its name, as the exception and gift sheets show who they are for. */
export function Chosen({ title, sub, faces, onChange }: { title: string; sub?: string; faces?: PersonView[]; onChange?: () => void }) {
  return (
    <div className="flex min-h-11 items-center gap-3 rounded-xl border bg-card px-3 py-2">
      {faces && faces.length > 0 && (
        <span className="flex -space-x-2">
          {faces.slice(0, 4).map((person) => (
            <WokaAvatar key={person.id} layers={person.woka} name={person.name} size={28} />
          ))}
        </span>
      )}
      <span className="grid min-w-0">
        <span className="text-sm font-semibold">{title}</span>
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </span>
      {onChange && (
        <button type="button" className="ml-auto text-sm font-semibold text-primary" onClick={onChange}>
          Change
        </button>
      )}
    </div>
  );
}
