'use client';

import { useEffect, useRef, useState } from 'react';

const DOWNLOAD_ICON = (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 20h14" />
  </svg>
);

/** How long the "Saved" line stays. */
const NOTE_MS = 3000;

type Note = { kind: 'saved'; name: string } | { kind: 'failed' };

/**
 * The quiet "Download" pill on a shared Document: its Markdown file, and when it has tables a spreadsheet file with one tab
 * for each table. Made in the browser from the text of the version this page shows (the published one for a link), so
 * nothing new is asked of the server. The file code, and the sheet code with it, load only when someone taps.
 */
export function DownloadPill({ title, markdown, hasTables }: { title: string; markdown: string; hasTables: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // A tap anywhere else puts the list away
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  function say(next: Note) {
    setNote(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), NOTE_MS);
  }

  async function download(what: 'markdown' | 'spreadsheet') {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    try {
      const files = await import('@/lib/artifact-download');
      const name = files.fileNameOf(title, what === 'markdown' ? 'md' : 'xlsx');
      const blob =
        what === 'markdown' ? files.markdownFile(markdown) : await files.spreadsheetFile(files.markdownTables(markdown), (n) => `Table ${n}`);
      files.saveFile(blob, name);
      say({ kind: 'saved', name });
    } catch (error) {
      console.warn('Could not make the file', error instanceof Error ? error.message : 'unknown');
      say({ kind: 'failed' });
    } finally {
      setBusy(false);
    }
  }

  function tapped() {
    if (busy) return;
    if (!hasTables) void download('markdown');
    else setOpen((was) => !was);
  }

  return (
    <div ref={box} className="relative">
      {open ? (
        <div role="menu" data-testid="downloadMenu" className="absolute bottom-full right-0 mb-2 w-[250px] overflow-hidden rounded-xl border border-white/15 bg-[#1f1b2e] shadow-[0_10px_30px_rgba(0,0,0,.5)]">
          <button type="button" role="menuitem" data-testid="downloadMarkdown" onClick={() => void download('markdown')} className="block w-full border-b border-white/10 px-3.5 py-2.5 text-left hover:bg-white/8">
            <b className="block text-[14px] font-semibold text-[#f3f1fa]">Document</b>
            <span className="text-[12px] text-[#b3acc7]">Markdown file (.md)</span>
          </button>
          <button type="button" role="menuitem" data-testid="downloadSheet" onClick={() => void download('spreadsheet')} className="block w-full px-3.5 py-2.5 text-left hover:bg-white/8">
            <b className="block text-[14px] font-semibold text-[#f3f1fa]">Table as spreadsheet</b>
            <span className="text-[12px] text-[#b3acc7]">Spreadsheet file (.xlsx), one tab per table</span>
          </button>
        </div>
      ) : null}
      {note ? (
        <p
          role={note.kind === 'failed' ? 'alert' : 'status'}
          data-testid="downloadNote"
          className="absolute bottom-full right-0 mb-2 w-max max-w-[min(80vw,320px)] rounded-full border border-white/15 bg-[#2a2640]/95 px-3.5 py-2 text-[13px] text-[#f3f1fa]"
        >
          {note.kind === 'failed' ? 'Could not make the file. Try again.' : `Saved “${note.name}”`}
        </p>
      ) : null}
      <button
        type="button"
        onClick={tapped}
        disabled={busy}
        aria-haspopup={hasTables ? 'menu' : undefined}
        aria-expanded={hasTables ? open : undefined}
        data-testid="downloadPill"
        className={`relative inline-flex h-7 items-center gap-1.5 rounded-full border border-white/12 px-[11px] text-[11.5px] font-semibold leading-none text-[#b3acc7] [font-family:var(--font-inter),system-ui,sans-serif] before:absolute before:-inset-2 before:content-[''] hover:text-[#f3f1fa] disabled:opacity-60 ${
          open ? 'bg-[#0A0814]/90 text-[#f3f1fa]' : 'bg-[#0A0814]/72 hover:bg-[#0A0814]/90'
        } shadow-[0_4px_14px_rgba(0,0,0,.35)] backdrop-blur-[6px]`}
      >
        {DOWNLOAD_ICON}
        Download
      </button>
    </div>
  );
}
