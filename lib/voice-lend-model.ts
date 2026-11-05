import type { VoiceModel } from '@/lib/voice-providers';

/** A model as a lend names it: its job and its id, so a listening and a speaking model with one id are told apart. Free of server code. */
export const lendModelId = (model: Pick<VoiceModel, 'kind' | 'id'>) => `${model.kind}:${model.id}`;
