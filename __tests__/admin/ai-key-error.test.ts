import { AiKeyFailure, aiKeyError, aiKeyFailureText } from '@/app/admin/hooks/use-ai-keys';

describe('aiKeyError', () => {
  it('passes on the plain sentence a route gives for a 4xx', () => {
    expect(aiKeyError(400, 'Pick a model first.')).toBe('Pick a model first.');
    expect(aiKeyError(403, 'You need Manage bots in that universe to lend a key to it.')).toBe('You need Manage bots in that universe to lend a key to it.');
  });

  it('passes on a 5xx that names its cause, like keys not being savable on this server', () => {
    expect(aiKeyError(500, 'Keys can’t be saved on this server yet. Tell the Universe team.')).toBe('Keys can’t be saved on this server yet. Tell the Universe team.');
  });

  it('never shows server words: a 5xx, a 404 or a missing message get a plain sentence', () => {
    expect(aiKeyError(500, 'Internal server error')).toBe('Something went wrong on our side. Try again.');
    expect(aiKeyError(404, 'Key not found')).toBe('That key isn’t there any more. Reload the page and try again.');
    expect(aiKeyError(400, undefined)).toBe('Something went wrong on our side. Try again.');
    expect(aiKeyError(401, 'Unauthorized')).toBe('Sign in again, then try again.');
  });
});

describe('aiKeyFailureText', () => {
  it('shows our own plain sentence as it is', () => {
    expect(aiKeyFailureText(new AiKeyFailure('Pick a model first.'))).toBe('Pick a model first.');
  });

  it('puts a request that never got an answer plainly, never the browser’s words', () => {
    expect(aiKeyFailureText(new TypeError('Failed to fetch'))).toBe('We couldn’t reach Universe. Check your connection and try again.');
    expect(aiKeyFailureText(undefined)).toBe('We couldn’t reach Universe. Check your connection and try again.');
  });
});
