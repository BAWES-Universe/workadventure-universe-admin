export const MCP_URL = "https://mcp.linear.app/mcp";
// No verified conditional mutation exists for the current MCP adapter. Configuration cannot bypass this hold.
export const WRITE_CONTRACT_ACCEPTED = false;
export interface Team {
  id: string;
  name: string;
  key: string;
}
export interface Settings {
  botId: string;
  connectionId: string;
  workspaceId: string;
  appActorId: string;
  schemaHash: string;
  writesEnabled: boolean;
  teams?: Team[];
}
export function settings(botId: string): Settings {
  const env = process.env;
  if (
    !botId ||
    botId !== env.LINEAR_SH_BOT_ID ||
    env.LINEAR_SH_ENABLED !== "true"
  )
    throw new Error("Linear SH unavailable");
  const connectionId = env.LINEAR_SH_CONNECTION_ID;
  const workspaceId = env.LINEAR_SH_WORKSPACE_ID;
  const appActorId = env.LINEAR_SH_APP_ACTOR_ID;
  const schemaHash = env.LINEAR_SH_SCHEMA_SHA256;
  const teams: Team[] = JSON.parse(env.LINEAR_SH_TEAMS_JSON || "[]");
  if (
    !Array.isArray(teams) ||
    !teams.length ||
    teams.length > 20 ||
    teams.some(
      (t) =>
        !t ||
        ![t.id, t.name, t.key].every(
          (v) =>
            typeof v === "string" && v.trim().length > 0 && v.length <= 100,
        ),
    ) ||
    new Set(teams.map((t) => t.id)).size !== teams.length
  )
    throw new Error("Verified team directory required");
  if (
    !connectionId ||
    !workspaceId ||
    !appActorId ||
    !schemaHash ||
    !/^[a-f0-9]{64}$/.test(schemaHash)
  )
    throw new Error("Linear SH configuration incomplete");
  return {
    botId,
    connectionId,
    workspaceId,
    appActorId,
    schemaHash,
    teams,
    writesEnabled:
      WRITE_CONTRACT_ACCEPTED && env.LINEAR_SH_WRITES_ENABLED === "true",
  };
}
