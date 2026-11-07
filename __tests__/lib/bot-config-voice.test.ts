import { transformBotToServerFormat } from '@/lib/bot-config-helpers';

// The bot server marks a bot as a voice bot only from this field (Orbit #890)
function bot(voiceEnabled: unknown) {
  return {
    id: 'bot-a',
    name: 'Linear',
    behaviorConfig: {},
    behaviorType: 'idle',
    enabled: true,
    voiceEnabled,
    room: { slug: 'room', world: { slug: 'world', universe: { slug: 'universe' } } },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

test('sends voice on to the bot server', async () => {
  expect((await transformBotToServerFormat(bot(true), false, false)).voiceEnabled).toBe(true);
});

test.each([false, null, undefined])('sends voice off when the switch is %s', async (value) => {
  expect((await transformBotToServerFormat(bot(value), false, false)).voiceEnabled).toBe(false);
});
