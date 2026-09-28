/** Local fixtures for the design proof. These are never read by the quest engine or an API. */
export const PROOF_ROOM = {
  id: 'proof-room',
  name: 'The Atrium',
  practiceArea: { id: 'practice-corner', name: 'Practice corner', ar: 'ركن التجربة', safeToEdit: true },
  areas: [
    { id: 'courtyard', name: 'Courtyard', ar: 'الفناء' },
    { id: 'studio', name: 'Studio corner', ar: 'ركن الاستوديو' },
  ],
  bots: [
    { id: 'guide', name: 'Welcome guide', ar: 'دليل الترحيب' },
    { id: 'maker', name: 'Maker bot', ar: 'مساعد البناء' },
  ],
} as const;

export type PathId = 'meet' | 'explore' | 'build';
export type HostKind = 'none' | 'bot' | 'area';
export type PreviewScenario = 'guest' | 'alone' | 'editor' | 'empty';
export type PreviewStage = 'invitation' | 'options' | 'objective' | 'stamp' | 'declined';
export interface WelcomeDraft {
  name: string;
  greeting: string;
  paths: Record<PathId, boolean>;
  areaId: string;
  hostKind: HostKind;
  hostId: string;
}
export interface ProofDocument {
  schema: 1;
  draft: WelcomeDraft;
  published: { draft: WelcomeDraft; status: 'published' | 'paused' } | null;
  completedTests: PathId[];
}

export const PROOF_STORAGE_KEY = 'universe:quests-proof:owner:v1';
export const DEFAULT_GREETING = 'A couple of minutes, in your own time.';
export const newDraft = (): WelcomeDraft => ({
  name: 'A first hello',
  greeting: DEFAULT_GREETING,
  paths: { meet: true, explore: true, build: false },
  areaId: 'courtyard',
  hostKind: 'none',
  hostId: '',
});
export const newProofDocument = (): ProofDocument => ({
  schema: 1,
  draft: newDraft(),
  published: null,
  completedTests: [],
});

export function isQuestProofEnabled(
  nodeEnv = process.env.NODE_ENV,
  flag = process.env.NEXT_PUBLIC_QUESTS_PROOF_SLICE
): boolean {
  return nodeEnv !== 'production' && flag === 'true';
}

export function validateDraft(draft: WelcomeDraft): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push('Give your welcome a name.');
  if (!draft.greeting.trim()) errors.push('Write a short invitation.');
  if (!Object.values(draft.paths).some(Boolean)) errors.push('Choose at least one path.');
  if (draft.paths.explore && !PROOF_ROOM.areas.some((area) => area.id === draft.areaId)) {
    errors.push('Choose a place to explore, or turn Explore off.');
  }
  if (draft.hostKind === 'bot' && !PROOF_ROOM.bots.some((bot) => bot.id === draft.hostId)) {
    errors.push('Choose a bot to host, or choose No host.');
  }
  if (draft.hostKind === 'area' && !PROOF_ROOM.areas.some((area) => area.id === draft.hostId)) {
    errors.push('Choose an area to host, or choose No host.');
  }
  return errors;
}

export function availablePaths(draft: WelcomeDraft, scenario: PreviewScenario): PathId[] {
  if (scenario === 'empty') return [];
  return (['meet', 'explore', 'build'] as PathId[]).filter((path) => {
    if (!draft.paths[path]) return false;
    if (path === 'meet') return scenario !== 'alone';
    if (path === 'explore') return PROOF_ROOM.areas.some((area) => area.id === draft.areaId);
    return scenario === 'editor' && PROOF_ROOM.practiceArea.safeToEdit;
  });
}

export function hostName(draft: WelcomeDraft, arabic = false): string | null {
  if (draft.hostKind === 'none') return null;
  const options = draft.hostKind === 'bot' ? PROOF_ROOM.bots : PROOF_ROOM.areas;
  const target = options.find((item) => item.id === draft.hostId);
  return target ? (arabic ? target.ar : target.name) : null;
}

/** Treat browser storage as untrusted. A broken proof draft must not break Orbit. */
export function readProofDocument(value: string | null): ProofDocument | null {
  if (!value || value.length > 12000) return null;
  try {
    const document = JSON.parse(value) as ProofDocument;
    const validDraft = (draft: WelcomeDraft | undefined) =>
      !!draft &&
      typeof draft.name === 'string' &&
      draft.name.length <= 60 &&
      typeof draft.greeting === 'string' &&
      draft.greeting.length <= 180 &&
      typeof draft.areaId === 'string' &&
      typeof draft.hostId === 'string' &&
      ['none', 'bot', 'area'].includes(draft.hostKind) &&
      ['meet', 'explore', 'build'].every((key) => typeof draft.paths?.[key as PathId] === 'boolean');
    if (document.schema !== 1 || !validDraft(document.draft) || !Array.isArray(document.completedTests)) return null;
    if (document.completedTests.some((path) => !['meet', 'explore', 'build'].includes(path))) return null;
    if (
      document.published !== null &&
      (!validDraft(document.published?.draft) || !['published', 'paused'].includes(document.published?.status))
    )
      return null;
    return document;
  } catch {
    return null;
  }
}
