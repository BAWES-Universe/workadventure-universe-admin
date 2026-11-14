/**
 * Text that goes into an HTTP header (a key, a token, an extra header's name or value) can only be sent as single bytes: a
 * character above 255 (an em dash or curly quote from a pasted note, an emoji, Arabic or Chinese text) makes the request fail with
 * a raw "Cannot convert argument to a ByteString" error that names nothing. These checks find the field instead, so the person is
 * told which one to retype. The text is never changed: a key with a character cut out would only fail later and more confusingly.
 */

/** A header name is letters, digits and the punctuation of RFC 9110 tokens. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** The first character that cannot be sent in a header value (above 255, or a control character), or null when it is all sendable. */
export function unsendableCharacter(text: string): string | null {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code > 255 || code === 0 || code === 10 || code === 13 || (code < 32 && code !== 9) || code === 127) return char;
  }
  return null;
}

/** The character as the person would recognise it: "—" (an em dash), or "a line break". */
function describe(char: string): string {
  if (char === '\n' || char === '\r') return 'a line break';
  const code = char.codePointAt(0)!;
  if (code === 0x2014) return 'an em dash (—)';
  if (code === 0x2013) return 'an en dash (–)';
  if (code === 0x2018 || code === 0x2019) return `a curly quote (${char})`;
  if (code === 0x201c || code === 0x201d) return `a curly quote (${char})`;
  if (code === 0x2026) return 'an ellipsis (…)';
  if (code === 0xa0) return 'a non-breaking space';
  if (code < 32 || code === 127) return 'a hidden control character';
  return `the character “${char}”`;
}

/** One sentence for a field that has text that cannot be sent: which field, and what to do. `field` reads like "the key". */
export function unsendableMessage(field: string, char: string): string {
  return `${field[0].toUpperCase()}${field.slice(1)} has ${describe(char)}, which cannot be sent. Retype it with plain letters, numbers and symbols.`;
}

/** What is wrong with the sign-in value or extra headers of an app, in plain words, or null when they can all be sent. */
export function headerProblem(input: {
  authType?: string | null;
  authValue?: string | null;
  headers?: Record<string, unknown> | null;
}): string | null {
  const { authType, authValue, headers } = input;
  // An OAuth value is JSON the app was signed in with, not text a person typed; only its key and token fields are sent
  if (typeof authValue === 'string' && authValue && (authType === 'bearer' || authType === 'api-key')) {
    const bad = unsendableCharacter(authValue);
    if (bad) return unsendableMessage(authType === 'bearer' ? 'the access token' : 'the key', bad);
  }
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (!name || !TOKEN.test(name)) {
        return `The extra header name “${name}” can only have letters, numbers and - _ . symbols.`;
      }
      if (typeof value === 'string') {
        const bad = unsendableCharacter(value);
        if (bad) return unsendableMessage(`the value of the extra header “${name}”`, bad);
      }
    }
  }
  return null;
}
