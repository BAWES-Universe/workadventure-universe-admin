import { parseNearbySharedItem } from '@/lib/nearby-shared';

const now = new Date('2026-10-26T10:00:00.000Z');
const FILE = 'user-refs/0b5c1a6e-3f2d-4c8b-9a71-2e4f6d8c0a1b.pdf';

const file = {
  itemKey: 'msg-1',
  kind: 'file',
  name: 'Lobby floor plan.pdf',
  fileId: FILE,
  mimeType: 'application/pdf',
  size: 19035,
  senderName: 'Sara',
  sentAt: '2026-10-26T09:49:00.000Z',
};

describe('an item shared in a nearby chat', () => {
  it('keeps an uploader file by its id', () => {
    expect(parseNearbySharedItem(file, now)).toEqual({
      itemKey: 'msg-1',
      kind: 'file',
      name: 'Lobby floor plan.pdf',
      link: null,
      fileId: FILE,
      mimeType: 'application/pdf',
      size: 19035,
      isVideo: false,
      senderName: 'Sara',
      mine: false,
      sentAt: new Date('2026-10-26T09:49:00.000Z'),
    });
  });

  it('keeps a link, and an image that is only a link', () => {
    expect(
      parseNearbySharedItem(
        { itemKey: 'msg-2 https://bawes.net', kind: 'link', name: 'https://bawes.net', link: 'https://bawes.net', senderName: 'Omar', sentAt: file.sentAt, mine: true },
        now,
      ),
    ).toEqual(expect.objectContaining({ kind: 'link', link: 'https://bawes.net', fileId: null, mine: true }));
    expect(
      parseNearbySharedItem(
        { itemKey: 'msg-3 0', kind: 'media', name: 'door.jpg', link: 'https://cdn.example.com/door.jpg', isVideo: false, senderName: 'Noura', sentAt: file.sentAt },
        now,
      ),
    ).toEqual(expect.objectContaining({ kind: 'media', link: 'https://cdn.example.com/door.jpg' }));
  });

  it('says only an image or video can be a video', () => {
    expect(parseNearbySharedItem({ ...file, isVideo: true }, now)?.isVideo).toBe(false);
    expect(parseNearbySharedItem({ ...file, kind: 'media', isVideo: true }, now)?.isVideo).toBe(true);
  });

  it('keeps no control characters, which Postgres would refuse', () => {
    expect(parseNearbySharedItem({ ...file, name: 'Lobby\u0000 plan.pdf\n', senderName: '\u0000Sara' }, now)).toEqual(
      expect.objectContaining({ name: 'Lobby  plan.pdf', senderName: 'Sara' }),
    );
    expect(parseNearbySharedItem({ ...file, name: '\u0000' }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, fileId: null, link: 'https://bawes.net/\u0000x' }, now)?.link).not.toContain('\u0000');
  });

  it('cuts a long name, key or sender to fit, as the game does', () => {
    const link = `https://bawes.net/${'x'.repeat(500)}`;
    const parsed = parseNearbySharedItem(
      { itemKey: `msg-9 ${link}`, kind: 'link', name: link, link, senderName: 'S'.repeat(150), sentAt: file.sentAt },
      now,
    );
    expect(parsed?.itemKey).toHaveLength(300);
    expect(parsed?.name).toHaveLength(300);
    expect(parsed?.senderName).toHaveLength(100);
    expect(parsed?.link).toBe(link);
  });

  it('never cuts an emoji in half at the limit', () => {
    const name = `${'x'.repeat(299)}🚪 door`;
    const parsed = parseNearbySharedItem({ ...file, itemKey: name, name }, now);
    expect(parsed?.itemKey).toBe('x'.repeat(299));
    expect(parsed?.name).toBe('x'.repeat(299));
  });

  it('takes an empty type as no type, as a browser sends for a file it does not know', () => {
    const parsed = parseNearbySharedItem({ ...file, mimeType: '' }, now);
    expect(parsed?.mimeType).toBeNull();
    expect(parsed?.fileId).toBe(FILE);
  });

  it('swaps a lone half of an emoji for a stand-in character', () => {
    const parsed = parseNearbySharedItem({ ...file, name: 'door \uD83D plan' }, now);
    expect(parsed?.name).toBe('door \uFFFD plan');
  });

  it('turns down an item that is missing something or has the wrong shape', () => {
    expect(parseNearbySharedItem(null, now)).toBeNull();
    expect(parseNearbySharedItem([], now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, itemKey: '' }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, kind: 'voice' }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, senderName: undefined }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, size: -1 }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, size: 1.5 }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, mine: 'yes' }, now)).toBeNull();
  });

  it('keeps an uploader file with a long extension', () => {
    const fileId = 'user-refs/0b5c1a6e-3f2d-4c8b-9a71-2e4f6d8c0a1b.webmanifest';
    expect(parseNearbySharedItem({ ...file, fileId }, now)?.fileId).toBe(fileId);
    const tooLong = `user-refs/0b5c1a6e-3f2d-4c8b-9a71-2e4f6d8c0a1b.${'a'.repeat(17)}`;
    expect(parseNearbySharedItem({ ...file, fileId: tooLong }, now)).toBeNull();
  });

  it('turns down a file id that is not an uploader id, and a link that is not a web link', () => {
    expect(parseNearbySharedItem({ ...file, fileId: '../../etc/passwd' }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, fileId: '0b5c1a6e-3f2d-4c8b-9a71-2e4f6d8c0a1b.pdf' }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, fileId: 'user-refs/../0b5c1a6e-3f2d-4c8b-9a71-2e4f6d8c0a1b.pdf' }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, fileId: null, link: 'javascript:alert(1)' }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, fileId: null, link: 'not a url' }, now)).toBeNull();
  });

  it('needs a link for a link, and a file id or a link for anything else', () => {
    expect(parseNearbySharedItem({ ...file, fileId: null }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, kind: 'link', link: 'https://bawes.net' }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, kind: 'link', fileId: null }, now)).toBeNull();
  });

  it('turns down a time that is not a time, or far in the future', () => {
    expect(parseNearbySharedItem({ ...file, sentAt: 'yesterday' }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, sentAt: 1761472140000 }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, sentAt: '2026-10-26T11:00:00.000Z' }, now)).toBeNull();
    expect(parseNearbySharedItem({ ...file, sentAt: '2026-10-26T10:04:00.000Z' }, now)).not.toBeNull();
  });
});
