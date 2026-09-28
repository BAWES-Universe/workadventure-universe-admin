'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { scopedDraftKey } from '@/lib/drafts';
import { questCopy } from '@/lib/quests/copy';
import { questsProofEnabled } from '@/lib/quests/flag';
import {
  EMPTY_QUEST_DRAFT,
  draftFromPublished,
  draftProblems,
  hostOf,
  publishedFromDraft,
  readPublishedQuest,
  upgradeQuestDraft,
  type QuestContext,
  type QuestDraft,
  type QuestHostKind,
  type QuestPath,
} from '@/lib/quests/model';
import { DraftNotice } from '../../../../components/draft-notice';
import { EmptyCard, InContext, LoadError, LoadingRows, PageHeader, SettingSwitch, Settings } from '../../../../components/ds';
import { QuestPreview } from '../../../../components/quests/quest-preview';
import { QuestsOff } from '../../../../components/quests/quests-off';
import { useQuestRoom, type QuestRoom } from '../../../../components/quests/use-quest-room';
import styles from '../../../../components/quests/quests.module.css';
import { savePublishedQuest } from '../../../../components/quests/use-published-quest';
import { useDraft } from '../../../../hooks/use-draft';

/**
 * Add a quest to a room (the quests proof slice): the Welcome chapter, what newcomers can do and who greets them, a
 * preview in the game's own words, and Publish. Published quests live in this browser until the quest engine ships.
 */
export default function NewQuestPage() {
  const roomId = useParams().id as string;
  if (!questsProofEnabled()) return <QuestsOff />;
  return <NewQuest roomId={roomId} />;
}

function NewQuest({ roomId }: { roomId: string }) {
  const { state, retry } = useQuestRoom(roomId, true);
  if (state.status === 'ready' && state.room.canEdit && state.context) {
    return <QuestForm room={state.room} context={state.context} />;
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Add a quest" />
      {state.status === 'loading' && <LoadingRows label="this room" rows={3} />}
      {state.status === 'error' && <LoadError label="this room" retry={retry} />}
      {state.status === 'missing' && (
        <EmptyCard kind="room" title="Room not found." text="It may have been deleted, or you may not have access to it." />
      )}
      {state.status === 'ready' && (
        <EmptyCard
          kind="room"
          title="Only people who can edit this room add quests."
          text="Ask its owner, or an admin or editor of its world."
          testId="quest-not-editor"
        />
      )}
    </div>
  );
}

const HOSTS: { kind: QuestHostKind; label: string }[] = [
  { kind: 'none', label: 'No host' },
  { kind: 'bot', label: 'A bot' },
  { kind: 'area', label: 'An area' },
];

function StepHeading({ id, number, children }: { id: string; number: number; children: ReactNode }) {
  return (
    <h2 id={id} className={`${styles.stepTitle} orbit-display`}>
      <span className={styles.stepNumber} aria-hidden="true">
        {number}
      </span>
      {children}
    </h2>
  );
}

/** Focusing the field also scrolls it into view. */
function focusField(id: string) {
  document.getElementById(id)?.focus();
}

function QuestForm({ room, context }: { room: QuestRoom; context: QuestContext }) {
  const router = useRouter();
  const [published] = useState(() => readPublishedQuest(room.id));
  // Where the form starts: the published quest when editing, else Welcome with what this room can offer.
  const baseline = useMemo<QuestDraft>(() => {
    if (published) return draftFromPublished(published);
    return {
      ...EMPTY_QUEST_DRAFT,
      explore: context.areas.length > 0,
      areaId: context.areas.length === 1 ? context.areas[0].id : '',
    };
  }, [published, context.areas]);
  const [draft, setDraft] = useState<QuestDraft>(baseline);
  const [error, setError] = useState<string | null>(null);
  const { discard, restored, revert } = useDraft(scopedDraftKey('quest.new', room.id), draft, setDraft, baseline, true, upgradeQuestDraft);

  const noAreas = context.areas.length === 0;
  // A map without named areas can't offer Explore, whatever a restored draft says.
  const offered = noAreas ? { ...draft, explore: false } : draft;
  const problems = draftProblems(offered, context);
  const firstProblem = problems.paths
    ? { text: problems.paths, field: 'quest-path-meet' }
    : problems.area
      ? { text: problems.area, field: 'quest-area' }
      : problems.host
        ? { text: problems.host, field: 'quest-host-target' }
        : null;
  const area = offered.explore ? context.areas.find((candidate) => candidate.id === draft.areaId) ?? null : null;
  const roomHref = `/admin/rooms/${room.id}`;
  const cancelHref = published ? `${roomHref}/quests/welcome` : `${roomHref}?tab=quests`;

  const update = (change: Partial<QuestDraft>) => setDraft((current) => ({ ...current, ...change }));
  const setPath = (path: QuestPath, on: boolean) => update({ [path]: on });
  const setHostKind = (hostKind: QuestHostKind) => {
    const list = hostKind === 'bot' ? context.bots : hostKind === 'area' ? context.areas : [];
    update({ hostKind, hostId: list.length === 1 ? list[0].id : '' });
  };

  function publish() {
    if (firstProblem) return;
    const quest = publishedFromDraft(offered, context, published?.status ?? 'live');
    if (!savePublishedQuest(room.id, quest)) {
      setError('This browser won’t keep it (its storage is blocked or full), so nothing was published.');
      return;
    }
    discard();
    router.replace(`${roomHref}/quests/welcome`);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={published ? 'Edit the welcome chapter' : 'Add a quest'}
        context={<InContext parts={[{ label: room.name, href: `${roomHref}?tab=quests` }]} />}
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="p-4 sm:p-6">
          {restored && (
            <div className="mb-6">
              <DraftNotice onDiscard={revert} />
            </div>
          )}
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              publish();
            }}
          >

            <section className={styles.step} data-area="preset" aria-labelledby="quest-step-preset">
              <StepHeading id="quest-step-preset" number={1}>
                Pick a preset
              </StepHeading>
              <div role="radiogroup" aria-labelledby="quest-step-preset" className={styles.choices}>
                <label className={styles.choice}>
                  <input type="radio" name="preset" value="welcome" checked readOnly className="sr-only" />
                  <span className={styles.choiceMark} aria-hidden="true" />
                  <span className={styles.choiceText}>
                    <strong>Welcome chapter</strong>
                    <span>No bot, no setup. Newcomers get one invitation with up to three short things to do here.</span>
                  </span>
                </label>
              </div>
              <p className={styles.stepNote}>More presets later.</p>
            </section>

            <section className={styles.step} data-area="targets" aria-labelledby="quest-step-targets">
              <StepHeading id="quest-step-targets" number={2}>
                Choose what newcomers can do
              </StepHeading>
              <Settings label="Things to do">
                <SettingSwitch
                  id="quest-path-meet"
                  label={questCopy('paths.meet.title')}
                  hint="Offered when someone else is in the room, or a bot that can chat."
                  checked={draft.meet}
                  onChange={(on) => setPath('meet', on)}
                />
                <SettingSwitch
                  id="quest-path-explore"
                  label={questCopy('paths.explore.title')}
                  hint={noAreas ? 'No named areas on this map yet. Name one in the map editor to offer this.' : 'Newcomers find one named area of this room.'}
                  checked={offered.explore}
                  disabled={noAreas}
                  onChange={(on) => setPath('explore', on)}
                />
                {offered.explore && (
                  <div className={styles.target}>
                    <label htmlFor="quest-area" className="sr-only">
                      Area to find
                    </label>
                    <select
                      id="quest-area"
                      className={styles.select}
                      value={draft.areaId}
                      aria-invalid={problems.area ? true : undefined}
                      aria-describedby={problems.area ? 'quest-area-problem' : undefined}
                      onChange={(event) => update({ areaId: event.target.value })}
                    >
                      <option value="">Choose the area to find…</option>
                      {context.areas.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                    </select>
                    {problems.area && (
                      <p id="quest-area-problem" className={styles.problem}>
                        {problems.area}
                      </p>
                    )}
                  </div>
                )}
                <SettingSwitch
                  id="quest-path-build"
                  label={questCopy('paths.build.title')}
                  hint="Only for people who can edit this room: they add one thing with the map editor."
                  checked={draft.build}
                  onChange={(on) => setPath('build', on)}
                />
              </Settings>
              {problems.paths && <p className={styles.problem}>{problems.paths}</p>}

              <fieldset className="min-w-0 space-y-2">
                <legend className="mb-2 text-sm font-semibold">Who greets newcomers?</legend>
                <div className={styles.choices} data-columns="3">
                  {HOSTS.map(({ kind, label }) => {
                    const count = kind === 'bot' ? context.bots.length : kind === 'area' ? context.areas.length : 1;
                    const hint =
                      kind === 'none'
                        ? 'The invitation comes from the room.'
                        : count === 0
                          ? kind === 'bot'
                            ? 'No bots in this room yet.'
                            : 'No named areas on this map yet.'
                          : kind === 'bot'
                            ? 'One of this room’s bots.'
                            : 'One of this room’s areas.';
                    return (
                      <label key={kind} className={styles.choice}>
                        <input
                          type="radio"
                          name="quest-host"
                          value={kind}
                          checked={draft.hostKind === kind}
                          disabled={count === 0}
                          onChange={() => setHostKind(kind)}
                          className="sr-only"
                        />
                        <span className={styles.choiceMark} aria-hidden="true" />
                        <span className={styles.choiceText}>
                          <strong>{label}</strong>
                          <span>{hint}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {draft.hostKind !== 'none' && (
                  <div className={styles.target}>
                    <label htmlFor="quest-host-target" className="sr-only">
                      Host
                    </label>
                    <select
                      id="quest-host-target"
                      className={styles.select}
                      value={draft.hostId}
                      aria-invalid={problems.host ? true : undefined}
                      aria-describedby={problems.host ? 'quest-host-problem' : undefined}
                      onChange={(event) => update({ hostId: event.target.value })}
                    >
                      <option value="">{draft.hostKind === 'bot' ? 'Choose a bot…' : 'Choose an area…'}</option>
                      {(draft.hostKind === 'bot' ? context.bots : context.areas).map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </option>
                      ))}
                    </select>
                    {problems.host && (
                      <p id="quest-host-problem" className={styles.problem}>
                        {problems.host}
                      </p>
                    )}
                  </div>
                )}
              </fieldset>
            </section>

            <section className={styles.step} data-area="preview" aria-labelledby="quest-step-preview">
              <StepHeading id="quest-step-preview" number={3}>
                Preview
              </StepHeading>
              <QuestPreview
                roomName={room.name}
                paths={{ meet: offered.meet, explore: offered.explore, build: offered.build }}
                areaName={area?.name ?? null}
                host={hostOf(draft, context)}
              />
              <p className={styles.stepNote}>Visitors see this in their own language.</p>
            </section>

            <section className={styles.step} data-area="publish" aria-labelledby="quest-step-publish">
              <StepHeading id="quest-step-publish" number={4}>
                Publish
              </StepHeading>
              <p className={styles.stepNote}>
                For now a published quest is kept in this browser (a prototype): Visit the room shows it to you in the game.
              </p>
              {firstProblem && (
                <button type="button" className={styles.problemLink} onClick={() => focusField(firstProblem.field)}>
                  {firstProblem.text}
                </button>
              )}
              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" className="h-11" asChild>
                  <Link href={cancelHref}>Cancel</Link>
                </Button>
                <Button type="submit" className="h-11" disabled={firstProblem !== null} data-testid="quest-publish">
                  {published ? 'Publish changes' : 'Publish'}
                </Button>
              </div>
            </section>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
