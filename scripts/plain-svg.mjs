/**
 * A logo is drawn as a mask and is also served as a file of its own, so it must be plain shapes: no script, no event
 * handlers, no foreignObject, no scripts or pages pulled in by an address.
 */
const UNSAFE = /<\s*script|<\s*foreignObject|<\s*iframe|<\s*object|<\s*embed|<\s*image|<\s*use|\son[a-z]+\s*=|javascript:|data:text\/html|(?:xlink:)?href\s*=|<!ENTITY|<\?xml-stylesheet|@import/i;

export function isPlainSvg(svg) {
  return svg.includes('<svg') && !UNSAFE.test(svg);
}
