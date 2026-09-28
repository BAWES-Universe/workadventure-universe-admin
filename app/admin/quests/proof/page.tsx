import { notFound } from 'next/navigation';
import QuestProofStudio from './QuestProofStudio';
import { isQuestProofEnabled } from './proof-model';

/** The production build cannot opt into the design proof, even if its public flag is set. */
export default function QuestProofPage() {
  if (!isQuestProofEnabled()) notFound();
  return <QuestProofStudio />;
}
