import { marked } from 'marked';

/**
 * The one script a document carries: it tells the page how tall the document is, so printing the page prints all of it (a
 * frame cannot size itself). It carries nothing else and reads nothing. The document's own policy allows this script by its
 * hash and no other, so no script a document writes in its text ever runs.
 */
export const HEIGHT_SCRIPT = "(function(){function t(){parent.postMessage({artifactHeight:document.documentElement.scrollHeight},'*')}addEventListener('load',t);addEventListener('resize',t);if(window.ResizeObserver)new ResizeObserver(t).observe(document.body)})()";
/** Its sha256, as the policy names it (a test checks it still matches the script). It is a constant because this file also runs in the browser. */
export const HEIGHT_SCRIPT_HASH = '/QxzRHGhEbVovuN6prREuWyD5P9DPc2sOhEP2J+zejY=';

/**
 * A document for the public link page: the Markdown drawn as HTML, in a page of its own that the page shows in an iframe
 * without its own origin. The document's own policy blocks everything but styles, https images and the one script above
 * (by its hash), so nothing a document says can run or reach anything of the viewer.
 */
export function markdownDocument(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; script-src 'sha256-${HEIGHT_SCRIPT_HASH}'">
<base target="_blank">
<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 20px 18px 32px; background: #15121f; color: #f3f1fa; font: 15px/1.6 Inter, system-ui, sans-serif; overflow-wrap: anywhere; }
h1, h2, h3, h4 { font-family: "Space Grotesk", Inter, system-ui, sans-serif; line-height: 1.25; margin: 1.2em 0 .4em; }
h1 { font-size: 1.7rem; margin-top: 0; } h2 { font-size: 1.35rem; } h3 { font-size: 1.1rem; }
a { color: #c4b5fd; } p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
code { font: .88em ui-monospace, Menlo, Consolas, monospace; background: rgba(255,255,255,.08); padding: .1em .35em; border-radius: 6px; }
pre { background: #0a0814; border: 1px solid #2a2638; border-radius: 12px; padding: 12px; overflow-x: auto; } pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #8629fc; margin-left: 0; padding-left: 14px; color: #b3acc7; }
table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; font-size: 14px; }
/* The page breaks words anywhere, which would shrink every column to one letter and make each row thousands of pixels tall: a cell keeps to one line, and a table wider than the window scrolls sideways. */
th, td { border: 1px solid #2a2638; padding: 6px 10px; text-align: left; vertical-align: top; white-space: nowrap; overflow-wrap: normal; word-break: normal; } th { background: rgba(255,255,255,.07); }
img { max-width: 100%; height: auto; } hr { border: 0; border-top: 1px solid #2a2638; }
@media print {
  body { background: #fff; color: #111; padding: 0; font-size: 12pt; }
  a { color: #1d4ed8; } code, pre { background: #f3f4f6; color: #111; border-color: #d1d5db; } blockquote { color: #444; }
  table { display: table; width: 100%; overflow: visible; font-size: 10pt; }
  th, td { white-space: normal; overflow-wrap: break-word; border-color: #9ca3af; } th { background: #e5e7eb; }
  thead { display: table-header-group; } tr, img, pre { break-inside: avoid; } h1, h2, h3, h4 { break-after: avoid; }
}
</style><script>${HEIGHT_SCRIPT}</script></head><body>${html}</body></html>`;
}
