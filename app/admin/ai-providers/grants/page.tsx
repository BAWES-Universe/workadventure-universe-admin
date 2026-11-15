'use client';

// What Universe gives people (spec v3 sections 2, 7a and 11): Universe AI replies, Instant Apps credit and computer credit.
// The super admin sets each default (amount, how often, who), the exceptions for people or a universe, and gifts. All amounts are
// typed by the super admin: nothing here has a built-in value. Nothing needs a payment gateway.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Gift, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { useReplacePage } from '@/app/admin/orbit-frame-context';
import { EntityRow, Figure, Figures, LoadError, LoadingRows, PageHeader, SectionHeader, StatLine } from '../../components/ds';
import { WokaAvatar } from '../../components/profile-card';
import styles from '../../components/ds/ds.module.css';
import { AiSheet, DefaultSheet, ExceptionSheet, GiftSheet } from './grants-sheets';
import { sendJson } from './grants-parts';
import {
  CATEGORY_NAME,
  MONEY_CATEGORIES,
  audienceTitle,
  defaultLines,
  exceptionLines,
  giftLines,
  giftMeta,
  giftPill,
  usd,
  type ExceptionView,
  type GiftView,
  type GrantsOverview,
  type MoneyCategory,
} from '@/lib/grants-view';

function Line({ title, context, aside, testId }: { title: string; context?: ReactNode; aside?: ReactNode; testId?: string }) {
  return (
    <div className={styles.row} data-testid={testId}>
      <div className={styles.rowText}>
        <strong className="text-sm font-semibold leading-snug">{title}</strong>
        {context}
      </div>
      {aside && <div className={styles.aside}>{aside}</div>}
    </div>
  );
}

const faces = (audience: ExceptionView['audience']) =>
  audience.kind === 'people' ? (
    <span className="flex -space-x-3">
      {audience.people.slice(0, 2).map((person) => (
        <WokaAvatar key={person.id} layers={person.woka} name={person.name} size={32} />
      ))}
    </span>
  ) : undefined;

type Sheet = { kind: 'ai' } | { kind: 'default'; category: MoneyCategory } | { kind: 'exception'; editing: ExceptionView | null } | { kind: 'gift' } | null;

export default function GrantsPage() {
  const replacePage = useReplacePage();
  const { addToast } = useToast();
  const [overview, setOverview] = useState<GrantsOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);

  const load = useCallback(async () => {
    setFailed(false);
    const result = await sendJson('/api/admin/grants', 'GET');
    if (result.status === 401 || result.status === 403) {
      replacePage('/admin');
      return;
    }
    if (!result.ok || !result.data) {
      setFailed(true);
      return;
    }
    setOverview(result.data as unknown as GrantsOverview);
  }, [replacePage]);

  useEffect(() => {
    load();
  }, [load]);

  const saved = () => {
    setSheet(null);
    load();
  };

  async function endException(exception: ExceptionView) {
    const result = await sendJson(`/api/admin/grants/exceptions/${encodeURIComponent(exception.id)}`, 'DELETE');
    if (!result.ok) {
      addToast({ description: result.error ?? 'That didn’t save.', variant: 'error' });
      return;
    }
    addToast({ description: 'Ended. They go back to the defaults at the next renewal.', variant: 'success', duration: 3000 });
    load();
  }

  async function endGift(gift: GiftView) {
    const result = await sendJson(`/api/admin/grants/gifts/${encodeURIComponent(gift.id)}`, 'PATCH', { action: 'end' });
    if (!result.ok) {
      addToast({ description: result.error ?? 'That didn’t save.', variant: 'error' });
      return;
    }
    addToast({ description: 'Ended. What was already used stays used.', variant: 'success', duration: 3000 });
    load();
  }

  const totals = overview?.totals ?? null;

  return (
    <div className="grid min-w-0 gap-6" data-testid="grants-page">
      <PageHeader
        kind="provider"
        title="Grants"
        context={<span className="text-sm text-muted-foreground">What Universe gives people: Universe AI replies, Instant Apps credit and computer credit.</span>}
        stats={
          totals && (
            <Figures>
              <Figure value={totals.people.toLocaleString('en')} label="people" />
              <Figure value={usd(totals.givenOnceMicros)} label="given once" />
              <Figure value={usd(totals.mostMonthMicros)} label="most a month" />
              <Figure value={usd(totals.usedMonthMicros)} label="used this month" />
            </Figures>
          )
        }
      />

      {failed ? (
        <LoadError label="the grants" retry={load} />
      ) : !overview ? (
        <LoadingRows label="the grants" rows={3} />
      ) : (
        <>
          <section aria-labelledby="grants-default" className="min-w-0" data-testid="grants-defaults">
            <SectionHeader id="grants-default" title="For everyone" />
            <div className="grid min-w-0 gap-0.5">
              <Line
                title={CATEGORY_NAME.universe_ai}
                testId="grants-ai"
                context={<StatLine items={[`${overview.ai.signedIn.toLocaleString('en')} replies every ${overview.ai.windowHours} hours`, `${overview.ai.guest.toLocaleString('en')} for guests`, 'The window starts at the first reply']} />}
                aside={
                  <Button variant="outline" className="h-11 px-4" onClick={() => setSheet({ kind: 'ai' })}>
                    Change
                  </Button>
                }
              />
              {MONEY_CATEGORIES.map((category) => {
                const view = overview.money[category];
                return (
                  <Line
                    key={category}
                    title={CATEGORY_NAME[category]}
                    testId={`grants-${category}`}
                    context={<StatLine items={defaultLines(category, view)} />}
                    aside={
                      <Button variant="outline" className="h-11 px-4" onClick={() => setSheet({ kind: 'default', category })}>
                        {view.set ? 'Change' : 'Set'}
                      </Button>
                    }
                  />
                );
              })}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Replies and dollars never pay for each other. Instant Apps credit pays only for apps that work without connecting anything. Apps people connect themselves stay free for them. Computer credit pays for a Brick’s computer jobs.
            </p>
          </section>

          <section aria-labelledby="grants-ex" className="min-w-0" data-testid="grants-exceptions">
            <SectionHeader id="grants-ex" title="Exceptions" count={overview.exceptions.length} />
            {overview.exceptions.length > 0 ? (
              <div className="grid min-w-0 gap-0.5">
                {overview.exceptions.map((exception) => (
                  <div key={exception.id} className="grid min-w-0 gap-0.5" data-testid="grants-exception">
                    <EntityRow
                      href={exception.audience.kind === 'people' && exception.audience.people.length === 1 ? `/admin/users/${exception.audience.people[0].id}` : exception.audience.kind === 'universe' && exception.audience.universe ? `/admin/universes/${exception.audience.universe.id}` : '/admin/ai-providers/grants'}
                      kind={exception.audience.kind === 'universe' ? 'universe' : 'people'}
                      universeId={exception.audience.universe?.id}
                      chevron
                      leading={faces(exception.audience)}
                      title={audienceTitle(exception.audience)}
                      context={<StatLine items={exceptionLines(exception)} />}
                    />
                    <div className="flex gap-2 px-1 pb-2">
                      <Button variant="outline" className="h-11 px-4" onClick={() => setSheet({ kind: 'exception', editing: exception })}>
                        Change
                      </Button>
                      <Button variant="outline" className="h-11 px-4" onClick={() => endException(exception)}>
                        End it
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Everyone gets the defaults above.</p>
            )}
            <div className="mt-3">
              <Button variant="outline" className="h-11 px-5" data-testid="grants-add-exception" onClick={() => setSheet({ kind: 'exception', editing: null })}>
                <Plus className="mr-2 h-4 w-4" />
                Add an exception
              </Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              A person’s own rule comes first, then rules for groups, then the default. Two group rules that disagree for the same person can’t be saved until you choose.
            </p>
          </section>

          <section aria-labelledby="grants-gifts" className="min-w-0" data-testid="grants-gifts">
            <SectionHeader id="grants-gifts" title="Gifts" count={overview.gifts.length} />
            {overview.gifts.length > 0 ? (
              <div className="grid min-w-0 gap-0.5">
                {overview.gifts.map((gift) => (
                  <div key={gift.id} className="grid min-w-0 gap-0.5" data-testid="grants-gift">
                    <EntityRow
                      href="/admin/ai-providers/grants"
                      kind={gift.audience.kind === 'universe' ? 'universe' : 'people'}
                      universeId={gift.audience.universe?.id}
                      leading={faces(gift.audience)}
                      title={audienceTitle(gift.audience)}
                      context={<StatLine items={giftLines(gift)} />}
                      meta={<StatLine items={giftMeta(gift)} />}
                      aside={<span className={styles.pill}>{giftPill(gift)}</span>}
                    />
                    {!gift.ended && (
                      <div className="flex gap-2 px-1 pb-2">
                        <Button variant="outline" className="h-11 px-4" onClick={() => endGift(gift)}>
                          End it now
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing has been given.</p>
            )}
            <div className="mt-3">
              <Button variant="outline" className="h-11 px-5" data-testid="grants-give" onClick={() => setSheet({ kind: 'gift' })}>
                <Gift className="mr-2 h-4 w-4" />
                Give credit
              </Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              A gift is a one-time extra with an end date. Separate gifts add up. When someone’s credit runs out, they can ask for more, and it shows on the Costs page under “Asked for more”.
            </p>
          </section>
        </>
      )}

      {overview && (
        <>
          <AiSheet open={sheet?.kind === 'ai'} onClose={() => setSheet(null)} onSaved={saved} ai={overview.ai} />
          <DefaultSheet category={sheet?.kind === 'default' ? sheet.category : null} view={sheet?.kind === 'default' ? overview.money[sheet.category] : null} onClose={() => setSheet(null)} onSaved={saved} />
          <ExceptionSheet open={sheet?.kind === 'exception'} editing={sheet?.kind === 'exception' ? sheet.editing : null} onClose={() => setSheet(null)} onSaved={saved} />
          <GiftSheet open={sheet?.kind === 'gift'} onClose={() => setSheet(null)} onSaved={saved} />
        </>
      )}
    </div>
  );
}
