import { parse } from 'tldts';

/**
 * The names a person sees while adding an app by its link (game #2001, Part 13): "Signs in with Zapier", and the name field filled
 * from the app. Built from the address alone, so nothing is guessed from the app's content: `mcp.zapier.com` reads "Zapier".
 */

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
  // The registrable name from the Public Suffix List, private suffixes too: `mcp.acme.github.io` is Acme's, not GitHub's, and `example.co.uk` is Example's
  const company = parse(host, { allowPrivateDomains: true }).domainWithoutSuffix;
  if (!company) return null;
  return company.charAt(0).toUpperCase() + company.slice(1);
}
