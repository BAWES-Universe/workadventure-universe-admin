/**
 * What this Orbit can do for voice notes (game: every bot hears voice notes), so the bot server and the game turn on a part only
 * when every part it needs is here. Each part is true once it is built and false until then; a missing bundle means an Orbit from
 * before, which the bot server reads as "hear only when the bot talks live, the Brick for guests stays text".
 *
 * - hearing: GET /api/bots/:id/voice/hearing and /api/guest-brick/hearing.
 * - reservations: reserving a note's minutes and reply in one go before anything is paid.
 * - turns: turn records, so a retried turn is never paid twice, and the answer kept for a moment for a reply that got lost.
 * - receipts: proof that an upload is the sender's own.
 * - carry: a guest's files and voice notes coming along when they sign in.
 */
export const VOICE_NOTE_CAPABILITIES = {
  v: 1,
  hearing: true,
  reservations: false,
  turns: false,
  receipts: false,
  carry: false,
} as const;
