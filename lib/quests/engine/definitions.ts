import type { QuestAggregation, QuestCreditTiming, QuestEvidence, QuestRecurrence, QuestRewardKind, QuestScopeType } from '@prisma/client';
import { validThreshold } from './aggregation';
import type { QuestDb } from './db';
import { QuestEngineError } from './errors';
import {
  ACTION_PATTERN,
  KEY_PATTERN,
  MAX_OBJECTIVES_PER_VERSION,
  MAX_REWARD_RULES_PER_VERSION,
  MAX_REWARD_VALUE_BY_EVIDENCE,
  evidenceCovers,
} from './limits';
import { PLATFORM_SCOPE_ID } from './scope';
import { parseTarget, type ObjectiveTarget } from './targets';

/**
 * Definitions and versions. A definition is immutable (its scope and key never change); a version is edited while it
 * is a draft and frozen once published. Publishing validates the whole version, so the engine never meets a quest it
 * cannot run.
 */

export interface ObjectiveSpec {
  key: string;
  action: string;
  aggregation: QuestAggregation;
  threshold?: number;
  evidence?: QuestEvidence;
  creditTiming?: QuestCreditTiming;
  target?: ObjectiveTarget | null;
  anyOfGroup?: string | null;
  requiredForCompletion?: boolean;
}

export interface RewardRuleSpec {
  key: string;
  kind: QuestRewardKind;
  value?: number;
  badgeId?: string | null;
  evidence?: QuestEvidence;
  /** Granted when this objective is satisfied (if its credit timing is immediate); null: when the quest completes. */
  objectiveKey?: string | null;
}

export interface VersionSpec {
  purpose?: string | null;
  title?: string | null;
  order?: number;
  recurrence?: QuestRecurrence;
  objectives: ObjectiveSpec[];
  rewards?: RewardRuleSpec[];
}

export interface DefinitionSpec {
  scopeType: QuestScopeType;
  /** The universe, world or room id; null or "" for the platform. */
  scopeId?: string | null;
  key: string;
  createdById?: string | null;
}

export interface SpecProblem {
  path: string;
  message: string;
}

const MAX_TEXT = { purpose: 200, title: 80, badgeId: 64, group: 64 } as const;

function validKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/** Every reason a version could not run. Empty when it can be published. */
export function validateVersionSpec(spec: VersionSpec): SpecProblem[] {
  const problems: SpecProblem[] = [];
  if (spec.purpose != null && (typeof spec.purpose !== 'string' || spec.purpose.length > MAX_TEXT.purpose)) {
    problems.push({ path: 'purpose', message: `At most ${MAX_TEXT.purpose} characters.` });
  }
  if (spec.title != null && (typeof spec.title !== 'string' || spec.title.length > MAX_TEXT.title)) {
    problems.push({ path: 'title', message: `At most ${MAX_TEXT.title} characters.` });
  }
  if (spec.order !== undefined && (!Number.isInteger(spec.order) || spec.order < 0 || spec.order > 10_000)) {
    problems.push({ path: 'order', message: 'A whole number from 0 to 10000.' });
  }
  const objectives = Array.isArray(spec.objectives) ? spec.objectives : [];
  if (!objectives.length) problems.push({ path: 'objectives', message: 'A quest needs at least one objective.' });
  if (objectives.length > MAX_OBJECTIVES_PER_VERSION) {
    problems.push({ path: 'objectives', message: `At most ${MAX_OBJECTIVES_PER_VERSION} objectives.` });
  }
  const objectiveKeys = new Set<string>();
  const requiredEvidence = new Map<string, QuestEvidence>();
  objectives.forEach((objective, index) => {
    const path = `objectives[${index}]`;
    if (!validKey(objective.key)) problems.push({ path: `${path}.key`, message: 'Lowercase letters, digits, dots, dashes; up to 64.' });
    else if (objectiveKeys.has(objective.key)) problems.push({ path: `${path}.key`, message: 'Each objective key once.' });
    else objectiveKeys.add(objective.key);
    if (typeof objective.action !== 'string' || !ACTION_PATTERN.test(objective.action)) {
      problems.push({ path: `${path}.action`, message: 'An action name: lowercase letters, digits, dots, dashes; up to 64.' });
    }
    if (!validThreshold(objective.aggregation, objective.threshold ?? 1)) {
      problems.push({ path: `${path}.threshold`, message: 'A whole number from 1 to the bound of its aggregation.' });
    }
    if (objective.target !== undefined && objective.target !== null && parseTarget(objective.target) === null) {
      problems.push({ path: `${path}.target`, message: 'An entity id or the host role.' });
    }
    if (objective.anyOfGroup != null && (typeof objective.anyOfGroup !== 'string' || !KEY_PATTERN.test(objective.anyOfGroup))) {
      problems.push({ path: `${path}.anyOfGroup`, message: 'A group name: lowercase letters, digits, dots, dashes; up to 64.' });
    }
    if (typeof objective.key === 'string') requiredEvidence.set(objective.key, objective.evidence ?? 'CLIENT');
  });
  if (!objectives.some((objective) => objective.requiredForCompletion ?? true)) {
    problems.push({ path: 'objectives', message: 'At least one objective must be required for completion.' });
  }

  const rewards = Array.isArray(spec.rewards) ? spec.rewards : [];
  if (rewards.length > MAX_REWARD_RULES_PER_VERSION) {
    problems.push({ path: 'rewards', message: `At most ${MAX_REWARD_RULES_PER_VERSION} reward rules.` });
  }
  const ruleKeys = new Set<string>();
  rewards.forEach((rule, index) => {
    const path = `rewards[${index}]`;
    if (!validKey(rule.key)) problems.push({ path: `${path}.key`, message: 'Lowercase letters, digits, dots, dashes; up to 64.' });
    else if (ruleKeys.has(rule.key)) problems.push({ path: `${path}.key`, message: 'Each rule key once.' });
    else ruleKeys.add(rule.key);
    const evidence = rule.evidence ?? 'CLIENT';
    const value = rule.value ?? 1;
    const max = MAX_REWARD_VALUE_BY_EVIDENCE[evidence];
    if (!Number.isInteger(value) || value < 1 || value > max) {
      problems.push({ path: `${path}.value`, message: `A whole number from 1 to ${max} for ${evidence.toLowerCase()} evidence.` });
    }
    if (rule.kind === 'BADGE') {
      if (!validKey(rule.badgeId)) problems.push({ path: `${path}.badgeId`, message: 'A badge needs an id.' });
      if (value !== 1) problems.push({ path: `${path}.value`, message: 'A badge is worth one.' });
    } else if (rule.badgeId != null) {
      problems.push({ path: `${path}.badgeId`, message: 'Only a badge has a badge id.' });
    }
    if (rule.objectiveKey != null) {
      const required = requiredEvidence.get(rule.objectiveKey);
      if (required === undefined) problems.push({ path: `${path}.objectiveKey`, message: 'Names an objective of this version.' });
      else if (!evidenceCovers(required, evidence)) {
        problems.push({ path: `${path}.evidence`, message: 'An objective cannot cause a grant its own evidence could not.' });
      }
    }
  });
  return problems;
}

export async function createQuestDefinition(db: QuestDb, spec: DefinitionSpec) {
  if (!validKey(spec.key)) throw new QuestEngineError('invalid-spec', 'A quest key is lowercase letters, digits, dots and dashes.');
  const scopeId = spec.scopeId ?? PLATFORM_SCOPE_ID;
  if ((spec.scopeType === 'PLATFORM') !== (scopeId === PLATFORM_SCOPE_ID)) {
    throw new QuestEngineError('invalid-spec', 'A platform quest has no scope id; any other scope needs one.');
  }
  return db.questDefinition.create({
    data: { scopeType: spec.scopeType, scopeId, key: spec.key, createdById: spec.createdById ?? null },
  });
}

/** A new draft version of a definition, numbered after the last one. */
export async function addQuestVersion(db: QuestDb, definitionId: string, spec: VersionSpec) {
  const problems = validateVersionSpec(spec);
  if (problems.length) throw new QuestEngineError('invalid-spec', 'The version cannot run as written.', { problems });
  const definition = await db.questDefinition.findUnique({ where: { id: definitionId }, select: { id: true } });
  if (!definition) throw new QuestEngineError('not-found', 'No such quest.');
  const last = await db.questVersion.findFirst({ where: { definitionId }, orderBy: { number: 'desc' }, select: { number: true } });
  return db.questVersion.create({
    data: {
      definitionId,
      number: (last?.number ?? 0) + 1,
      purpose: spec.purpose ?? null,
      title: spec.title ?? null,
      order: spec.order ?? 0,
      recurrence: spec.recurrence ?? 'ONCE',
      objectives: {
        create: spec.objectives.map((objective, index) => ({
          key: objective.key,
          order: index,
          action: objective.action,
          aggregation: objective.aggregation,
          evidence: objective.evidence ?? 'CLIENT',
          creditTiming: objective.creditTiming ?? 'IMMEDIATE',
          threshold: objective.threshold ?? 1,
          target: objective.target ?? undefined,
          anyOfGroup: objective.anyOfGroup ?? null,
          requiredForCompletion: objective.requiredForCompletion ?? true,
        })),
      },
      rewardRules: {
        create: (spec.rewards ?? []).map((rule) => ({
          key: rule.key,
          kind: rule.kind,
          value: rule.value ?? 1,
          badgeId: rule.badgeId ?? null,
          evidence: rule.evidence ?? 'CLIENT',
          objectiveKey: rule.objectiveKey ?? null,
        })),
      },
    },
    include: { objectives: { orderBy: { order: 'asc' } }, rewardRules: true },
  });
}

/** Edits to a draft. A published or retired version is immutable: the call is refused. */
export async function updateQuestVersion(db: QuestDb, versionId: string, spec: VersionSpec) {
  const version = await db.questVersion.findUnique({ where: { id: versionId }, select: { status: true } });
  if (!version) throw new QuestEngineError('not-found', 'No such version.');
  if (version.status !== 'DRAFT') {
    throw new QuestEngineError('version-immutable', 'A published version never changes; publish a new one.');
  }
  const problems = validateVersionSpec(spec);
  if (problems.length) throw new QuestEngineError('invalid-spec', 'The version cannot run as written.', { problems });
  await db.questObjective.deleteMany({ where: { versionId } });
  await db.questRewardRule.deleteMany({ where: { versionId } });
  return db.questVersion.update({
    where: { id: versionId },
    data: {
      purpose: spec.purpose ?? null,
      title: spec.title ?? null,
      order: spec.order ?? 0,
      recurrence: spec.recurrence ?? 'ONCE',
      objectives: {
        create: spec.objectives.map((objective, index) => ({
          key: objective.key,
          order: index,
          action: objective.action,
          aggregation: objective.aggregation,
          evidence: objective.evidence ?? 'CLIENT',
          creditTiming: objective.creditTiming ?? 'IMMEDIATE',
          threshold: objective.threshold ?? 1,
          target: objective.target ?? undefined,
          anyOfGroup: objective.anyOfGroup ?? null,
          requiredForCompletion: objective.requiredForCompletion ?? true,
        })),
      },
      rewardRules: {
        create: (spec.rewards ?? []).map((rule) => ({
          key: rule.key,
          kind: rule.kind,
          value: rule.value ?? 1,
          badgeId: rule.badgeId ?? null,
          evidence: rule.evidence ?? 'CLIENT',
          objectiveKey: rule.objectiveKey ?? null,
        })),
      },
    },
    include: { objectives: { orderBy: { order: 'asc' } }, rewardRules: true },
  });
}

/**
 * Publishes a draft: it becomes the version new acceptances use, and the previously published one is retired for new
 * acceptances while attempts already on it carry on. Immutable from here on.
 */
export async function publishQuestVersion(db: QuestDb, versionId: string, byToken: string, now = new Date()) {
  const version = await db.questVersion.findUnique({
    where: { id: versionId },
    include: { objectives: { orderBy: { order: 'asc' } }, rewardRules: true },
  });
  if (!version) throw new QuestEngineError('not-found', 'No such version.');
  if (version.status === 'PUBLISHED') return version;
  if (version.status === 'RETIRED') throw new QuestEngineError('version-immutable', 'A retired version stays retired.');
  const problems = validateVersionSpec({
    purpose: version.purpose,
    title: version.title,
    order: version.order,
    recurrence: version.recurrence,
    objectives: version.objectives.map((objective) => ({ ...objective, target: parseTarget(objective.target) })),
    rewards: version.rewardRules,
  });
  if (problems.length) throw new QuestEngineError('invalid-spec', 'The version cannot run as written.', { problems });

  await db.questVersion.updateMany({
    where: { definitionId: version.definitionId, status: 'PUBLISHED', id: { not: versionId } },
    data: { status: 'RETIRED', retiredAt: now },
  });
  const published = await db.questVersion.update({
    where: { id: versionId },
    data: { status: 'PUBLISHED', publishedAt: now },
    include: { objectives: { orderBy: { order: 'asc' } }, rewardRules: true },
  });
  await db.questAuditLog.create({
    data: { action: 'publish', subjectToken: version.definitionId, byToken, versionId, details: { number: version.number } },
  });
  return published;
}

/** Retires a version for good: nobody accepts it again, and attempts on it are marked retired (their progress kept). */
export async function retireQuestVersion(db: QuestDb, versionId: string, byToken: string, reason: string | null = null, now = new Date()) {
  const version = await db.questVersion.findUnique({ where: { id: versionId }, select: { id: true, definitionId: true, status: true } });
  if (!version) throw new QuestEngineError('not-found', 'No such version.');
  if (version.status === 'RETIRED') return;
  await db.questVersion.update({ where: { id: versionId }, data: { status: 'RETIRED', retiredAt: now } });
  await db.questProgress.updateMany({
    where: { versionId, status: { in: ['ACCEPTED', 'PAUSED'] } },
    data: { status: 'RETIRED' },
  });
  await db.questAuditLog.create({ data: { action: 'retire', subjectToken: version.definitionId, byToken, versionId, reason } });
}

export async function pauseQuestDefinition(db: QuestDb, definitionId: string, paused: boolean, now = new Date()) {
  return db.questDefinition.update({ where: { id: definitionId }, data: { pausedAt: paused ? now : null } });
}

/** The version new acceptances use, or null when none is published. */
export async function publishedVersion(db: QuestDb, definitionId: string) {
  return db.questVersion.findFirst({
    where: { definitionId, status: 'PUBLISHED' },
    include: { objectives: { orderBy: { order: 'asc' } }, rewardRules: true },
  });
}
