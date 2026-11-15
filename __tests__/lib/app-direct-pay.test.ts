import { amountToMinor, minorToText, currencyExponent, safeCheckoutUrl } from '@/lib/app-direct/pay';
import { catalogDefinition } from '@/lib/app-direct/catalog';
import { definitionSchema, hashDefinition } from '@/lib/app-direct/definition';
jest.mock('@/lib/app-direct/catalog', () => require('../helpers/example-gateway').catalogWithExample());

/** Payments for pages (game #2044, step 3): the exact amounts, where a buyer may be sent, and the payment contract of a definition. */

describe('amounts', () => {
  it('reads a three-decimal currency exactly', () => {
    expect(amountToMinor('4.500', 'KWD')).toBe(4500);
    expect(amountToMinor('4.5', 'kwd')).toBe(4500);
    expect(amountToMinor(0.001, 'KWD')).toBe(1);
    expect(amountToMinor('12', 'KWD')).toBe(12000);
  });

  it('reads two decimals and none', () => {
    expect(amountToMinor('19.99', 'USD')).toBe(1999);
    expect(amountToMinor('19.990', 'USD')).toBe(1999);
    expect(amountToMinor('500', 'JPY')).toBe(500);
  });

  it('never rounds', () => {
    expect(amountToMinor('19.999', 'USD')).toBeNull();
    expect(amountToMinor('4.5001', 'KWD')).toBeNull();
    expect(amountToMinor('1.5', 'JPY')).toBeNull();
    // 0.1 + 0.2 is a float that is not 0.3: it is refused, not rounded into something
    expect(amountToMinor(0.1 + 0.2, 'USD')).toBeNull();
  });

  it('refuses what is not an amount', () => {
    for (const value of ['', '0', '0.000', '-5', '1e3', '1,5', ' ', 'abc', '1.', '.5', null, undefined, {}, [], Number.NaN, Number.POSITIVE_INFINITY, '99999999999']) {
      expect(amountToMinor(value, 'KWD')).toBeNull();
    }
  });

  it('refuses a currency it does not know', () => {
    expect(amountToMinor('5', 'XXX')).toBeNull();
    expect(amountToMinor('5', '__proto__')).toBeNull();
    expect(currencyExponent('constructor')).toBeNull();
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('writes an amount back as it was asked', () => {
    expect(minorToText(4500, 'KWD')).toBe('4.500');
    expect(minorToText(1999, 'USD')).toBe('19.99');
    expect(minorToText(500, 'JPY')).toBe('500');
  });
});

describe('where a buyer may be sent', () => {
  const hosts = ['examplepay.com'];
  it('takes the named host and anything under it', () => {
    expect(safeCheckoutUrl('https://checkout.examplepay.com/?mode=page&token=abc', hosts)).toBe('https://checkout.examplepay.com/?mode=page&token=abc');
    expect(safeCheckoutUrl('https://examplepay.com/pay', hosts)).toBe('https://examplepay.com/pay');
  });
  it('refuses everything else', () => {
    for (const url of [
      'http://examplepay.com/pay',
      'https://evilexamplepay.com/pay',
      'https://examplepay.com.evil.test/pay',
      'https://user:pass@examplepay.com/pay',
      'https://examplepay.com:8443/pay',
      'https://api.examplepay.com@evil.test/pay',
      'javascript:alert(1)',
      '//examplepay.com/pay',
      'not a url',
      '',
    ]) {
      expect(safeCheckoutUrl(url, hosts)).toBeNull();
    }
  });
});

describe('the payment contract of a definition', () => {
  const gateway = () => catalogDefinition('examplepay')!;

  it('is part of the shipped Tap definition and changes its version hash', () => {
    const withPayment = gateway();
    const without = { ...gateway(), payment: undefined };
    expect(withPayment.payment?.lookup.successStates).toEqual(['CAPTURED']);
    expect(hashDefinition(withPayment)).not.toBe(hashDefinition(definitionSchema.parse(without)));
  });

  it('only lets a POST that makes something create the checkout', () => {
    const draft = gateway();
    draft.operations[1] = { ...draft.operations[1], method: 'GET', body: undefined } as never;
    expect(definitionSchema.safeParse(draft).success).toBe(false);
  });

  it('only lets a GET look-up read the payment', () => {
    const draft = gateway();
    draft.payment!.lookup.operation = 'makePaymentLink';
    expect(definitionSchema.safeParse(draft).success).toBe(false);
  });

  it('needs the look-up to show the mode of a payment when the app has test and live keys', () => {
    const draft = gateway();
    expect(draft.modes).toBeDefined();
    delete draft.payment!.lookup.livePath;
    expect(definitionSchema.safeParse(draft).success).toBe(false);
    // An app with one kind of key has nothing to tell apart
    delete (draft as { modes?: unknown }).modes;
    expect(definitionSchema.safeParse(draft).success).toBe(true);
  });

  it('refuses two operations that would become the same tool name', () => {
    const draft = gateway();
    expect(definitionSchema.safeParse(draft).success).toBe(true);
    draft.operations.push({ ...draft.operations[0], id: draft.operations[0].id.toUpperCase() } as never);
    const refused = definitionSchema.safeParse(draft);
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).toContain('Two operations share an id');
  });

  it('refuses a path the operation does not return', () => {
    const draft = gateway();
    draft.payment!.lookup.statusPath = 'something.else';
    expect(definitionSchema.safeParse(draft).success).toBe(false);
  });

  it('refuses a parameter the operation does not have', () => {
    const draft = gateway();
    draft.payment!.create.amount = 'nope';
    expect(definitionSchema.safeParse(draft).success).toBe(false);
  });

  it('refuses a checkout host that is not a public name', () => {
    for (const host of ['localhost.localdomain', 'internal', '10.0.0.1', 'a_b.test']) {
      const draft = gateway();
      draft.payment!.checkoutHosts = [host];
      expect(definitionSchema.safeParse(draft).success).toBe(false);
    }
  });

  it('never counts a start of the payment as complete', () => {
    const { lookup } = gateway().payment!;
    for (const state of ['AUTHORIZED', 'INITIATED', 'IN_PROGRESS', 'DECLINED', 'CANCELLED', 'REFUNDED', 'FAILED']) expect(lookup.successStates).not.toContain(state);
  });
});
