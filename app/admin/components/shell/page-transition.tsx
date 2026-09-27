/** A page arriving: a short rise and fade, nothing more. Give it a `key` that changes with the page. */
export function PageTransition({ children }: { children: React.ReactNode }) {
  return <div className="orbit-page-enter">{children}</div>;
}
