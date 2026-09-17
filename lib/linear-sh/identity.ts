import { Settings } from "./config";

export interface Employee {
  subject: string;
  accountId: string;
  linearUserId: string;
  workspaceId: string;
  teamIds: string[];
  teams?: { id: string; name: string; key: string }[];
  employeeName?: string;
}
export interface Account {
  id: string;
  uuid: string;
  email: string | null;
  isGuest: boolean;
}
export interface Member {
  name?: string;
  id: string;
  email: string;
  active: boolean;
  guest: boolean;
  organization: { id: string };
  teams: { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean } };
}
export interface Override {
  subject: string;
  accountId: string;
  linearUserId: string;
}
export function bindEmployee(
  subject: string,
  account: Account | null,
  members: Member[],
  config: Settings,
  overrides: Override[],
): Employee {
  if (
    !subject ||
    !account ||
    account.uuid !== subject ||
    account.isGuest ||
    !account.email
  )
    throw new Error("Employee unavailable");
  const exceptions = overrides.filter(
    (v) => v.subject === subject || v.accountId === account.id,
  );
  if (
    exceptions.length > 1 ||
    (exceptions[0] &&
      (exceptions[0].subject !== subject ||
        exceptions[0].accountId !== account.id))
  )
    throw new Error("Ambiguous identity");
  const exception = exceptions[0];
  const matches = members.filter((m) =>
    exception
      ? m.id === exception.linearUserId
      : m.email.trim().toLowerCase() === account.email!.trim().toLowerCase(),
  );
  if (matches.length !== 1) throw new Error("Employee unavailable");
  const member = matches[0];
  if (
    member.active !== true ||
    member.guest !== false ||
    member.organization?.id !== config.workspaceId ||
    member.teams?.pageInfo?.hasNextPage !== false ||
    !Array.isArray(member.teams?.nodes)
  )
    throw new Error("Employee unavailable");
  const joined = [...new Set(member.teams.nodes.map((t) => t.id))].sort();
  const teams = config.teams?.filter((t) => joined.includes(t.id));
  const teamIds = teams ? teams.map((t) => t.id) : joined;
  if (teamIds.some((t) => typeof t !== "string" || !t) || !teamIds.length)
    throw new Error("No permitted teams");
  return {
    subject,
    accountId: account.id,
    linearUserId: member.id,
    workspaceId: config.workspaceId,
    teamIds,
    teams,
    employeeName: member.name || "Employee",
  };
}
