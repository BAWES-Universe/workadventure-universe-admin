import { createLucideIcon } from 'lucide-react';

/**
 * A ringed planet: what a universe is, in Orbit and in the game's Explore list (Tabler's "planet", MIT, which the game
 * uses). Lucide has no planet, so it is drawn here on Lucide's 24px grid and 2px stroke to sit with the other icons.
 */
export const Planet = createLucideIcon('planet', [
  [
    'path',
    {
      d: 'M18.816 13.58c2.292 2.138 3.546 4 3.092 4.9c-.745 1.46-5.783-.259-11.255-3.838c-5.47-3.579-9.304-7.664-8.56-9.123c.464-.91 2.926-.444 5.803.805',
      key: 'ring',
    },
  ],
  ['path', { d: 'M5 12a7 7 0 1 0 14 0a7 7 0 1 0-14 0', key: 'body' }],
]);
