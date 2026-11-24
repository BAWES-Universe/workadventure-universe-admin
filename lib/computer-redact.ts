/**
 * What a computer job may say about the step it is on, made safe to store and show. A label is the agent's own words (or a line the runner took from it), and a runner that
 * could not name the step may have sent a raw machine command instead: `T=cjt_… + 7 commands`, a curl with its Authorization header, a git URL with a login in it. None of
 * that may be kept or shown: a secret in a label would be in the person's view, in anything that copies it, and in the database.
 *
 * A label that carries anything shaped like a secret is replaced WHOLE by a plain phrase (the rest of such a line cannot be trusted either); the check is made on the label as written
 * (where each of its lines begins) and again on the one line it makes. A clean one is returned as it is, on one line and short. Applied when a label is written and again when one is read, so a row stored before this rule never shows one.
 */

/** What is said when a step's own words cannot be shown. */
export const STEP_LABEL_FALLBACK = 'Working on it';
const STEP_LABEL_MAX = 200;

const CONTROL = /[\u0000-\u001f\u007f]/g;

const SECRET_SHAPES: readonly RegExp[] = [
  // A shell assignment where a command begins (the start, after ; && || | or a bracket, or after export/env/sudo/nohup/set): NAME=value, an environment variable the line sets (the job's key, a password, anything).
  // A query string (`?a=1&b=2`) or a word like width=10 in a sentence is not one
  /(?:^|;\s*|&&\s*|\|\|?\s*|\(\s*|\b(?:export|env|sudo|nohup|set)\s+)[A-Za-z_][A-Za-z0-9_]*=\S/,
  // Orbit's own job keys, and the shapes of other services' keys and tokens
  /\bcjt_[A-Za-z0-9_-]+/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/,
  // A header or flag that carries a credential
  /\b(?:authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token)\s*[:=]/i,
  // A cookie header carries a value: "Cookie:" with nothing after it is just a word (Sentry on #1025, S1)
  /\b(?:cookie|set-cookie)\s*[:=]\s*\S/i,
  // "Bearer x" and "Basic x" followed by something that LOOKS like a credential: a digit, one of + = _ ~, or (8 or more characters) a capital inside the run (base64 of "user:pass" is mixed case). Plain words after them
  // ("Basic information", "Basic Instructions", "basic input/output") are not. Spelled letter by letter because the flag-free form is needed for the capital test (Sentry on #1025, S1)
  /\b(?:[Bb][Ee][Aa][Rr][Ee][Rr]|[Bb][Aa][Ss][Ii][Cc])\s+(?=[A-Za-z0-9._~+/=-]*(?:\d|[+=_~])|(?=[A-Za-z0-9._~+/=-]{8})[A-Za-z0-9._~+/=-]*[a-z][A-Z])[A-Za-z0-9._~+/=-]{6,}/,
  // A flag that carries a credential: it begins a word (or follows a quote, a bracket, = : ;), so "pre-auth login" is not "-auth login"
  /(?:^|[\s"'(=:;])--?(?:password|passwd|token|secret|api-key|apikey|auth)\b(?:[=\s]+)\S/i,
  // curl -u name:password
  /(?:--user|-u)\s+\S+:\S/i,
  // A login in an address: scheme://user:password@host
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+(?::[^\s/@]*)?@/i,
];

/** A long unbroken run of letters and digits with both: what keys and tokens look like, and also some file names, so only the run is hidden, never the whole label. */
const TOKEN_LIKE = /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}/g;

/**
 * An assignment that begins a line (after any indent): the start of a command in text that has more than one line. Looked for in the text as the agent wrote it, BEFORE its lines are joined: once
 * "Checking service\nPASSWORD=hunter2 curl …" is on one line the assignment sits after plain words and is no longer where a command begins. A tab counts as a line break here (it separates, it is never prose).
 */
const LINE_ASSIGNMENT = /(?:^|\n)[ \t]*[A-Za-z_][A-Za-z0-9_]*=\S/;
const LINE_BREAKS = /\r\n?|[\u000b\u000c\u0085\u2028\u2029\t]/g;

/** True when the text carries a shape that is a secret whatever else is around it (a key, a token, a credential in a header, flag or address, or a shell assignment, at the start of any of its lines). */
export function hasSecretShape(text: string): boolean {
  return SECRET_SHAPES.some((shape) => shape.test(text)) || LINE_ASSIGNMENT.test(text.replace(LINE_BREAKS, '\n'));
}

/**
 * The label a job may show for its step: null when there is none, the plain phrase when the words carry a secret shape, and otherwise the words on one line, with only a long key-like run hidden
 * (as `…`) and cut between whole characters at 200.
 */
export function cleanStepLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const oneLine = label.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  // Judged on the words as they were written (a command begins where a line does) AND on the one line they make (a command after `;` or `&&` on a line)
  if (hasSecretShape(label) || hasSecretShape(oneLine)) return STEP_LABEL_FALLBACK;
  const shown = oneLine.replace(TOKEN_LIKE, '…');
  const letters = Array.from(shown);
  return letters.length > STEP_LABEL_MAX ? `${letters.slice(0, STEP_LABEL_MAX - 1).join('').trimEnd()}…` : shown;
}
