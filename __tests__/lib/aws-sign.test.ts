/**
 * AWS Signature Version 4 for the free key check of an AWS voice key (#1910): checked against AWS's own published example
 * (the "get-vanilla" case of its signing test suite), so the signature AWS computes is the one sent.
 */
import { signAwsGet } from '@/lib/aws-sign';

const KEY = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

describe('signAwsGet', () => {
  it('matches AWS’s own example', () => {
    expect(signAwsGet(new URL('https://example.amazonaws.com/'), KEY, { region: 'us-east-1', service: 'service' }, new Date('2015-08-30T12:36:00Z'))).toEqual({
      'x-amz-date': '20150830T123600Z',
      Authorization:
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    });
  });

  it('signs the query in name order, so the order it was written in does not change the signature', () => {
    const at = new Date('2026-11-07T10:00:00Z');
    const scope = { region: 'eu-north-1', service: 'sts' };
    const one = signAwsGet(new URL('https://sts.eu-north-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15'), KEY, scope, at);
    const two = signAwsGet(new URL('https://sts.eu-north-1.amazonaws.com/?Version=2011-06-15&Action=GetCallerIdentity'), KEY, scope, at);
    expect(one).toEqual(two);
    expect(one.Authorization).toContain('Credential=AKIDEXAMPLE/20261107/eu-north-1/sts/aws4_request');
  });

  it('never carries the secret', () => {
    const headers = signAwsGet(new URL('https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15'), KEY, { region: 'us-east-1', service: 'sts' });
    expect(JSON.stringify(headers)).not.toContain(KEY.secretAccessKey);
  });
});
