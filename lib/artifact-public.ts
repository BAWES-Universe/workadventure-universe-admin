import { marked } from 'marked';

/**
 * A document for the public link page: the Markdown drawn as HTML, in a page of its own that the page shows in an iframe
 * with every permission off (no scripts, no same origin). The page's own policy blocks everything but styles and https
 * images, so nothing a document says can run or reach anything of the viewer.
 */
export function markdownDocument(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:">
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
table { border-collapse: collapse; display: block; overflow-x: auto; } th, td { border: 1px solid #2a2638; padding: 6px 10px; }
img { max-width: 100%; height: auto; } hr { border: 0; border-top: 1px solid #2a2638; }
</style></head><body>${html}</body></html>`;
}
