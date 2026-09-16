import type { SubagentProfile, SubagentScope } from "./subagents";

const SUBAGENT_SCOPE_PRIORITY: Record<SubagentScope, number> = {
  builtin: 0,
  global: 1,
  workspace: 2,
  project: 3,
};

/** Open an existing effective override instead of replacing it with built-in defaults. */
export function getSubagentProfileEditorSource(
  profile: SubagentProfile,
  profiles: readonly SubagentProfile[],
): SubagentProfile {
  if (profile.scope !== "builtin") return profile;
  const effective = profiles.reduce((current, candidate) =>
    candidate.name.toLowerCase() === profile.name.toLowerCase()
    && SUBAGENT_SCOPE_PRIORITY[candidate.scope] > SUBAGENT_SCOPE_PRIORITY[current.scope]
      ? candidate
      : current,
  profile);
  return effective.scope === "global" || effective.scope === "project" ? effective : profile;
}

export function isSubagentProfileOverridden(
  profile: Pick<SubagentProfile, "name" | "scope">,
  profiles: readonly Pick<SubagentProfile, "name" | "scope">[],
): boolean {
  const name = profile.name.toLowerCase();
  const priority = SUBAGENT_SCOPE_PRIORITY[profile.scope];
  return profiles.some((candidate) =>
    candidate.name.toLowerCase() === name
    && SUBAGENT_SCOPE_PRIORITY[candidate.scope] > priority
  );
}
