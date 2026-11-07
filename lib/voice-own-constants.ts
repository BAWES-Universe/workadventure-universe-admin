// What an own speech server is called, safe for the browser: no network code is imported here (lib/voice-own-server.ts reaches the
// network and must stay on the server).
/** The adapter the game's worker runs this with. */
export const OWN_SPEECH_ADAPTER = 'openai-compatible';
export const OWN_SPEECH_LABEL = 'Any OpenAI-compatible speech server';
export const OWN_SPEECH_NAME = 'My speech server';
