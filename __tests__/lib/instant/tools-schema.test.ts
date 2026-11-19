import { cutSchema } from '@/lib/instant/tools';
import { instantAllowedArguments } from '@/lib/instant/values';

jest.mock('@/lib/app-adapter', () => ({ getAdapter: jest.fn() }));
jest.mock('@/lib/instant/asker', () => ({ appKeyOf: jest.fn(), brickApps: jest.fn() }));
jest.mock('@/lib/instant/funds', () => ({ instantFundsAreWired: jest.fn() }));
jest.mock('@/lib/instant/state', () => ({ getInstantLimits: jest.fn(), getInstantPause: jest.fn() }));

type Schema = { properties: Record<string, Record<string, unknown>>; required: string[]; allOf?: unknown[] };

describe('the schema a Brick is offered holds what admission accepts', () => {
  const tavily = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for' },
      max_results: { type: 'integer', minimum: 0, maximum: 20, description: 'How many' },
      search_depth: { type: 'string', enum: ['basic', 'advanced'] },
      include_answer: { type: 'boolean' },
      include_domains: { type: 'array', items: { type: 'string' } },
    },
    required: ['query', 'include_answer'],
  };

  it('cuts Tavily to the basic search and the most results, and keeps what the provider says besides', () => {
    const cut = cutSchema('TAVILY_SEARCH', tavily) as Schema;
    expect(Object.keys(cut.properties).sort()).toEqual(['include_domains', 'max_results', 'query', 'search_depth']);
    // Both limits at once: the larger minimum, the smaller maximum, and the provider's own words
    expect(cut.properties.max_results).toMatchObject({ type: 'integer', minimum: 1, maximum: 10, description: 'How many' });
    expect(cut.properties.search_depth).toMatchObject({ enum: ['basic'] });
    expect(cut.properties.include_domains).toMatchObject({ type: 'array', maxItems: 20, minItems: 1 });
    expect(cut.properties.query).toMatchObject({ description: 'What to search for', maxLength: 2000 });
    expect(cut.required).toEqual(['query']);
  });

  it('never loosens a limit the provider already has', () => {
    const cut = cutSchema('TAVILY_SEARCH', { type: 'object', properties: { max_results: { type: 'integer', minimum: 3, maximum: 5 } }, required: [] }) as Schema;
    expect(cut.properties.max_results).toMatchObject({ minimum: 3, maximum: 5 });
  });

  it('asks for pages from one of Exa’s two lists, beside anything the provider already requires', () => {
    const cut = cutSchema('EXA_GET_CONTENTS_ACTION', { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } }, ids: { type: 'array' }, text: { type: 'boolean' }, subpages: { type: 'integer' } }, required: [], allOf: [{ not: { required: ['x'] } }] }) as Schema;
    expect(Object.keys(cut.properties).sort()).toEqual(['ids', 'text', 'urls']);
    expect(cut.properties.urls).toMatchObject({ minItems: 1, maxItems: 20 });
    expect(cut.allOf!.slice(0, 2)).toEqual([{ not: { required: ['x'] } }, { anyOf: [{ required: ['urls'] }, { required: ['ids'] }] }]);
  });

  /** What a value of `urls` and `ids` of these lengths does against the `anyOf` of the combined limit (each branch caps the two lists). */
  const holdsTogether = (cut: Schema, urls: number, ids: number) => {
    const together = cut.allOf!.at(-1) as { anyOf: { properties: { urls: { maxItems: number }; ids: { maxItems: number } } }[] };
    return together.anyOf.some((branch) => urls <= branch.properties.urls.maxItems && ids <= branch.properties.ids.maxItems);
  };

  it('holds Exa’s two lists to one total: 20 pages between them, whichever way they are split', () => {
    const cut = cutSchema('EXA_GET_CONTENTS_ACTION', { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } }, ids: { type: 'array' } }, required: [] }) as Schema;
    // Each list alone may hold 20; together they may hold 20, so mixed calls up to that total are still offered
    expect(holdsTogether(cut, 20, 0)).toBe(true);
    expect(holdsTogether(cut, 0, 20)).toBe(true);
    expect(holdsTogether(cut, 12, 8)).toBe(true);
    expect(holdsTogether(cut, 1, 19)).toBe(true);
    // 21 pages in all is what admission refuses, so it is not offered either
    expect(holdsTogether(cut, 20, 1)).toBe(false);
    expect(holdsTogether(cut, 11, 10)).toBe(false);
  });

  it('keeps the provider’s limit on the items of a list, not only admission’s', () => {
    const cut = cutSchema('TAVILY_SEARCH', { type: 'object', properties: { include_domains: { type: 'array', items: { type: 'string', maxLength: 10 } } }, required: [] }) as Schema;
    // An item may be at most 10 characters (the provider's), where admission alone would allow 2000
    expect(cut.properties.include_domains.items).toMatchObject({ type: 'string', maxLength: 10, minLength: 1 });
  });

  it('keeps both restrictions when the provider’s type for an argument is not admission’s', () => {
    const cut = cutSchema('TAVILY_SEARCH', { type: 'object', properties: { max_results: { type: 'string' } }, required: [] }) as Schema;
    expect(cut.properties.max_results).toMatchObject({ type: 'string', allOf: [expect.objectContaining({ type: 'integer' })] });
  });

  it('keeps both restrictions when the provider’s allowed words have none in common with admission’s, never offering one the provider forbids', () => {
    const cut = cutSchema('TAVILY_SEARCH', { type: 'object', properties: { search_depth: { type: 'string', enum: ['advanced'] } }, required: [] }) as Schema;
    expect(cut.properties.search_depth.enum).toEqual(['advanced']);
    expect(cut.properties.search_depth.allOf).toEqual([{ enum: ['basic'] }]);
  });

  it('asks for text with something in it: a text of only spaces is not one, as admission has it', () => {
    const cut = cutSchema('TAVILY_SEARCH', { type: 'object', properties: { query: { type: 'string' }, include_domains: { type: 'array', items: { type: 'string' } } }, required: [] }) as Schema;
    expect(cut.properties.query.pattern).toBe('\\S');
    expect((cut.properties.include_domains.items as Record<string, unknown>).pattern).toBe('\\S');
    expect(new RegExp(cut.properties.query.pattern as string).test('   ')).toBe(false);
    expect(new RegExp(cut.properties.query.pattern as string).test(' a ')).toBe(true);
  });

  it('leaves a tool that is not in the table as it came', () => {
    expect(instantAllowedArguments('NOT_A_TOOL')).toBeNull();
    const schema = { type: 'object', properties: { a: {} } };
    expect(cutSchema('NOT_A_TOOL', schema)).toBe(schema);
  });
});
