import { isVisionCapableModel, resolveVisionSupport } from '@/lib/vision-models';

const modelAnswers: Array<[string, boolean]> = [
  ['deepseek-v4-flash', false],
  ['deepseek-flash', false],
  ['deepseek-chat', false],
  ['meta-llama-3.1-8b-instruct', false],
  ['qwen2.5-7b-instruct', false],
  ['mistral-7b-instruct-v0.3', false],
  ['qwen2.5-vl-7b-instruct', true],
  ['llava-v1.6-mistral-7b', true],
  ['gpt-4o', true],
  ['gpt-4o-mini', true],
  ['claude-3-5-sonnet', true],
  ['claude-4-sonnet', true],
  ['claude-opus-5-5', true],
  ['claude-sonnet-4-6', true],
  ['claude-haiku-4-5', true],
  ['CLAUDE-SONNET-4-6', true],
  ['claude-future-model', true],
  ['claude', false],
  ['', false],
];

describe('vision Auto model detection', () => {
  it.each(modelAnswers)('%s resolves to %s under Auto', (model, expected) => {
    expect(isVisionCapableModel(model)).toBe(expected);
    expect(resolveVisionSupport(model, null)).toBe(expected);
    expect(resolveVisionSupport(model, undefined)).toBe(expected);
  });

  it.each(modelAnswers)('%s still honors both manual overrides', (model) => {
    expect(resolveVisionSupport(model, true)).toBe(true);
    expect(resolveVisionSupport(model, false)).toBe(false);
  });
});
