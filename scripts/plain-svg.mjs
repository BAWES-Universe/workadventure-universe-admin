/**
 * A logo is drawn as a mask and is also served as a file of its own, so it must be plain shapes. This is an allowlist:
 * every element and every attribute has to be one of the names below (so no script in any namespace, no handlers, no
 * foreignObject, no links), and text is only allowed inside a title.
 */
const ELEMENTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'title', 'desc']);
const ATTRIBUTES = new Set([
  'xmlns', 'version', 'viewBox', 'width', 'height', 'id', 'd', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2',
  'fill', 'fill-rule', 'clip-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity',
  'opacity', 'transform', 'style', 'role', 'aria-hidden', 'preserveAspectRatio',
]);
const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=<>/"']+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** Values that can pull something in or run it. */
const UNSAFE_VALUE = /url\s*\(|javascript:|data:|@import|expression\s*\(|[<>]/i;

export function isPlainSvg(svg) {
  const body = svg.replace(/^\s*<\?xml[^>]*\?>/, '').trim();
  if (!body.startsWith('<svg')) return false;
  let stack = 0;
  let text = '';
  let last = 0;
  for (const tag of body.matchAll(TAG)) {
    text += body.slice(last, tag.index);
    last = tag.index + tag[0].length;
    const [, closing, name, attributes, selfClosing] = tag;
    if (!ELEMENTS.has(name)) return false;
    if (closing) {
      stack -= 1;
      if (stack < 0) return false;
      continue;
    }
    for (const attribute of attributes.matchAll(ATTRIBUTE)) {
      if (!ATTRIBUTES.has(attribute[1]) || UNSAFE_VALUE.test(attribute[2] ?? attribute[3] ?? '')) return false;
    }
    if (!selfClosing) stack += 1;
  }
  text += body.slice(last);
  // Anything left over that is not a tag (a comment, a doctype, a CDATA, a broken tag) is refused; plain text only belongs in a title
  return stack === 0 && !/[<>]/.test(text);
}
