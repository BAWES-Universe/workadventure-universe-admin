/** readBody: an empty optional body is {}, but a body with something in it that is not JSON is a 400, never read as empty. */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { readBody } from '@/lib/bot-action-api';

const schema = z.object({ requesterKey: z.string().optional() }).strict();
const post = (body?: string) => new NextRequest('http://localhost/x', { method: 'POST', ...(body === undefined ? {} : { body }) });

describe('readBody', () => {
  it('takes an empty body as {} when the body is optional', async () => {
    expect(await readBody(post(), schema, true)).toEqual({ data: {} });
    expect(await readBody(post('  \n'), schema, true)).toEqual({ data: {} });
  });

  it('answers 400 for a body that is not JSON, also when the body is optional, so it never reaches the check as if nothing was sent', async () => {
    const answer = await readBody(post('{"requesterKey": "a",'), schema, true);
    expect(answer.response?.status).toBe(400);
    expect((await readBody(post('not json'), schema, true)).response?.status).toBe(400);
    expect((await readBody(post('not json'), schema)).response?.status).toBe(400);
  });

  it('keeps reading JSON that fits, and 400 for JSON that does not, and for no body when one is required', async () => {
    expect(await readBody(post('{"requesterKey":"a"}'), schema, true)).toEqual({ data: { requesterKey: 'a' } });
    expect((await readBody(post('{"other":1}'), schema, true)).response?.status).toBe(400);
    expect((await readBody(post(), schema)).response?.status).toBe(400);
  });
});
