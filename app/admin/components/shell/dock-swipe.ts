export type SwipeSample = { x: number; time: number };

/** Use only the last 100ms, including release: dragging, then holding still is not a flick. */
export function swipeVelocity(samples: SwipeSample[], direction: number): number {
  const last = samples[samples.length - 1];
  if (!last) return 0;
  const first = samples.find((sample) => last.time - sample.time <= 100);
  if (!first || last.time === first.time) return 0;
  return ((last.x - first.x) * direction) / (last.time - first.time);
}

/** Position is in tab widths; velocity is in logical pixels/ms (positive goes toward Space). */
export function snapDockIndex(position: number, velocity: number, slots: number): number {
  const target = Math.abs(velocity) > 0.4
    ? velocity > 0 ? Math.floor(position) + 1 : Math.ceil(position) - 1
    : Math.round(position);
  return Math.max(0, Math.min(slots - 1, target));
}
