'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import styles from './scroll-row.module.css';

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
  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
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
  const go = (direction: 1 | -1) => {
    const el = row.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: 'smooth' });
  };
  const Icon = action?.icon;
  return (
    <section className={`${styles.section} ${className ?? ''}`} aria-labelledby={id} data-testid={testId}>
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
        <div ref={row} className={styles.row} data-back={more.back} data-next={more.next} onScroll={measure}>
          {children}
        </div>
      )}
    </section>
  );
}
