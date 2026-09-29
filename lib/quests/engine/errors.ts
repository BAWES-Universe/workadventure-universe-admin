export type QuestEngineErrorCode =
  | 'not-found'
  | 'not-published'
  | 'paused'
  | 'out-of-scope'
  | 'version-immutable'
  | 'invalid-spec'
  | 'invalid-observation'
  | 'stale-revision'
  | 'not-accepted'
  | 'too-many-quests';

export class QuestEngineError extends Error {
  readonly code: QuestEngineErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: QuestEngineErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'QuestEngineError';
    this.code = code;
    this.details = details;
  }
}

export function isQuestEngineError(error: unknown, code?: QuestEngineErrorCode): error is QuestEngineError {
  return error instanceof QuestEngineError && (code === undefined || error.code === code);
}
