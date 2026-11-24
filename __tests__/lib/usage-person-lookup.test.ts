/** A lookup that failed says so, so a writer never calls a signed-in person a guest because the database blinked. */
jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: jest.fn() } } }));
import { prisma } from '@/lib/db';
import { resolveUsagePerson } from '@/lib/usage-person';

const find = prisma.user.findUnique as jest.Mock;

describe('resolveUsagePerson', () => {
  beforeEach(() => find.mockReset());

  it('marks a lookup that failed, and keeps the bot server’s own word', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    find.mockRejectedValue(new Error('db down'));
    expect(await resolveUsagePerson('wa-sara', undefined)).toEqual({ personId: null, guest: null, lookupFailed: true });
    expect(await resolveUsagePerson('wa-sara', false)).toEqual({ personId: null, guest: false, lookupFailed: true });
  });

  it('does not mark an account that is not there, or a person found', async () => {
    find.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'u1', isGuest: false });
    expect(await resolveUsagePerson('wa-nobody', undefined)).toEqual({ personId: null, guest: true });
    expect(await resolveUsagePerson('wa-sara', undefined)).toEqual({ personId: 'u1', guest: false });
  });
});
