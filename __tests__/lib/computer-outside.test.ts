import { asciiJson, checkOutsideManifest, readOutsideManifest, LIST_SEND_PIECE } from '@/lib/computer-outside';

const SHA = 'a'.repeat(64);
const list = (over: Record<string, unknown> = {}) => ({ files: [['f', '/opt/tool/run.sh', 12, 0o755, SHA], ['l', '/opt/tool/latest', 0, 0, 'run.sh']], packages: ['ffmpeg'], ...over });

describe('the list of what is outside a computer\'s home folder', () => {
  it('accepts a list to the last field and says what is wrong with one that is not', () => {
    expect(checkOutsideManifest(list())).toEqual({ ok: true, manifest: list() });
    expect(readOutsideManifest(list())).toEqual(list());
    for (const bad of [null, 'x', [], {}, { files: 'x', packages: [] }, list({ files: [['f', '/home/node/x', 1, 0, SHA]] }), list({ files: [['f', '/opt/a', 1, 0, 'nothex']] }), list({ packages: ['Bad Name!'] }), list({ files: [['f', '/opt/a', 1, 0, SHA], ['f', '/opt/a', 1, 0, SHA]] })]) {
      expect(checkOutsideManifest(bad)).toEqual({ ok: false, reason: 'invalid' });
      expect(readOutsideManifest(bad)).toBeNull();
    }
  });

  it('keeps the modes of the folders that are not 0755 (a private folder stays private on the new computer), checks them like a path, and a list without them is as before', () => {
    const dirs = [['/opt/zz/private', 0o700], ['/opt/zz/private/deeper', 0o750]];
    expect(checkOutsideManifest(list({ dirs }))).toEqual({ ok: true, manifest: list({ dirs }) });
    expect(readOutsideManifest(list({ dirs: [] }))).toEqual(list({ dirs: [] }));
    // No key at all stays no key (a copy made before they were kept)
    expect(Object.keys(readOutsideManifest(list())!)).toEqual(['files', 'packages']);
    for (const bad of ['no', [['/opt/a']], [['/etc2/a', 0o700]], [['/opt/../etc', 0o700]], [['opt/a', 0o700]], [['/opt/a', 0o10000]], [['/opt/a', -1]], [['/opt/a', 1.5]], [['/opt/a', 0o700], ['/opt/a', 0o700]], [['/opt/a/', 0o700]], [[1, 0o700]]]) {
      expect(checkOutsideManifest(list({ dirs: bad }))).toEqual({ ok: false, reason: 'invalid' });
    }
    // A folder name that is not valid UTF-8 is its own reason, as for a file
    expect(checkOutsideManifest(list({ dirs: [['/opt/bad-\udcff', 0o700]] }))).toEqual({ ok: false, reason: 'outside_name_not_utf8' });
    // The most is four folders for each file the list may hold: more is a computer that holds too much to carry (a reason of its own, as for too many files), not a list that is not one
    expect(checkOutsideManifest(list({ dirs: Array.from({ length: 20001 }, (_, i) => [`/opt/d${i}`, 0o700]) }))).toEqual({ ok: false, reason: 'outside_too_big' });
    expect(checkOutsideManifest(list({ dirs: Array.from({ length: 20000 }, (_, i) => [`/opt/d${i}`, 0o700]) })).ok).toBe(true);
  });

  it('a name with a lone surrogate (a file name that is not valid UTF-8) is its own reason, in a path or in where a link points, and a real pair is fine', () => {
    for (const odd of ['\udcff', '\ud800', 'a\udc80b', '\ud83d']) {
      expect(checkOutsideManifest(list({ files: [['f', `/opt/x-${odd}`, 1, 0, SHA]] }))).toEqual({ ok: false, reason: 'outside_name_not_utf8' });
      expect(checkOutsideManifest(list({ files: [['l', '/opt/x', 0, 0, `to-${odd}`]] }))).toEqual({ ok: false, reason: 'outside_name_not_utf8' });
      expect(readOutsideManifest(list({ files: [['f', `/opt/x-${odd}`, 1, 0, SHA]] }))).toBeNull();
    }
    expect(checkOutsideManifest(list({ files: [['f', '/opt/ال-\u{1F600}', 1, 0, SHA]] })).ok).toBe(true);
  });

  it('too many software names or files are their own reasons, at exactly the script\'s limits', () => {
    expect(checkOutsideManifest(list({ packages: Array.from({ length: 2000 }, (_, i) => `p${i}`) })).ok).toBe(true);
    expect(checkOutsideManifest(list({ packages: Array.from({ length: 2001 }, (_, i) => `p${i}`) }))).toEqual({ ok: false, reason: 'packages_too_many' });
    const files = (count: number) => Array.from({ length: count }, (_, i) => ['f', `/opt/f${i}`, 1, 0, SHA]);
    expect(checkOutsideManifest(list({ files: files(5000) })).ok).toBe(true);
    expect(checkOutsideManifest(list({ files: files(5001) }))).toEqual({ ok: false, reason: 'outside_too_big' });
  });

  it('asciiJson is plain ASCII that parses back to the same value, whatever the names, so a piece is the same length in characters and in bytes wherever it is cut', () => {
    const value = list({ files: [['f', '/opt/الملف-\u{1F600}-é\u007f', 1, 0, SHA]] });
    const text = asciiJson(value);
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
    expect(JSON.parse(text)).toEqual(value);
    expect(Buffer.byteLength(text)).toBe(text.length);
    expect(LIST_SEND_PIECE).toBeLessThan(60 * 1024);
  });
});
