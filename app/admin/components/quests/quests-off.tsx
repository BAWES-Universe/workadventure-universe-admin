import { EmptyCard } from '../ds';

/** A quest page while the proof slice is off: it exists (every page has a Back), but says there is nothing here. */
export function QuestsOff() {
  return (
    <EmptyCard
      kind="room"
      title="Quests aren’t switched on here."
      text="They’re being tried out on the dev deployment first."
      testId="quests-off"
    />
  );
}
