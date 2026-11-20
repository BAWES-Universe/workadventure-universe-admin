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
    expect(cut.allOf).toEqual([{ not: { required: ['x'] } }, { anyOf: [{ required: ['urls'] }, { required: ['ids'] }] }]);
  });

  it('leaves a tool that is not in the table as it came', () => {
    expect(instantAllowedArguments('NOT_A_TOOL')).toBeNull();
    const schema = { type: 'object', properties: { a: {} } };
    expect(cutSchema('NOT_A_TOOL', schema)).toBe(schema);
  });
});
