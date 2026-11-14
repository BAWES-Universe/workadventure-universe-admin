/**
 * The secret check of the look before sharing a Brick as a template (game #2008, Brick 17). No database here.
 *
 * What is shared is words the maker wrote: the Brick's instructions, its one line, its first thing to try and the routines
 * they chose to add. Words are where a key, a password or a private address ends up by accident ("use this token: ..."),
 * so the look says so before anything leaves. A secret blocks sharing until the maker takes it out; a personal detail (an
 * email address, a phone number) is shown as a warning only, because a template about "writing to my team" can honestly
 * name a public contact, and the maker has just read it in the look.
 *
 * The check says where it found something and shows the first characters only, never the whole value.
 */

export type FindingKind = 'secret' | 'detail';

export interface Finding {
  kind: FindingKind;
  /** The part of the template it was found in: description, instructions, firstThing or a routine ("routine 2"). */
  where: string;
  /** What it looks like, in words ("a private key", "an email address"). */
  what: string;
  /** The first characters, so the maker can find it. Never the whole value. */
  sample: string;
}

interface Pattern {
  kind: FindingKind;
  what: string;
  pattern: RegExp;
  /** A further test on the match, to keep ordinary words out. */
  accept?: (match: string) => boolean;
}

const hasDigit = (value: string) => /\d/.test(value);
const mixesCases = (value: string) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);

const PATTERNS: Pattern[] = [
  { kind: 'secret', what: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'secret', what: 'an AI or API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'secret', what: 'a GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { kind: 'secret', what: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'secret', what: 'an AWS key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'secret', what: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'secret', what: 'a payment key', pattern: /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{16,}/g },
  { kind: 'secret', what: 'a sign-in token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'secret', what: 'a bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
  { kind: 'secret', what: 'a link with a password in it', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi },
  {
    kind: 'secret',
    what: 'a password or key written out',
    pattern: /\b(?:password|passwd|passcode|secret|token|api[ _-]?key|access[ _-]?key)\b["']?\s*(?:is|=|:)\s*["']?[A-Za-z0-9_\-/+=.!@#$%^&*]{8,}/gi,
    // "the password is something you give it" is a sentence: a password has a digit in it
    accept: (match) => hasDigit(match.replace(/^[^=:]*?(?:\bis\b|=|:)\s*["']?/i, '')),
  },
  { kind: 'secret', what: 'a long key-like string', pattern: /\b[A-Za-z0-9+/_-]{40,}={0,2}/g, accept: mixesCases },
  { kind: 'detail', what: 'an email address', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'detail', what: 'a phone number', pattern: /(?<![\w.])\+?\d[\d\s().-]{8,}\d(?!\w)/g, accept: (match) => match.replace(/\D/g, '').length >= 9 },
];

/** The first characters of a match, enough to find it and never enough to use it. */
function sampleOf(match: string): string {
  const trimmed = match.trim();
  return trimmed.length <= 6 ? `${trimmed.slice(0, 2)}…` : `${trimmed.slice(0, 6)}…`;
}

/** What looks like a secret or a personal detail in one piece of text; the caller names the part it came from. */
export function findInText(text: string | null | undefined, where: string): Finding[] {
  if (!text) return [];
  const found: Finding[] = [];
  const taken: [number, number][] = [];
  for (const { kind, what, pattern, accept } of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (accept && !accept(match[0])) continue;
      const start = match.index ?? 0;
      const end = start + match[0].length;
      // The same text is reported once, under the first and most serious name it matches
      if (taken.some(([from, to]) => start < to && from < end)) continue;
      taken.push([start, end]);
      found.push({ kind, where, what, sample: sampleOf(match[0]) });
    }
  }
  return found;
}

/** Whether anything found must be taken out before sharing. */
export const blocksSharing = (findings: Finding[]): boolean => findings.some((finding) => finding.kind === 'secret');
