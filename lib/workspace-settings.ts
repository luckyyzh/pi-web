import { SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import { resolveShellTools } from "./powershell-settings";

type SettingsSnapshot = ReturnType<SettingsManager["getGlobalSettings"]>;

/** Known pi-web legacy package locations, not arbitrary SSH-related extensions. */
function legacySshSource(source: string): boolean {
  const normalized = source.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalized === "ssh"
    || /\/(?:agent|vendor)\/ssh(?:\/extensions\/ssh\.ts)?$/.test(normalized);
}

function withoutLegacySsh(settings: SettingsSnapshot): SettingsSnapshot {
  return {
    ...settings,
    ...(settings.packages ? { packages: settings.packages.filter((entry: PackageSource) => !legacySshSource(typeof entry === "string" ? entry : entry.source)) } : {}),
    ...(settings.extensions ? { extensions: settings.extensions.filter((source) => !legacySshSource(source)) } : {}),
  };
}

/** Session-scoped view only; never rewrite the user's installed packages or shell preference. */
export function createWorkspaceSettings(cwd: string, agentDir: string, remote: boolean): SettingsManager {
  const settings = SettingsManager.create(cwd, agentDir, remote ? { projectTrusted: false } : undefined);
  const globalSnapshot = settings.getGlobalSettings.bind(settings);
  const projectSnapshot = settings.getProjectSettings.bind(settings);
  // The package manager reads scope snapshots, not applyOverrides(). Filter before factories run.
  settings.getGlobalSettings = () => withoutLegacySsh(globalSnapshot());
  settings.getProjectSettings = () => remote ? {} : withoutLegacySsh(projectSnapshot());
  if (remote) {
    const defaultTools = settings.getDefaultTools.bind(settings);
    settings.getDefaultTools = () => resolveShellTools(defaultTools() ?? ["read", "bash", "edit", "write"], ["bash"], "linux");
    settings.getShellCommandPrefix = () => undefined;
  }
  return settings;
}
