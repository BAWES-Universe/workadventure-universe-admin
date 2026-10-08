import { checkAiProviderRef } from '@/lib/ai-provider-ref';
import { prisma } from '@/lib/db';

jest.mock('@/lib/db', () => ({
  prisma: {
    botsAiProvider: {
      findUnique: jest.fn(),
    },
  },
}));

const findUnique = prisma.botsAiProvider.findUnique as jest.Mock;

describe('checkAiProviderRef', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([undefined, null, ''])('accepts an empty ref (%p) without a lookup', async (ref) => {
    await expect(checkAiProviderRef(ref)).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('accepts a ref that names an existing provider', async () => {
    findUnique.mockResolvedValueOnce({ providerId: 'deepseek' });
    await expect(checkAiProviderRef('deepseek')).resolves.toBeNull();
    expect(findUnique).toHaveBeenCalledWith({
      where: { providerId: 'deepseek' },
      select: { providerId: true },
    });
  });

  it('rejects a ref that names no provider', async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(checkAiProviderRef('someone-elses-key')).resolves.toBe(
      'AI provider "someone-elses-key" does not exist'
    );
  });

  it('lets an unchanged ref through even if its provider was deleted', async () => {
    await expect(checkAiProviderRef('deleted-provider', 'deleted-provider')).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('checks a changed ref against the providers table', async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(checkAiProviderRef('new-ref', 'old-ref')).resolves.toBe('AI provider "new-ref" does not exist');
  });
});
