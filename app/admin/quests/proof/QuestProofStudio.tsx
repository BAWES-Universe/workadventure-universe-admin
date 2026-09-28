'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Compass,
  Eye,
  Globe2,
  MapPin,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  DEFAULT_GREETING,
  PROOF_ROOM,
  availablePaths,
  hostName,
  validateDraft,
  type HostKind,
  type PathId,
  type PreviewScenario,
  type PreviewStage,
  type WelcomeDraft,
} from './proof-model';
import { useProofDocument } from './proof-store';
import styles from './quest-proof.module.css';

type Mode = 'edit' | 'test' | 'dashboard';
const PATHS: { id: PathId; label: string; description: string; Icon: typeof Compass }[] = [
  { id: 'meet', label: 'Meet someone', description: 'A hello, with whoever is here.', Icon: MessageCircle },
  { id: 'explore', label: 'Explore a place', description: 'A small discovery around the corner.', Icon: Compass },
  { id: 'build', label: 'Make something', description: 'A safe practice area, for room editors.', Icon: WandSparkles },
];

function Stamp({ small = false }: { small?: boolean }) {
  return (
    <span className={small ? styles.stampSmall : styles.stamp} aria-hidden="true">
      <svg viewBox="0 0 100 100" fill="none">
        <path
          d="m50 3 9 6 11-1 6 9 10 4 1 11 7 9-4 10 1 11-9 6-4 10-11 1-9 7-10-4-11 1-6-9-10-4-1-11-7-9 4-10-1-11 9-6 4-10 11-1Z"
          fill="currentColor"
          opacity=".1"
        />
        <circle cx="49" cy="47" r="34" stroke="currentColor" strokeWidth="1" />
        <circle cx="49" cy="47" r="29" stroke="currentColor" strokeWidth=".6" strokeDasharray="1 3" />
        <path d="M49 25 55 40 71 46 55 52 49 68 43 52 27 46 43 40Z" fill="currentColor" />
        <path d="m67 27 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill="currentColor" />
      </svg>
    </span>
  );
}

/** Decorative, original room art. No map, avatar or resident in this illustration is a runtime target. */
function RoomArt({ quiet = false }: { quiet?: boolean }) {
  const id = useId().replaceAll(':', '');
  return (
    <div className={styles.roomArt} aria-hidden="true">
      <svg viewBox="0 0 600 230" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id={`${id}-ground`} x1="0" x2="1" y1="0" y2="1">
            <stop stopColor="#1f3747" />
            <stop offset="1" stopColor="#101c30" />
          </linearGradient>
          <radialGradient id={`${id}-light`}>
            <stop stopColor="#c4b5fd" stopOpacity=".35" />
            <stop offset="1" stopColor="#c4b5fd" stopOpacity="0" />
          </radialGradient>
          <pattern id={`${id}-tiles`} width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" stroke="#7e97ad" opacity=".08" />
          </pattern>
        </defs>
        <rect width="600" height="230" fill={`url(#${id}-ground)`} />
        <rect width="600" height="230" fill={`url(#${id}-tiles)`} />
        <path d="M-10 175H200Q246 175 246 130V54Q246 30 280 30H610" stroke="#3c455d" strokeWidth="56" fill="none" />
        <path
          d="M-10 175H200Q246 175 246 130V54Q246 30 280 30H610"
          stroke="#545366"
          strokeWidth="2"
          strokeDasharray="4 10"
          fill="none"
        />
        <path d="M60 30h106v68H60zM369 119h149v71H369z" fill="#172e39" stroke="#547f6b" strokeWidth="2" />
        <path d="M65 35h96v58H65zM374 124h139v61H374z" fill="#25483d" />
        <g fill="#3f7658">
          <circle cx="77" cy="39" r="24" />
          <circle cx="116" cy="56" r="26" />
          <circle cx="159" cy="36" r="23" />
          <circle cx="384" cy="168" r="22" />
          <circle cx="436" cy="169" r="19" />
          <circle cx="506" cy="141" r="25" />
        </g>
        <g fill="#65906a" opacity=".65">
          <circle cx="70" cy="31" r="13" />
          <circle cx="108" cy="45" r="16" />
          <circle cx="153" cy="28" r="13" />
          <circle cx="499" cy="131" r="15" />
        </g>
        <g fill="#4e4960">
          <rect x="298" y="110" width="12" height="64" rx="4" />
          <rect x="318" y="110" width="12" height="64" rx="4" />
          <rect x="414" y="63" width="65" height="11" rx="3" />
          <rect x="414" y="82" width="65" height="11" rx="3" />
        </g>
        <ellipse cx="260" cy="114" rx="83" ry="66" fill={`url(#${id}-light)`} />
        {!quiet && (
          <>
            <ellipse cx="256" cy="134" rx="17" ry="6" fill="#070d1a" opacity=".6" />
            <rect x="245" y="112" width="23" height="22" rx="8" fill="#ad90f5" />
            <circle cx="256" cy="105" r="10" fill="#e9c398" />
            <path d="M246 102q10-15 20 0" fill="#473440" />
            <ellipse cx="348" cy="49" rx="13" ry="5" fill="#070d1a" opacity=".5" />
            <rect x="340" y="30" width="17" height="20" rx="7" fill="#73a2b4" />
            <circle cx="348" cy="24" r="8" fill="#b58872" />
          </>
        )}
        <g fill="#e9c74c">
          <circle cx="201" cy="80" r="2" />
          <circle cx="292" cy="63" r="2" />
          <circle cx="359" cy="103" r="2" />
        </g>
      </svg>
      <span className={styles.artLabel}>
        <MapPin size={12} />
        {PROOF_ROOM.name}
      </span>
    </div>
  );
}

function FormField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export default function QuestProofStudio() {
  const { document, saved, setDocument } = useProofDocument();
  const [selectedMode, setMode] = useState<Mode | null>(null);
  const mode = selectedMode ?? (document.published ? 'dashboard' : 'edit');
  const [testSource, setTestSource] = useState<'draft' | 'published'>('draft');
  const [mobilePanel, setMobilePanel] = useState<'edit' | 'preview'>('edit');
  const [previewStage, setPreviewStage] = useState<PreviewStage>('invitation');
  const [scenario, setScenario] = useState<PreviewScenario>('guest');
  const [selectedPath, setSelectedPath] = useState<PathId | null>(null);
  const [meetSent, setMeetSent] = useState(false);
  const [arabic, setArabic] = useState(false);
  const [testedDraft, setTestedDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const dashboardHeading = useRef<HTMLHeadingElement>(null);
  const draft = document.draft;
  const previewDraft =
    mode === 'test' && testSource === 'published' && document.published ? document.published.draft : draft;
  const errors = validateDraft(draft);

  function updateDraft(update: Partial<WelcomeDraft>) {
    setDocument((current) => ({ ...current, draft: { ...current.draft, ...update } }));
    setTestedDraft(null);
    setPreviewStage('invitation');
    setSelectedPath(null);
    setNotice('');
  }
  function setHost(kind: HostKind) {
    updateDraft({
      hostKind: kind,
      hostId: kind === 'bot' ? PROOF_ROOM.bots[0].id : kind === 'area' ? PROOF_ROOM.areas[0].id : '',
    });
  }
  function startTest(source: 'draft' | 'published' = 'draft') {
    const candidate = source === 'published' ? document.published?.draft : draft;
    if (!candidate || validateDraft(candidate).length) return;
    setTestSource(source);
    setMode('test');
    setMobilePanel('preview');
    setPreviewStage('invitation');
    setSelectedPath(null);
    setMeetSent(false);
    setNotice('');
    requestAnimationFrame(() => previewHeading.current?.focus());
  }
  function edit() {
    setMode('edit');
    setTestSource('draft');
    setMobilePanel('edit');
    setNotice('');
    setTestedDraft(null);
    setPreviewStage('invitation');
    requestAnimationFrame(() => editorHeading.current?.focus());
  }
  function accept(path: PathId) {
    setMode('test');
    setMobilePanel('preview');
    setSelectedPath(path);
    setMeetSent(false);
    setPreviewStage('objective');
  }
  function complete() {
    if (!selectedPath) return;
    if (selectedPath === 'meet' && !meetSent) {
      setMeetSent(true);
      return;
    }
    setPreviewStage('stamp');
    setTestedDraft(JSON.stringify(previewDraft));
    setDocument((current) => ({ ...current, completedTests: [...new Set([...current.completedTests, selectedPath])] }));
  }
  function publish() {
    if (errors.length || testedDraft !== JSON.stringify(draft)) return;
    setDocument((current) => ({ ...current, published: { draft: current.draft, status: 'published' } }));
    setMode('dashboard');
    setNotice('Test quest published in this tab. No visitors were invited.');
    requestAnimationFrame(() => dashboardHeading.current?.focus());
  }
  function togglePause() {
    setDocument((current) =>
      current.published
        ? {
            ...current,
            published: { ...current.published, status: current.published.status === 'paused' ? 'published' : 'paused' },
          }
        : current
    );
    setNotice(
      document.published?.status === 'paused'
        ? 'Test quest resumed. Your test progress is kept.'
        : 'Test quest paused. Your test progress is kept.'
    );
  }

  return (
    <div className={styles.studio} data-testid="quest-proof-studio">
      <div className={styles.proofNote}>
        <span className={styles.proofDot} />
        <strong>Design playground</strong>
        <span>Sample room. Nothing changes in Universe.</span>
      </div>

      {mode === 'dashboard' && document.published ? (
        <section className={styles.dashboard} aria-labelledby="quest-dashboard-heading">
          <div className={styles.dashboardArt}>
            <RoomArt />
            <Stamp />
          </div>
          <div className={styles.dashboardBody}>
            <span className={styles.eyebrow}>Your welcome · {PROOF_ROOM.name}</span>
            <h1 id="quest-dashboard-heading" ref={dashboardHeading} tabIndex={-1}>
              {document.published.draft.name}
            </h1>
            <span className={styles.status}>
              <i data-paused={document.published.status === 'paused'} />
              {document.published.status === 'paused' ? 'Paused in this test' : 'Published in this test'}
            </span>
            <p>
              {document.published.status === 'paused'
                ? 'New visitors would stop seeing the invitation. People who already accepted would keep their progress.'
                : 'One quiet invitation. A choice of small discoveries. People can say no and get on with their day.'}
            </p>
            <div className={styles.publishSummary}>
              <span>
                <MapPin size={17} />
                <strong>{PROOF_ROOM.name}</strong>
                <small>Sample room only</small>
              </span>
              <span>
                <Sparkles size={17} />
                <strong>{Object.values(document.published.draft.paths).filter(Boolean).length} paths configured</strong>
                <small>Shown only when available</small>
              </span>
              <span>
                <ShieldCheck size={17} />
                <strong>
                  {document.completedTests.length} test {document.completedTests.length === 1 ? 'path' : 'paths'}{' '}
                  completed
                </strong>
                <small>Kept when you edit or pause</small>
              </span>
            </div>
            <div className={styles.dashboardActions}>
              <button className={styles.primary} onClick={() => startTest('published')}>
                <Play size={17} />
                Try it again
              </button>
              <button className={styles.secondary} onClick={edit}>
                <Pencil size={17} />
                Edit welcome
              </button>
              <button className={styles.textButton} onClick={togglePause}>
                {document.published.status === 'paused' ? <Play size={17} /> : <Pause size={17} />}
                {document.published.status === 'paused' ? 'Resume test quest' : 'Pause test quest'}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <>
          <header className={styles.heading}>
            <div>
              <span className={styles.eyebrow}>Welcome chapter · {PROOF_ROOM.name}</span>
              <h1>
                Small discoveries.
                <br />
                <span>A warmer welcome.</span>
              </h1>
              <p>Give people a reason to explore, at their own pace.</p>
            </div>
            <Stamp />
          </header>
          <div className={styles.steps} aria-label="Welcome setup">
            <span data-active={mode === 'edit'}>
              <i>{mode === 'test' ? <Check size={13} /> : '1'}</i>Make it yours
            </span>
            <span className={styles.stepLine} />
            <span data-active={mode === 'test'}>
              <i>2</i>Try it
            </span>
            <span className={styles.stepLine} />
            <span>
              <i>3</i>Ready
            </span>
          </div>

          {mode === 'edit' && (
            <div className={styles.mobileTabs} aria-label="Editor view">
              <button aria-pressed={mobilePanel === 'edit'} onClick={() => setMobilePanel('edit')}>
                <Pencil size={16} />
                Edit welcome
              </button>
              <button aria-pressed={mobilePanel === 'preview'} onClick={() => setMobilePanel('preview')}>
                <Eye size={16} />
                Player preview
              </button>
            </div>
          )}

          <div className={`${styles.workspace} ${mode === 'test' ? styles.testWorkspace : ''}`}>
            {mode === 'edit' && (
              <section
                className={styles.editor}
                data-mobile-hidden={mobilePanel !== 'edit'}
                aria-labelledby="quest-editor-heading"
              >
                <div className={styles.sectionTitle}>
                  <span className={styles.number}>01</span>
                  <div>
                    <h2 id="quest-editor-heading" ref={editorHeading} tabIndex={-1}>
                      A choice, not a checklist
                    </h2>
                    <p>Visitors pick one. Nothing is required.</p>
                  </div>
                </div>
                <fieldset className={styles.paths}>
                  <legend className={styles.srOnly}>Paths visitors can choose</legend>
                  {PATHS.map(({ id, label, description, Icon }) => (
                    <div className={styles.pathSetting} data-enabled={draft.paths[id]} key={id}>
                      <label className={styles.pathToggle}>
                        <span className={styles.pathIcon}>
                          <Icon size={21} />
                        </span>
                        <span>
                          <strong>{label}</strong>
                          <small>{description}</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={draft.paths[id]}
                          onChange={(event) => updateDraft({ paths: { ...draft.paths, [id]: event.target.checked } })}
                        />
                        <span className={styles.switch} aria-hidden="true" />
                      </label>
                      {id === 'explore' && draft.paths.explore && (
                        <label className={styles.targetField}>
                          <span>Find the</span>
                          <select
                            value={draft.areaId}
                            onChange={(event) => updateDraft({ areaId: event.target.value })}
                            aria-label="Place to explore"
                            aria-invalid={!draft.areaId}
                            aria-describedby={!draft.areaId ? 'area-error' : undefined}
                          >
                            <option value="">Choose a place</option>
                            {PROOF_ROOM.areas.map((area) => (
                              <option key={area.id} value={area.id}>
                                {area.name}
                              </option>
                            ))}
                          </select>
                          <ChevronDown aria-hidden="true" size={15} />
                        </label>
                      )}
                      {id === 'explore' && draft.paths.explore && !draft.areaId && (
                        <p className={styles.fieldError} id="area-error">
                          Choose a place to explore, or turn Explore off.
                        </p>
                      )}
                      {id === 'meet' && draft.paths.meet && (
                        <p className={styles.pathHint}>Hidden when no one is available to meet.</p>
                      )}
                      {id === 'build' && draft.paths.build && (
                        <p className={styles.pathHint}>
                          Practice corner only. Guests will not see this. The practice area must be safe to edit.
                        </p>
                      )}
                    </div>
                  ))}
                </fieldset>

                <div className={styles.sectionTitle}>
                  <span className={styles.number}>02</span>
                  <div>
                    <h2>A host, if you want one</h2>
                    <p>The welcome works without a bot.</p>
                  </div>
                </div>
                <div className={styles.hostChoices} aria-label="Who hosts the welcome">
                  {(
                    [
                      { kind: 'none', title: 'No host', Icon: Sparkles },
                      { kind: 'bot', title: 'A bot', Icon: Bot },
                      { kind: 'area', title: 'An area', Icon: MapPin },
                    ] as const
                  ).map(({ kind, title, Icon }) => (
                    <button
                      key={kind}
                      type="button"
                      aria-pressed={draft.hostKind === kind}
                      onClick={() => setHost(kind)}
                    >
                      <Icon size={20} />
                      <span>{title}</span>
                      {draft.hostKind === kind && <Check size={13} className={styles.choiceCheck} />}
                    </button>
                  ))}
                </div>
                {draft.hostKind !== 'none' && (
                  <FormField label={draft.hostKind === 'bot' ? 'Who gives the welcome?' : 'Where does it come from?'}>
                    <select value={draft.hostId} onChange={(event) => updateDraft({ hostId: event.target.value })}>
                      <option value="">Choose {draft.hostKind === 'bot' ? 'a bot' : 'an area'}</option>
                      {(draft.hostKind === 'bot' ? PROOF_ROOM.bots : PROOF_ROOM.areas).map((host) => (
                        <option key={host.id} value={host.id}>
                          {host.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                )}

                <details className={styles.copyDetails}>
                  <summary>
                    <Pencil size={16} />
                    <span>Make the words yours</span>
                    <ChevronDown size={15} />
                  </summary>
                  <div>
                    <FormField label="Welcome name">
                      <input
                        value={draft.name}
                        maxLength={60}
                        onChange={(event) => updateDraft({ name: event.target.value })}
                      />
                    </FormField>
                    <FormField label="Invitation" hint="A short invitation. People can always say not now.">
                      <textarea
                        value={draft.greeting}
                        rows={3}
                        maxLength={180}
                        onChange={(event) => updateDraft({ greeting: event.target.value })}
                      />
                    </FormField>
                  </div>
                </details>
                {errors.length > 0 && (
                  <div className={styles.validation} role="status">
                    <strong>One more thing</strong>
                    {errors.map((error) => (
                      <p key={error}>{error}</p>
                    ))}
                  </div>
                )}
              </section>
            )}

            <section
              className={styles.previewColumn}
              data-mobile-hidden={mode === 'edit' && mobilePanel !== 'preview'}
              aria-labelledby="quest-preview-heading"
            >
              <div className={styles.previewHeading}>
                <div>
                  <span className={styles.eyebrow}>{mode === 'test' ? 'Walk through it' : 'As a visitor sees it'}</span>
                  <h2 ref={previewHeading} id="quest-preview-heading" tabIndex={-1}>
                    A moment in their world
                  </h2>
                </div>
                <span className={styles.previewLabel}>Interactive preview</span>
              </div>
              <div className={styles.previewTools}>
                <label className={styles.scenarioLabel}>
                  <span className={styles.srOnly}>Preview visitor</span>
                  <select
                    aria-label="Preview visitor"
                    value={scenario}
                    onChange={(event) => {
                      setScenario(event.target.value as PreviewScenario);
                      setPreviewStage('invitation');
                      setSelectedPath(null);
                    }}
                  >
                    <option value="guest">Guest · someone here</option>
                    <option value="alone">Guest · here alone</option>
                    <option value="editor">Room editor</option>
                    <option value="empty">No available targets</option>
                  </select>
                </label>
                <button
                  className={styles.languageButton}
                  aria-pressed={arabic}
                  onClick={() => setArabic(!arabic)}
                  aria-label={arabic ? 'Preview in English' : 'Preview in Arabic'}
                >
                  <Globe2 size={15} />
                  <span>{arabic ? 'EN' : 'العربية'}</span>
                </button>
              </div>
              <PlayerPreview
                draft={previewDraft}
                arabic={arabic}
                scenario={scenario}
                stage={previewStage}
                selectedPath={selectedPath}
                meetSent={meetSent}
                onOptions={() => {
                  setMode('test');
                  setMobilePanel('preview');
                  setPreviewStage('options');
                }}
                onDecline={() => {
                  setMode('test');
                  setMobilePanel('preview');
                  setPreviewStage('declined');
                }}
                onAccept={accept}
                onComplete={complete}
                onReset={() => {
                  setPreviewStage('invitation');
                  setSelectedPath(null);
                }}
                onBack={() => setPreviewStage('options')}
              />
              <p className={styles.previewCaption}>
                <ShieldCheck size={15} />
                <span>Test run only. No messages, invitations or rewards are sent.</span>
              </p>
              {arabic && previewDraft.greeting !== DEFAULT_GREETING && (
                <p className={styles.previewCaption}>
                  Custom invitation text stays as written. Arabic controls preview the layout.
                </p>
              )}
            </section>
          </div>

          <footer className={styles.actionBar}>
            <div>
              <span className={styles.saveLine}>
                <i data-saved={saved} />
                {saved ? 'Saved in this tab' : 'Storage unavailable. Keep this view open.'}
              </span>
              <small>
                {mode === 'test' ? 'Finish any path to see the test result.' : 'Try it before anyone sees it.'}
              </small>
            </div>
            <div className={styles.actionButtons}>
              {mode === 'test' && (
                <button className={styles.textButton} onClick={edit}>
                  <ArrowLeft size={17} />
                  Keep editing
                </button>
              )}
              {mode === 'edit' ? (
                <button className={styles.primary} disabled={errors.length > 0} onClick={() => startTest()}>
                  Try the welcome
                  <ArrowRight size={18} />
                </button>
              ) : testSource === 'published' ? (
                <button className={styles.primary} onClick={() => setMode('dashboard')}>
                  Back to overview
                  <ArrowRight size={18} />
                </button>
              ) : testedDraft === JSON.stringify(draft) ? (
                <button className={styles.primary} onClick={publish}>
                  Publish test quest
                  <Check size={18} />
                </button>
              ) : (
                <button
                  className={styles.secondary}
                  onClick={() => {
                    setPreviewStage('invitation');
                    setSelectedPath(null);
                  }}
                >
                  <RotateCcw size={17} />
                  Restart test
                </button>
              )}
            </div>
          </footer>
        </>
      )}
      <p role="status" className={notice ? styles.notice : styles.srOnly}>
        {notice}
      </p>
    </div>
  );
}

export { QuestProofStudio };

function PlayerPreview({
  draft,
  arabic,
  scenario,
  stage,
  selectedPath,
  meetSent,
  onOptions,
  onDecline,
  onAccept,
  onComplete,
  onReset,
  onBack,
}: {
  draft: WelcomeDraft;
  arabic: boolean;
  scenario: PreviewScenario;
  stage: PreviewStage;
  selectedPath: PathId | null;
  meetSent: boolean;
  onOptions: () => void;
  onDecline: () => void;
  onAccept: (path: PathId) => void;
  onComplete: () => void;
  onReset: () => void;
  onBack: () => void;
}) {
  const t = (en: string, ar: string) => (arabic ? ar : en);
  const paths = availablePaths(draft, scenario);
  const canInteract = validateDraft(draft).length === 0;
  const host = hostName(draft, arabic);
  const area = PROOF_ROOM.areas.find((item) => item.id === draft.areaId);
  const areaName = area ? (arabic ? area.ar : area.name) : t('a place', 'مكان');
  const pathLabel = (path: PathId) =>
    path === 'meet'
      ? t('Meet someone', 'تعرّف على أحد')
      : path === 'explore'
      ? t(`Find the ${areaName}`, `اكتشف ${areaName}`)
      : t('Make something', 'اصنع شيئًا');
  const pathDescription = (path: PathId) =>
    path === 'meet'
      ? t('A hello is all it takes.', 'كل ما تحتاجه هو إلقاء التحية.')
      : path === 'explore'
      ? t('Something good around the corner.', 'اكتشاف صغير بانتظارك.')
      : t('Leave a little of yourself here.', 'اترك لمستك في هذا المكان.');

  return (
    <div
      className={styles.playerPreview}
      dir={arabic ? 'rtl' : 'ltr'}
      lang={arabic ? 'ar' : 'en'}
      data-testid="player-preview"
    >
      <RoomArt quiet={scenario === 'empty' || scenario === 'alone'} />
      <div className={styles.playerBody}>
        {paths.length === 0 ? (
          <div className={styles.quietState}>
            <Compass size={30} />
            <h3>{t('Just room to explore.', 'المكان لك لتستكشفه.')}</h3>
            <p>
              {t(
                'No invitation appears when none of these paths is available. Nothing interrupts the visit.',
                'لا تظهر دعوة عندما لا يتوفر أي من هذه المسارات. استكشف على راحتك.'
              )}
            </p>
            <span>{t('The map stays yours.', 'استكشف على راحتك.')}</span>
          </div>
        ) : stage === 'declined' ? (
          <div className={styles.quietState}>
            <Check size={30} />
            <h3>{t('At your own pace.', 'على راحتك.')}</h3>
            <p>
              {t(
                'The invitation is gone. Quests stay in your menu if you feel curious later.',
                'اختفت الدعوة. تبقى المهام في القائمة إذا أردت العودة لاحقًا.'
              )}
            </p>
            <button className={styles.textButton} onClick={onReset}>
              <RotateCcw size={16} />
              {t('Reset test visitor', 'إعادة ضبط الزائر التجريبي')}
            </button>
          </div>
        ) : (
          <article className={styles.invitation} key={stage}>
            <div className={styles.playerEyebrow}>
              {host ? (
                <>
                  <span className={styles.hostAvatar}>
                    {draft.hostKind === 'bot' ? <Bot size={18} /> : <MapPin size={18} />}
                  </span>
                  <span>{host}</span>
                </>
              ) : (
                <>
                  <Sparkles size={15} />
                  <span>{t('A small beginning', 'بداية صغيرة')}</span>
                </>
              )}
              {stage !== 'stamp' && <span className={styles.timeHint}>{t('1–2 min', '١–٢ دقيقة')}</span>}
            </div>
            {stage === 'invitation' && (
              <>
                <h3>
                  {draft.name === 'A first hello'
                    ? t('Welcome. Want a quick look around?', 'أهلًا بك. هل تود جولة سريعة؟')
                    : draft.name}
                </h3>
                <p>{arabic && draft.greeting === DEFAULT_GREETING ? 'دقيقتان تقريبًا، وعلى راحتك.' : draft.greeting}</p>
                <div className={styles.playerActions}>
                  <button className={styles.primary} onClick={onOptions} disabled={!canInteract}>
                    {t('Show me the options', 'أرني الخيارات')}
                    <ArrowRight size={17} className={styles.directionArrow} />
                  </button>
                  <button className={styles.textButton} onClick={onDecline}>
                    {t('Not now', 'ليس الآن')}
                  </button>
                </div>
                <span className={styles.playerFootnote}>
                  {canInteract
                    ? t('One small thing. Entirely your choice.', 'خطوة صغيرة. والاختيار لك تمامًا.')
                    : t('Finish the highlighted fields to try this welcome.', 'أكمل الحقول المحددة لتجربة الترحيب.')}
                </span>
              </>
            )}
            {stage === 'options' && (
              <>
                <div className={styles.playerTitleRow}>
                  <h3>{t('Follow your curiosity.', 'اتبع فضولك.')}</h3>
                  <button
                    className={styles.iconButton}
                    aria-label={t('Back to invitation', 'العودة إلى الدعوة')}
                    onClick={onReset}
                  >
                    <X size={19} />
                  </button>
                </div>
                <p>{t('Pick whatever feels like you.', 'اختر ما يناسبك.')}</p>
                <div className={styles.playerPaths}>
                  {paths.map((path) => {
                    const Icon = PATHS.find((item) => item.id === path)!.Icon;
                    return (
                      <button key={path} onClick={() => onAccept(path)}>
                        <span className={styles.playerPathIcon}>
                          <Icon size={21} />
                        </span>
                        <span>
                          <strong>{pathLabel(path)}</strong>
                          <small>{pathDescription(path)}</small>
                        </span>
                        <ArrowRight size={17} className={styles.directionArrow} />
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            {stage === 'objective' && selectedPath && (
              <>
                <span className={styles.following}>{t('Following · Welcome', 'متابعة · الترحيب')}</span>
                <h3>{pathLabel(selectedPath)}.</h3>
                <p>
                  {selectedPath === 'explore'
                    ? t(
                        `Step into the ${areaName}. Take the scenic route if you like.`,
                        `ادخل ${areaName}. لا داعي للاستعجال.`
                      )
                    : selectedPath === 'meet'
                    ? meetSent
                      ? t('Hello sent. A reply makes it a conversation.', 'أُرسلت التحية. الرد يجعلها محادثة.')
                      : t(
                          'Walk up to someone, send a hello, and receive a reply.',
                          'اقترب من أحد وأرسل تحية وانتظر الرد.'
                        )
                    : t(
                        'Open the editor in the Practice corner and place one thing. This sample area is safe to change.',
                        'افتح المحرر في ركن التجربة وأضف عنصرًا. يمكنك التعديل بأمان في هذه المساحة التجريبية.'
                      )}
                </p>
                <div className={styles.objectiveProgress}>
                  <span />
                  <span>
                    {selectedPath === 'meet' && meetSent
                      ? t('Waiting for a reply', 'بانتظار الرد')
                      : t('One little discovery', 'اكتشاف صغير واحد')}
                  </span>
                </div>
                <button className={styles.primary} onClick={onComplete}>
                  <Play size={16} />
                  {selectedPath === 'explore'
                    ? t('Simulate arriving', 'محاكاة الوصول')
                    : selectedPath === 'meet'
                    ? meetSent
                      ? t('Simulate a reply', 'محاكاة رد')
                      : t('Simulate a hello', 'محاكاة تحية')
                    : t('Simulate placing an item', 'محاكاة إضافة عنصر')}
                </button>
                <button className={styles.textButton} onClick={onBack}>
                  {t('Choose another path', 'اختر مسارًا آخر')}
                </button>
              </>
            )}
            {stage === 'stamp' && (
              <div className={styles.payoff}>
                <Stamp />
                <span className={styles.eyebrow}>{t('Newcomer stamp · Test only', 'ختم البداية · تجربة فقط')}</span>
                <h3>
                  {selectedPath === 'explore'
                    ? t('You found your way.', 'وجدت طريقك.')
                    : selectedPath === 'meet'
                    ? t('Every connection starts here.', 'هنا يبدأ كل تعارف.')
                    : t('A little of you, here.', 'بصمتك أصبحت هنا.')}
                </h3>
                <p>{t('A small beginning. The rest is yours to discover.', 'بداية صغيرة. والباقي لك لتكتشفه.')}</p>
                <span className={styles.testComplete}>
                  <Check size={15} />
                  {t('Test complete. Nothing was granted.', 'اكتملت التجربة. لم يتم منح أي مكافأة.')}
                </span>
                <button className={styles.textButton} onClick={onBack}>
                  {t('Try another path', 'جرّب مسارًا آخر')}
                  <ArrowRight size={16} className={styles.directionArrow} />
                </button>
              </div>
            )}
          </article>
        )}
      </div>
    </div>
  );
}
