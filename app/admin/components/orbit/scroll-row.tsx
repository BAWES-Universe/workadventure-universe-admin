'use client';

import Link from 'next/link';
import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import styles from './scroll-row.module.css';

/** How wide the fade is at the row's edge. The CSS gets it as --fade, so a card is always placed clear of it. */
export const FADE = 56;
/** A tap that comes while the last one is still moving continues from where that one is going, not from where it is. */
const MOVING_MS = 700;

/**
 * Where ‹ › take the row: the next card that isn't fully clear of the fade on the right goes to the left, just clear
 * of the fade there, so the card before it sinks into the shadow; ‹ does the same the other way. Cards are
 * `{ left, right }` in the row's own scroll coordinates. Never further than the row can go, and a row that would stop
 * with its first card half under the fade goes to its start instead.
 */
export function stepTarget(cards: { left: number; right: number }[], scrollLeft: number, viewWidth: number, contentWidth: number, direction: 1 | -1) {
  const max = Math.max(0, contentWidth - viewWidth);
  let target = scrollLeft + direction * viewWidth * 0.8;
  if (direction === 1) {
    const next = cards.find((card) => card.right > scrollLeft + viewWidth - FADE + 1);
    if (next && next.left - FADE > scrollLeft + 1) target = next.left - FADE;
  } else {
    const before = [...cards].reverse().find((card) => card.left < scrollLeft + FADE - 1);
    // A card too wide to sit between both fades keeps its left edge clear instead.
    if (before) target = Math.min(before.right - (viewWidth - FADE), before.left - FADE);
  }
  if (target <= FADE) return 0;
  if (target >= max - FADE) return max;
  return target;
}

/**
 * A section of Orbit whose items scroll sideways: its title and count, one action, and the row. The row fades on the
 * side that has more; with a mouse there is nothing to swipe, so ‹ › sit by the action. Both hide when it all fits.
 * `empty` takes the row's place when there is nothing in it.
 */
export function ScrollSection({
  id,
  title,
  count,
  action,
  label,
  empty,
  className,
  testId,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  action?: { href: string; label: string; icon?: LucideIcon } | null;
  /** What the arrows move through, for their names: "Back: your timeline". */
  label: string;
  empty?: ReactNode;
  className?: string;
  testId?: string;
  children?: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ back: false, next: false });
  // Where the row was last seen and the tap that is still moving it, if any.
  const seen = useRef(0);
  const moving = useRef<{ target: number; until: number } | null>(null);
  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    seen.current = el.scrollLeft;
    const back = el.scrollLeft > 4;
    const next = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setMore((current) => (current.back === back && current.next === next ? current : { back, next }));
  }, []);
  useEffect(() => {
    const el = row.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, children, empty]);
  // The cards changed their order (a room got busier) while the row sat at its start: the browser keeps the card it
  // was snapped to in view, which pushes the new first card out of sight, so the row goes back to its start.
  const order = Children.toArray(children)
    .map((child) => (isValidElement(child) ? String(child.key) : ''))
    .join('|');
  useLayoutEffect(() => {
    const el = row.current;
    if (el && seen.current <= 4 && el.scrollLeft > 4) el.scrollLeft = 0;
  }, [order]);
  const go = (direction: 1 | -1) => {
    const el = row.current;
    if (!el) return;
    const now = performance.now();
    const from = moving.current && now < moving.current.until ? moving.current.target : el.scrollLeft;
    const edge = el.getBoundingClientRect().left - el.scrollLeft;
    const cards = Array.from(el.children).map((child) => {
      const box = child.getBoundingClientRect();
      return { left: box.left - edge, right: box.right - edge };
    });
    const target = stepTarget(cards, from, el.clientWidth, el.scrollWidth, direction);
    moving.current = { target, until: now + MOVING_MS };
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ left: target, behavior: still ? 'auto' : 'smooth' });
  };
  const Icon = action?.icon;
  return (
    <section className={`${styles.section} ${className ?? ''}`} style={{ '--fade': `${FADE}px` } as CSSProperties} aria-labelledby={id} data-testid={testId}>
      <div className={styles.head}>
        <h2 id={id} className="orbit-display">
          {title}
          {typeof count === 'number' && count > 0 && <span className={styles.count}>{count.toLocaleString()}</span>}
        </h2>
        <span className={styles.tools}>
          {action && (
            <Link href={action.href} className={styles.action}>
              {Icon && <Icon size={15} aria-hidden="true" />}
              {action.label}
            </Link>
          )}
          {!empty && (more.back || more.next) && (
            <span className={styles.arrows}>
              <button type="button" className={styles.arrow} disabled={!more.back} aria-label={`Back: ${label}`} onClick={() => go(-1)}>
                <ChevronLeft aria-hidden="true" />
              </button>
              <button type="button" className={styles.arrow} disabled={!more.next} aria-label={`More: ${label}`} onClick={() => go(1)}>
                <ChevronRight aria-hidden="true" />
              </button>
            </span>
          )}
        </span>
      </div>
      {empty ?? (
        <div ref={row} className={styles.row} data-back={more.back} data-next={more.next} onScroll={measure} onWheel={() => (moving.current = null)} onPointerDown={() => (moving.current = null)}>
          {children}
        </div>
      )}
    </section>
  );
}
