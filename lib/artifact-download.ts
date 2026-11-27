import { decodeHTML } from 'entities';
import { marked, type Token, type Tokens } from 'marked';

/**
* Download of a Document (a Markdown artifact), made in the browser from the text of the version on screen: the Markdown
* file itself, and when the document has tables, a spreadsheet file with one tab for each table. Nothing is stored or
* sent anywhere.
*/

/** One table of the document, as plain text. The first row is the heading row. */
export interface DocumentTable {
  /** The nearest heading above the table, which names its tab; empty when there is none. */
  title: string;
  rows: string[][];
}

/** A sheet's tab name may be this long at most. */
const SHEET_NAME_MAX = 31;
/** A file name is kept to this long, before its ending. */
const FILE_NAME_MAX = 100;
/** More tables than this in one document are not put in the spreadsheet (a workbook of hundreds of tabs helps no one). */
export const MAX_SHEET_TABS = 64;

/** How many tables a spreadsheet leaves out of a document with this many (none up to the limit). */
export function tablesOmitted(count: number): number {
  return Math.max(0, count - MAX_SHEET_TABS);
}

/** The text of inline Markdown, without its marks: **bold** is bold, [a link](url) is "a link". */
function plainOf(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens || tokens.length === 0) return fallback;
  let text = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'br':
        text += ' ';
        break;
      case 'html':
        // The page shows a tag written in a document as text, so the sheet keeps it as the same text
        text += (token as Tokens.HTML | Tokens.Tag).text;
        break;
      case 'escape':
      case 'codespan':
      case 'text':
        text += 'tokens' in token && token.tokens ? plainOf(token.tokens, token.text) : decode(token.text);
        break;
      case 'image':
        text += decode((token as Tokens.Image).text);
        break;
      default:
        text +=
          'tokens' in token && token.tokens
            ? plainOf(token.tokens, '')
            : decode('text' in token ? (token as { text: string }).text : token.raw);
    }
  }
  return text;
}

/** The character references Markdown leaves in text (&amp;, &#8364;, &eacute;), decoded once the way a browser reads them, so what the sheet holds is what the page shows. */
function decode(text: string): string {
  return decodeHTML(text);
}

/** Every table of a Markdown text, in order, each with the heading above it. Tables inside a quote or a list are found too; code is not looked into. */
export function markdownTables(markdown: string): DocumentTable[] {
  const tables: DocumentTable[] = [];
  let heading = '';
  const walk = (tokens: Token[]): void => {
    for (const token of tokens) {
      if (token.type === 'heading') {
        heading = plainOf((token as Tokens.Heading).tokens, (token as Tokens.Heading).text).trim();
      } else if (token.type === 'table') {
        const table = token as Tokens.Table;
        const row = (cells: Tokens.TableCell[]) => cells.map((cell) => plainOf(cell.tokens, cell.text).trim());
        tables.push({ title: heading, rows: [row(table.header), ...table.rows.map(row)] });
      } else if (token.type === 'blockquote') {
        walk((token as Tokens.Blockquote).tokens);
      } else if (token.type === 'list') {
        for (const item of (token as Tokens.List).items) walk(item.tokens);
      }
    }
  };
  walk(marked.lexer(markdown, { gfm: true }));
  return tables;
}

/** Whether the document has a table: the second choice of the download list shows only then. */
export function hasTable(markdown: string): boolean {
  return markdownTables(markdown).length > 0;
}

/** A name safe on every system: no path marks, no control characters, never empty, never more than a sensible length. */
export function fileNameOf(title: string, ending: string, version?: number): string {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  const base = (clean.slice(0, FILE_NAME_MAX).trim() || 'Document') + (version !== undefined ? ` (version ${version})` : '');
  return `${base}.${ending}`;
}

/**
* A tab name a spreadsheet accepts: at most 31 characters, never starting or ending with an apostrophe (checked after the
* cut, which may leave one at the end), never empty, and never "History" in any case, which a workbook keeps for itself.
* Anything it cannot keep is the fallback instead.
*/
function tabName(wanted: string, room: number, fallback: string): string {
  const name = wanted
    .slice(0, room)
    .replace(/^'+|'+$/g, '')
    .trim()
    .replace(/^'+|'+$/g, '');
  return name === '' || name.toLowerCase() === 'history' ? fallback : name;
}

/** Tab names for the tables: the heading above each (or "Table 3"), within the limits a spreadsheet sets, each once. */
export function sheetNamesOf(tables: DocumentTable[], fallback: (number: number) => string): string[] {
  const used = new Set<string>();
  return tables.map((table, index) => {
    const wanted = table.title.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim();
    const spare = tabName(fallback(index + 1), SHEET_NAME_MAX, 'Sheet');
    let name = tabName(wanted, SHEET_NAME_MAX, spare);
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` ${n}`;
      name = tabName(wanted, SHEET_NAME_MAX - suffix.length, spare).slice(0, SHEET_NAME_MAX - suffix.length).trim() + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/** The Markdown file, as it is. */
export function markdownFile(markdown: string): Blob {
  return new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
}

/**
* A spreadsheet file with one tab for each table. Every cell is written as plain text: a cell that says "=1+1" is the
* words "=1+1", never a formula, and a number-like text stays as written. The sheet code is loaded only now, when someone
* asked for the file.
*/
export async function spreadsheetFile(tables: DocumentTable[], fallbackName: (number: number) => string): Promise<Blob> {
  const XLSX = await import('xlsx');
  const kept = tables.slice(0, MAX_SHEET_TABS);
  const names = sheetNamesOf(kept, fallbackName);
  const book = XLSX.utils.book_new();
  kept.forEach((table, index) => {
    const sheet: import('xlsx').WorkSheet = {};
    let widest = 0;
    table.rows.forEach((row, r) => {
      widest = Math.max(widest, row.length);
      row.forEach((value, c) => {
        sheet[XLSX.utils.encode_cell({ r, c })] = { t: 's', v: value };
      });
    });
    sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(table.rows.length - 1, 0), c: Math.max(widest - 1, 0) } });
    sheet['!cols'] = Array.from({ length: widest }, (_, c) => ({
      wch: Math.min(60, Math.max(8, ...table.rows.map((row) => (row[c] ?? '').length + 2))),
    }));
    XLSX.utils.book_append_sheet(book, sheet, names[index]);
  });
  const bytes = XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** Puts a file in the person's downloads. */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The browser has started its download by now; the address is let go a little later so a slow one is not cut
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
