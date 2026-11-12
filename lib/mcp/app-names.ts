/**
 * The names a person sees while adding an app by its link (game #2001, Part 13): "Signs in with Zapier", and the name field filled
 * from the app. Built from the address alone, so nothing is guessed from the app's content: `mcp.zapier.com` reads "Zapier".
 */
const SECOND_LEVELS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

export function nameFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  let host: string;
  try {
    host = new URL(address).hostname.toLowerCase();
  } catch {
    return null;
  }
  // An address that is a number has no name to read
  if (/^[\d.]+$/.test(host) || host.includes(':')) return null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  // example.co.uk keeps three labels; everything else keeps the two that are the company's
  const keep = labels.length >= 3 && SECOND_LEVELS.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
  const company = labels[labels.length - keep];
  if (!company) return null;
  return company.charAt(0).toUpperCase() + company.slice(1);
}
