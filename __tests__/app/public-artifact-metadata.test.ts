import { generateMetadata } from '@/app/a/[id]/page';
import { ArtifactError } from '@/lib/artifacts';
import { openByLink, type PublicView } from '@/lib/artifact-service';

jest.mock('@/lib/artifact-service', () => ({ openByLink: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const opened = openByLink as jest.MockedFunction<typeof openByLink>;
const page: PublicView = { title: 'Dubai trip, day 3', kind: 'page', makerName: 'Laura', version: 4, url: 'https://artifacts.example/p.html', content: null };
const metadataFor = (id: string) => generateMetadata({ params: Promise.resolve({ id }) });
const emblem = {
  icon: { url: '/assets/favicon-trans-512x512.png', sizes: '512x512', type: 'image/png' },
  apple: { url: '/assets/apple-touch-icon-180x180.png', sizes: '180x180' },
};

describe('what a pasted artifact link previews as', () => {
  beforeEach(() => opened.mockReset());

  it('names the artifact and who made it, and nothing of its content', async () => {
    opened.mockResolvedValue({ ...page, content: '# Secret notes' });
    const metadata = await metadataFor('a1');
    expect(metadata.title).toBe('Dubai trip, day 3');
    expect(metadata.description).toBe('Page by Laura');
    expect(metadata.openGraph).toEqual({ title: 'Dubai trip, day 3', description: 'Page by Laura' });
    expect(JSON.stringify(metadata)).not.toContain('Secret notes');
    expect(JSON.stringify(metadata)).not.toContain('artifacts.example');
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("shows the game's Universe mark as the tab icon, not the default one", async () => {
    opened.mockResolvedValue(page);
    expect((await metadataFor('icon')).icons).toEqual(emblem);
  });

  it('uses the same kind names as the game cards', async () => {
    for (const [kind, name] of [['app', 'Mini app'], ['markdown', 'Document'], ['svg', 'Drawing']] as const) {
      opened.mockResolvedValue({ ...page, kind });
      expect((await metadataFor(`k-${kind}`)).description).toBe(`${name} by Laura`);
    }
  });

  it('keeps the plain "Universe" for a link that is not available or could not be loaded', async () => {
    opened.mockRejectedValueOnce(new ArtifactError('not_found', 404, 'No such artifact.'));
    const gone = await metadataFor('gone');
    expect(gone).toEqual({ title: 'Universe', icons: emblem, robots: { index: false, follow: false }, referrer: 'no-referrer' });
    opened.mockRejectedValueOnce(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await metadataFor('broken')).title).toBe('Universe');
  });
});
