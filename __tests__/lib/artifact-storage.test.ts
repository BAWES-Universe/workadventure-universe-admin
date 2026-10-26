import { artifactFiles } from '@/lib/artifact-storage';

const send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: (command: unknown) => send(command) })),
  PutObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
  DeleteObjectsCommand: jest.fn((input: unknown) => ({ input })),
}));

beforeAll(() => {
  process.env.ARTIFACTS_S3_BUCKET = 'bucket';
  process.env.ARTIFACTS_S3_ENDPOINT = 'https://s3.example.test';
  process.env.ARTIFACTS_S3_ACCESS_KEY_ID = 'key';
  process.env.ARTIFACTS_S3_SECRET_ACCESS_KEY = 'secret';
  process.env.ARTIFACTS_PUBLIC_URL = 'https://files.example.test';
});
beforeEach(() => send.mockReset());

describe('artifactFiles.remove', () => {
  it('does nothing for no keys', async () => {
    await artifactFiles.remove([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('removes the keys in one request', async () => {
    send.mockResolvedValue({});
    await artifactFiles.remove(['a', 'b']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.Delete.Objects).toEqual([{ Key: 'a' }, { Key: 'b' }]);
  });

  it('fails when the bucket answers 200 but could not remove some of them, so the caller tries again', async () => {
    send.mockResolvedValue({ Errors: [{ Key: 'b', Code: 'InternalError' }] });
    await expect(artifactFiles.remove(['a', 'b'])).rejects.toThrow(/would not remove 1 file/);
  });
});
