/**
 * Bot tool settings (#738) migration: runs the real migrations on a throwaway database, then the tool settings one.
 * Servers that exist today are marked "Not checked yet" and nothing else about them or their bots changes.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type Result = {
  before: { servers: Record<string, unknown>[]; bots: Record<string, unknown>[] };
  once: { servers: Record<string, unknown>[]; bots: Record<string, unknown>[] };
  created: { legacy_text: boolean; policy_revision: number };
  checks: Record<string, boolean>;
  toolsAfterServerDelete: string[];
};

let result: Result;

beforeAll(() => {
  const output = execFileSync(process.execPath, [path.join(__dirname, '../helpers/run-bot-tool-settings-migration.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  result = JSON.parse(output.trim().split('\n').pop() as string) as Result;
}, 150_000);

describe('bot tool settings migration', () => {
  it('marks every server that exists today as not checked yet, so it keeps working in text', () => {
    expect(result.once.servers.map((server) => server.legacy_text)).toEqual([true, true]);
  });

  it('gives those servers the recommended settings and a first revision', () => {
    for (const server of result.once.servers) {
      expect(server).toMatchObject({
        look_up_setting: 'rightAway',
        make_setting: 'rightAway',
        change_setting: 'asksFirst',
        delete_send_setting: 'asksFirst',
        policy_revision: 1,
      });
    }
  });

  it('gives every bot the recommended limits', () => {
    for (const bot of result.once.bots) {
      expect(bot).toMatchObject({ ask_before_making: 5, ask_which_way: 'rarely', card_wait_minutes: 10 });
    }
  });

  it('changes nothing else about the servers and bots', () => {
    expect(result.once.servers.map(({ id, name, enabled }) => ({ id, name, enabled }))).toEqual(result.before.servers);
    expect(result.once.bots.map(({ id, name, enabled }) => ({ id, name, enabled }))).toEqual(result.before.bots);
  });

  it('starts a server added later with its tools waiting to be confirmed', () => {
    expect(result.created).toEqual({ legacy_text: false, policy_revision: 1 });
  });

  it('accepts only the known settings, limits and headings', () => {
    expect(result.checks).toMatchObject({
      badServerSetting: false,
      offSetting: true,
      badAskBefore: false,
      noLimit: true,
      badWay: false,
      badWait: false,
      goodWait: true,
      badHeading: false,
      confirmedWithoutHeading: false,
      goodTool: true,
    });
  });

  it('keeps one row per tool name on a server, and removes the tools with their server', () => {
    expect(result.checks.sameNameTwice).toBe(false);
    expect(result.checks.sameNameOtherServer).toBe(true);
    expect(result.toolsAfterServerDelete).toEqual(['t1']);
  });
});
