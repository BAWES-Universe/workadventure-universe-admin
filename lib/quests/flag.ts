/**
 * The quests proof slice (game issue #511). Off unless the image was built with NEXT_PUBLIC_QUESTS_PROOF_SLICE=true,
 * which only the dev deployment's image is. Off: no Quests tab, no Quests section on You, the quest pages say so,
 * the quest-context API answers 404 and the bridge doesn't offer quests to the game.
 */
export function questsProofEnabled(): boolean {
  return process.env.NEXT_PUBLIC_QUESTS_PROOF_SLICE === 'true';
}
