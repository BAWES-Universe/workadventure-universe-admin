import { artifactKindLabel } from '@/lib/artifact-labels';
import { markdownDocument } from '@/lib/artifact-public';
import type { PublicView } from '@/lib/artifact-service';
import { PagePaymentsBridge } from '@/components/page-payments-bridge';
import { DocumentFrame } from '@/components/document-frame';
import { DownloadPill } from '@/components/artifact-download';
import { hasTable } from '@/lib/artifact-download';

/** The BAWES emblem in its colours (the game's favicon), small enough for the corner pill. */
function Emblem() {
  return (
    <svg viewBox="0 0 105 141" width="11" height="15" aria-hidden="true" className="shrink-0">
      <g transform="translate(-13 -60)">
        <path fill="#826625" d="M49.06 96.06L13 60H83.15L49.06 96.06Z" />
        <path fill="#4D3A16" d="M83.16 130.16L48.08 95.08L83.16 60L118.23 95.08L83.16 130.16Z" />
        <path fill="#F47026" d="M13.03 200.3L50.09 163.24L83.19 200.3H13.03Z" />
        <path fill="#EE2528" d="M118.23 165.23L83.16 130.16L48.08 95.08L13.01 130.16L48.08 165.24L83.15 200.3L118.23 165.23Z" />
      </g>
    </svg>
  );
}

/**
 * The one piece of branding: a small quiet pill that opens Universe. On the shared page it floats over the artifact in the
 * bottom right corner and opens Universe in a new tab, so the artifact stays where it was.
 */
function MadeWithUniverse({ href, floating = false }: { href: string; floating?: boolean }) {
  return (
    <a
      href={href}
      {...(floating ? { target: '_blank', rel: 'noopener' } : {})}
      data-testid="madeWithUniverse"
      className={`inline-flex h-7 items-center gap-[7px] rounded-full border border-white/12 pl-[9px] pr-[11px] text-[11.5px] font-semibold leading-none text-[#b3acc7] no-underline hover:text-[#f3f1fa] [font-family:var(--font-inter),system-ui,sans-serif] ${
        floating
          ? 'bg-[#0A0814]/72 shadow-[0_4px_14px_rgba(0,0,0,.35)] backdrop-blur-[6px] hover:bg-[#0A0814]/90'
          : 'bg-white/6 hover:bg-white/10'
      }`}
    >
      <Emblem />
      Made with Universe
    </a>
  );
}

function Frame({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <main data-shared-page className="flex min-h-dvh flex-col gap-4 bg-[#0A0814] px-4 py-5 text-[#f3f1fa] [font-family:var(--font-inter),system-ui,sans-serif] pb-[max(1.25rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
      {children}
      <footer className="flex justify-end">{footer}</footer>
    </main>
  );
}

/**
 * The artifact itself in its locked frame, view only: a document drawn from its text, anything else from its own address.
 * A link in either opens in a new tab when tapped, as the other site itself (it never takes this page away).
 */
function ArtifactFrame({ view, className }: { view: PublicView; className: string }) {
  return view.content !== null ? (
    <DocumentFrame title={view.title} html={markdownDocument(view.content)} className={className} />
  ) : (
    <iframe title={view.title} sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" src={view.url ?? undefined} referrerPolicy="no-referrer" data-artifact-frame className={className} />
  );
}

/** The artifact's header and its locked box, the same as the game's window: view only. */
export function ArtifactBox({ view }: { view: PublicView }) {
  const kind = artifactKindLabel(view.kind);
  return (
    <>
      <header className="flex items-center gap-3" data-testid="publicArtifactHeader">
        <span aria-hidden="true" style={{ background: kind.color }} className="grid size-10 shrink-0 place-items-center rounded-lg text-[10px] font-bold tracking-wide text-white">
          {kind.badge}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-semibold leading-snug [font-family:var(--font-space-grotesk),system-ui,sans-serif]">{view.title}</h1>
          <p className="truncate text-[13px] text-[#b3acc7]">
            By {view.makerName} · Version {view.version}
          </p>
        </div>
      </header>
      {/* On paper the box is just the document: no border, corners, clipping or tint, so nothing of the document can be cut */}
      <div className="min-h-[60dvh] flex-1 overflow-hidden rounded-2xl border border-[#2a2638] bg-[#15121f] print:min-h-0 print:overflow-visible print:rounded-none print:border-0 print:bg-white">
        <ArtifactFrame view={view} className="block size-full min-h-[60dvh] border-0" />
      </div>
    </>
  );
}

/**
 * What anyone with the link sees (Orbit #711): just the artifact, filling the window, with only the small "Made with Universe"
 * badge floating in the bottom right corner. The name, maker and version header stays in the game's window.
 */
export function PublicArtifact({ view, universeUrl, artifactId }: { view: PublicView; universeUrl: string; artifactId?: string }) {
  return (
    <main data-shared-page className="fixed inset-0 bg-[#0A0814] print:relative print:inset-auto" data-testid="publicArtifact">
      <ArtifactFrame view={view} className="block size-full border-0" />
      {artifactId && view.url !== null ? <PagePaymentsBridge artifactId={artifactId} version={view.version} /> : null}
      {/* Never on paper: the pills sit over the page only on screen */}
      <div className="fixed bottom-[max(0.75rem,env(safe-area-inset-bottom))] right-[max(0.75rem,env(safe-area-inset-right))] z-10 flex items-center gap-2 print:hidden">
        {view.content !== null ? <DownloadPill title={view.title} markdown={view.content} hasTables={hasTable(view.content)} /> : null}
        <MadeWithUniverse href={universeUrl} floating />
      </div>
    </main>
  );
}

/** Not there, switched off, run out or deleted: one answer for all of them. */
export function LinkNotAvailable({ universeUrl, tryAgain = false }: { universeUrl: string; tryAgain?: boolean }) {
  return (
    <Frame footer={<MadeWithUniverse href={universeUrl} />}>
      <div className="grid flex-1 place-content-center gap-2 text-center" role="alert">
        <h1 className="text-[22px] font-bold [font-family:var(--font-space-grotesk),system-ui,sans-serif]">
          {tryAgain ? 'This could not be loaded' : 'This link is not available'}
        </h1>
        <p className="text-[15px] text-[#b3acc7]">
          {tryAgain ? 'Try again in a moment.' : 'It was turned off or the artifact was deleted.'}
        </p>
      </div>
    </Frame>
  );
}
