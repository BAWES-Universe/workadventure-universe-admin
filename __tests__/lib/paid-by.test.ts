import { paidBy, payerFromRow, payerToRow } from '@/lib/paid-by';

describe('the "Paid by" label', () => {
  it('says "you" to the person who pays, and names them to anyone else', () => {
    const payer = { kind: 'person' as const, personId: 'sara', name: 'Sara' };
    expect(paidBy(payer, 'sara')).toEqual({ payer: 'you', payerName: null, label: 'Paid by you' });
    expect(paidBy(payer, 'omar')).toEqual({ payer: 'sponsor', payerName: 'Sara', label: 'Paid by Sara' });
    expect(paidBy({ kind: 'person', personId: 'sara', name: '  ' }, 'omar').label).toBe('Paid by someone else');
  });

  it('names a universe that pays ("Paid by BAWES Universe") and Universe itself when nobody else does', () => {
    expect(paidBy({ kind: 'sponsor', name: 'BAWES Universe' }, 'omar')).toEqual({ payer: 'sponsor', payerName: 'BAWES Universe', label: 'Paid by BAWES Universe' });
    expect(paidBy({ kind: 'platform' }, 'omar')).toEqual({ payer: 'universe', payerName: null, label: 'Paid by Universe' });
    expect(paidBy({ kind: 'sponsor', name: '   ' }, null).label).toBe('Paid by Universe');
  });

  it('a reader nobody knows (a guest) never reads "you"', () => {
    expect(paidBy({ kind: 'person', personId: 'sara', name: 'Sara' }, null).label).toBe('Paid by Sara');
  });

  it('is kept on a receipt as it was and reads the same later', () => {
    for (const payer of [{ kind: 'person' as const, personId: 'sara', name: 'Sara' }, { kind: 'sponsor' as const, name: 'BAWES Universe' }, { kind: 'platform' as const }]) {
      expect(payerFromRow(payerToRow(payer))).toEqual(payer);
    }
  });
});
