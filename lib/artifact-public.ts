import { Marked } from 'marked';

/**
 * The one script a document carries: it tells the page how tall the document is on screen and how tall it is on paper at a
 * few page widths, so printing the page prints all of it (a frame cannot size itself, and paper wraps text the screen does
 * not). It answers whenever the page asks, so a report sent before the page was listening is never lost. It carries nothing else and reads nothing. The document's own policy allows this script by its
 * hash and no other, so no script a document writes in its text ever runs.
 */
export const HEIGHT_SCRIPT = "(function(){var W=[360,480,600,720,840];function t(){var p=document.getElementById('paper'),r=[];if(p){var o=p.style.width;W.forEach(function(w){p.style.width=w+'px';r.push([w,p.scrollHeight])});p.style.width=o}parent.postMessage({artifactHeight:document.documentElement.scrollHeight,artifactPrintHeights:r},'*')}addEventListener('load',t);addEventListener('resize',t);addEventListener('message',function(e){if(e.source===parent)t()});addEventListener('DOMContentLoaded',function(){if(window.ResizeObserver)new ResizeObserver(t).observe(document.body);t()})})()";
/** Its sha256, as the policy names it (a test checks it still matches the script). It is a constant because this file also runs in the browser. */
export const HEIGHT_SCRIPT_HASH = 'xQS9iP0KuKrAfzWvkW/kuY5AjPVUABxCy8DKcnBncEY=';

/** Text that is safe between tags and inside a quoted value. */
const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * A document's own HTML is never drawn as HTML, in a block or inside a line: it shows as the text it is. A tag written in a
 * document (a meta refresh that sends the frame to another address, a form, a script, a frame) therefore never reaches the
 * page as a tag at all, whatever the document's policy says.
 */
const documents = new Marked({
  renderer: {
    html: (html: string) => escapeText(html),
  },
});

/**
 * How a document looks on paper: white, the table fitted to the page, cells that wrap. The same rules are used twice: for
 * real, in the print styles, and under `.paper`, a hidden copy of the document laid out at the width of a page, which the
 * script measures so the page knows the printed height before anything is printed. Both can never drift apart.
 */
function printRules(scope: string): string {
  const on = (selectors: string[], rules: string) => `  ${selectors.map((selector) => `${scope} ${selector}`.trim()).join(', ')} { ${rules} }`;
  return [
    on(['a'], 'color: #1d4ed8;'),
    on(['code', 'pre'], 'background: #f3f4f6; color: #111; border-color: #d1d5db;'),
    on(['blockquote'], 'color: #444;'),
    on(['table'], 'display: table; width: 100%; overflow: visible; font-size: 10pt;'),
    on(['th', 'td'], 'white-space: normal; overflow-wrap: anywhere; border-color: #9ca3af;'),
    on(['th'], 'background: #e5e7eb;'),
    on(['thead'], 'display: table-header-group;'),
    on(['tr', 'img', 'pre'], 'break-inside: avoid;'),
    on(['h1', 'h2', 'h3', 'h4'], 'break-after: avoid;'),
  ].join('\n');
}

/**
 * A document for the public link page: the Markdown drawn as HTML, in a page of its own that the page shows in an iframe
 * without its own origin. The document's own policy blocks everything but styles, https images and the one script above
 * (by its hash), so nothing a document says can run or reach anything of the viewer.
 */
export function markdownDocument(markdown: string): string {
  const html = documents.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
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
${printRules('')}
  .paper { display: none; }
}
/* A copy of the document laid out as paper (never shown), laid out at a few page widths only to measure its printed height. */
.paper { position: fixed; top: 0; left: -10000px; width: 720px; visibility: hidden; pointer-events: none; font-size: 12pt; }
.paper > :first-child { margin-top: 0; }
${printRules('.paper')}
</style><script>${HEIGHT_SCRIPT}</script></head><body>${html}<div id="paper" class="paper" aria-hidden="true">${html}</div></body></html>`;
}
