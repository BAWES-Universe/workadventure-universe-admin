/**
 * How long each quest table keeps its rows. A new quest table ships with its line here; the test
 * (__tests__/lib/quests-engine/retention.test.ts) fails when the schema has a quest model this map does not.
 */
export const QUEST_RETENTION: Readonly<Record<string, string>> = {
  QuestDefinition: 'As long as its scope; platform quests for ever. Never edited; retired through its versions.',
  QuestVersion: 'As long as its definition. Published versions are immutable.',
  QuestObjective: 'As long as its version.',
  QuestRewardRule: 'As long as its version; grants reference it for ever.',
  QuestAttempt: 'Deleted with the account.',
  QuestProgress: 'Deleted with the account.',
  QuestObjectiveProgress: 'Deleted with the account.',
  QuestObservation: 'Deleted with the account.',
  QuestObservationApplication: 'Deleted with the account.',
  QuestRewardGrant: 'Deleted with the account.',
  QuestTrackedSelection: 'Deleted with the account.',
  QuestGuidancePreference: 'Deleted with the account.',
  QuestHostBinding: 'As long as its scope.',
  QuestPartnerLink: 'Unlinked from the account when it is deleted; the partner row stays without a subject.',
  QuestAuditLog: 'Kept. A deleted account is replaced by a one-way token, so the aggregate survives without the person.',
};
