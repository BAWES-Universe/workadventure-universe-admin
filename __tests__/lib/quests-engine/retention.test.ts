import { readFileSync } from 'fs';
import { join } from 'path';
import { QUEST_RETENTION } from '@/lib/quests/engine/retention';

/** Every quest table states how long it keeps its rows (epic #508: "a new table ships with its retention rule"). */
describe('quest retention', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
  const models = [...schema.matchAll(/^model (Quest\w+) \{/gm)].map((match) => match[1]);

  it('finds the quest models', () => {
    expect(models.length).toBeGreaterThan(10);
  });

  it.each(models)('%s has a retention rule', (model) => {
    expect(QUEST_RETENTION[model]).toEqual(expect.any(String));
  });

  it('has no rule for a model that no longer exists', () => {
    for (const name of Object.keys(QUEST_RETENTION)) expect(models).toContain(name);
  });
});
