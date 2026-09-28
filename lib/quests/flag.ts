/**
 * The quests proof slice (game issue #511). On when running locally with `npm run dev` (unless
 * NEXT_PUBLIC_QUESTS_PROOF_SLICE=false), and in a built image only when it was built with
 * NEXT_PUBLIC_QUESTS_PROOF_SLICE=true, which production never is. Off: no Quests tab, no Quests section on You,
 * the quest pages say so, the quest-context API answers 404 and the bridge doesn't offer quests to the game.
 */
export function questsProofEnabled(): boolean {
  const flag = process.env.NEXT_PUBLIC_QUESTS_PROOF_SLICE;
  if (flag === 'true') return true;
  return process.env.NODE_ENV === 'development' && flag !== 'false';
}
