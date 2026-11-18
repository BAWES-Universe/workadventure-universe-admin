/**
 * "Brick templates" (game #2008) migration: runs the real migrations on a throwaway database. Nothing that exists today is
 * touched and nothing is written for anyone; from then on a Brick has at most one template, a template's versions are
 * numbered once, and what goes with a template, a Brick or a person is exactly what should.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Row = Record<string, unknown>;
type Result = {
  before: { users: Row[]; bots: Row[]; rooms: Row[] };
  after: { users: Row[]; bots: Row[]; rooms: Row[] };
  rowsAfterMigration: { templates: number; versions: number; uses: number; stars: number };
  columns: { templates: string[]; versions: string[]; uses: string[]; stars: string[] };
  defaults: { audience: string; current_version: number; choices: unknown; stopped_at: unknown; picked_at: unknown };
  versionDefaults: { needs: unknown; routines: unknown };
  checks: Record<string, boolean>;
  bricksWithARoom: number;
  afterSourceGone: { templates: number; versions: number; stars: number; useKept: number; useTemplateId: { template_id: unknown; maker_name: string; template_name: string }; bricksLeft: number };
  usesAfterMadeBrickGone: number;
  afterMakerGone: { templates: number; use: { template_id: unknown; maker_id: unknown; maker_name: string } };
  starsAfterPersonGone: number;
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-brick-templates-migration.mjs')], { encoding: 'utf8', timeout: 120_000 });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('Brick templates: the migration', () => {
  it('leaves every account, room and bot that exists today as it was, and writes nothing for anyone', () => {
    expect(result.before.bots).toHaveLength(4);
    expect(result.after).toEqual(result.before);
    expect(result.rowsAfterMigration).toEqual({ templates: 0, versions: 0, uses: 0, stars: 0 });
  });

  it('keeps only what a template shares and who made it: no memory, chat, key, app or computer column anywhere', () => {
    expect(result.columns.templates).toEqual(['audience', 'bot_id', 'choices', 'created_at', 'current_version', 'id', 'maker_id', 'picked_at', 'picked_by_id', 'stopped_at', 'updated_at']);
    expect(result.columns.versions).toEqual(['character_texture_id', 'chat_instructions', 'content_hash', 'created_at', 'description', 'first_thing', 'name', 'needs', 'number', 'routines', 'template_id']);
    expect(result.columns.uses).toEqual(['bot_id', 'created_at', 'maker_id', 'maker_name', 'template_id', 'template_name', 'version_number']);
    expect(result.columns.stars).toEqual(['created_at', 'template_id', 'user_id']);
  });

  it('starts shared for everyone, from version 1, not stopped and not picked, with nothing to bring along', () => {
    expect(result.defaults).toEqual({ audience: 'everyone', current_version: 1, choices: {}, stopped_at: null, picked_at: null });
    expect(result.versionDefaults).toEqual({ needs: [], routines: [] });
  });

  it('gives a Brick one template, a template numbered versions, a person one star and a Brick one "made from"', () => {
    expect(result.checks).toEqual({
      secondTemplateForTheSameBrick: false,
      noBrick: false,
      noMaker: false,
      audienceNeitherEveryoneNorLink: false,
      audienceLink: true,
      sameVersionNumberTwice: false,
      nextVersionNumber: true,
      versionOfNoTemplate: false,
      starTwice: false,
      starOnce: true,
      useOfNoBrick: false,
      useTwiceForOneBrick: false,
      useOnce: true,
    });
  });

  it('never gives a Brick a room', () => {
    expect(result.bricksWithARoom).toBe(0);
  });

  it('goes with its Brick, its maker or the person who starred it, takes no other Brick, and leaves the maker’s name on what was made from it', () => {
    expect(result.afterSourceGone).toEqual({ templates: 0, versions: 0, stars: 0, useKept: 1, useTemplateId: { template_id: null, maker_name: 'Sara', template_name: 'Recipe Brick' }, bricksLeft: 2 });
    expect(result.usesAfterMadeBrickGone).toBe(0);
    expect(result.afterMakerGone).toEqual({ templates: 0, use: { template_id: null, maker_id: null, maker_name: 'Omar' } });
    expect(result.starsAfterPersonGone).toBe(0);
  });
});
