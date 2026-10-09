'use client';

import { useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { snapDockIndex, swipeVelocity, type SwipeSample } from './dock-swipe';

type Drag = {
  pointerId: number;
  startX: number;
  startY: number;
  base: number;
  width: number;
  direction: number;
  moved: boolean;
  samples: SwipeSample[];
};

export function useDockSwipe(activeIndex: number, slots: number, onSelect: (index: number) => void) {
  const drag = useRef<Drag | null>(null);
  const ignoreClicksUntil = useRef(0);
  const [preview, setPreview] = useState<{ base: number; position: number } | null>(null);
  const dragging = preview !== null && preview.base === activeIndex;

  function clearDrag(event: PointerEvent<HTMLDivElement>) {
    drag.current = null;
    setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function cancelDrag(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (drag.current.moved) ignoreClicksUntil.current = event.timeStamp + 500;
    clearDrag(event);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || drag.current) return;
    // A fresh press is always allowed, even immediately after a swipe.
    ignoreClicksUntil.current = 0;
    if (activeIndex < 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    // Leave both viewport edges to browser back/forward gestures, including in RTL.
    if (event.pointerType !== 'mouse' && (event.clientX < 24 || event.clientX > window.innerWidth - 24)) return;
    const style = getComputedStyle(event.currentTarget);
    const width = (event.currentTarget.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / slots;
    if (width <= 0) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: activeIndex,
      width,
      direction: style.direction === 'rtl' ? -1 : 1,
      moved: false,
      samples: [{ x: event.clientX, time: event.timeStamp }],
    };
  }

  function positionAt(current: Drag, x: number) {
    return Math.max(0, Math.min(slots - 1, current.base + ((x - current.startX) * current.direction) / current.width));
  }

  function sample(current: Drag, event: PointerEvent<HTMLDivElement>) {
    current.samples = [
      ...current.samples.filter((point) => event.timeStamp - point.time <= 100),
      { x: event.clientX, time: event.timeStamp },
    ];
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.base !== activeIndex) return cancelDrag(event);
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    sample(current, event);
    if (!current.moved) {
      // Decide intent before capturing; a vertical scroll must never become a tab switch.
      if (Math.abs(dy) >= 6 && Math.abs(dy) >= Math.abs(dx)) return clearDrag(event);
      if (Math.abs(dx) < 6) return;
      current.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setPreview({ base: current.base, position: positionAt(current, event.clientX) });
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    clearDrag(event);
    if (!current.moved) return;
    ignoreClicksUntil.current = event.timeStamp + 500;
    if (current.base !== activeIndex) return;
    sample(current, event);
    const target = snapDockIndex(positionAt(current, event.clientX), swipeVelocity(current.samples, current.direction), slots);
    if (target !== activeIndex) onSelect(target);
  }

  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    // Keyboard and assistive activation have detail=0 and must retain native Link behavior.
    if (event.detail > 0 && event.timeStamp <= ignoreClicksUntil.current) {
      event.preventDefault();
      event.stopPropagation();
      ignoreClicksUntil.current = 0;
    }
  }

  return {
    position: dragging ? preview.position : activeIndex,
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: cancelDrag,
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
        // Touch implicitly captures the link first. Its capture loss bubbles when the track takes over.
        if (event.target === event.currentTarget) cancelDrag(event);
      },
      onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current?.moved) cancelDrag(event);
      },
      onClickCapture,
    },
  };
}
