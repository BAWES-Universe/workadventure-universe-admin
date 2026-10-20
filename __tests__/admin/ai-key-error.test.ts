import { aiKeyError } from '@/app/admin/hooks/use-ai-keys';

describe('aiKeyError', () => {
  it('passes on the plain sentence a route gives for a 4xx', () => {
    expect(aiKeyError(400, 'Pick a model first.')).toBe('Pick a model first.');
    expect(aiKeyError(403, 'You need Manage bots in that universe to lend a key to it.')).toBe('You need Manage bots in that universe to lend a key to it.');
  });

  it('never shows server words: a 5xx, a 404 or a missing message get a plain sentence', () => {
    expect(aiKeyError(500, 'Internal server error')).toBe('Something went wrong on our side. Try again.');
    expect(aiKeyError(404, 'Key not found')).toBe('That key isn’t there any more. Reload the page and try again.');
    expect(aiKeyError(400, undefined)).toBe('Something went wrong on our side. Try again.');
    expect(aiKeyError(401, 'Unauthorized')).toBe('Sign in again, then try again.');
  });
});
