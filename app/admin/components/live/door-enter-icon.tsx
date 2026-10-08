/**
 * Tabler's door-enter (MIT), the icon the game's chat uses on "Go to room", drawn here so going to a room looks the
 * same in Orbit as in the game. Orbit has no Tabler package; this is the one icon it needs from it.
 */
export function DoorEnterIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 12v.01" />
      <path d="M3 21h18" />
      <path d="M5 21v-16a2 2 0 0 1 2 -2h6m4 10.5v7.5" />
      <path d="M21 7h-7m3 -3l-3 3l3 3" />
    </svg>
  );
}
