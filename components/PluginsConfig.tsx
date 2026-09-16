"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import type { McpResponse, McpScope, McpServerInfo, PluginPackageInfo, PluginStandaloneExtensionInfo, PluginUpdateResult, PluginsResponse } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "@/lib/settings-navigation";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSectionTitle,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";

type PluginScope = PluginPackageInfo["scope"];
type PluginAction = "install" | "remove" | "update" | "disable" | "enable";

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function normalizePluginSourceInput(value: string): string {
  const match = value.trim().match(/^\$?\s*pi\s+install\s+(\S+)\s*$/);
  return match?.[1] ?? value;
}

function packageKey(pkg: Pick<PluginPackageInfo, "source" | "scope">): string {
  return `${pkg.scope}\0${pkg.source}`;
}

function extensionKey(extension: PluginStandaloneExtensionInfo): string {
  return `extension\0${extension.path}`;
}

function resourceSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  if (pkg.disabled) return t("i18n.disabled");
  const parts = [
    pkg.counts.extensions ? t("i18n.resourceCount", { count: pkg.counts.extensions, label: t("i18n.extensionShort") }) : "",
    pkg.counts.skills ? t("i18n.resourceCount", { count: pkg.counts.skills, label: t("i18n.skillShort") }) : "",
    pkg.counts.prompts ? t("i18n.resourceCount", { count: pkg.counts.prompts, label: t("i18n.promptShort") }) : "",
    pkg.counts.themes ? t("i18n.resourceCount", { count: pkg.counts.themes, label: t("i18n.themeShort") }) : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("i18n.noResources");
}

function versionSummary(pkg: PluginPackageInfo, t: ReturnType<typeof useI18n>["t"]): string {
  const parts = [];
  if (pkg.version) parts.push(t("i18n.installedVersion", { version: pkg.version }));
  if (pkg.configuredVersion) parts.push(t("i18n.configuredVersion", { version: pkg.configuredVersion }));
  return parts.length ? parts.join(" · ") : t("i18n.unknown");
}

function installLocation(scope: PluginScope, cwd: string): string {
  return scope === "project"
    ? `${shortenPath(cwd)}/.pi/agent/{npm,git}`
    : "~/.pi/agent/{npm,git}";
}

function findInstalledPackage(
  packages: PluginPackageInfo[],
  source: string,
  scope: PluginScope,
): PluginPackageInfo | undefined {
  const trimmed = source.trim();
  const withoutNpmPrefix = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  return packages.find((pkg) => pkg.scope === scope && pkg.source === trimmed)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source === `npm:${withoutNpmPrefix}`)
    ?? packages.find((pkg) => pkg.scope === scope && pkg.source.endsWith(trimmed));
}

function statusColor(status: PluginPackageInfo["status"]): string {
  if (status === "loaded") return "var(--accent)";
  if (status === "installed") return "#f59e0b";
  if (status === "disabled") return "var(--text-dim)";
  return "#ef4444";
}

function ResourceList({ pkg }: { pkg: PluginPackageInfo }) {
  const { t } = useI18n();
  const groups = ([
    ["extension", t("i18n.extensions")],
    ["skill", t("i18n.skills")],
    ["prompt", t("i18n.prompts")],
    ["theme", t("i18n.themes")],
  ] as const)
    .map(([kind, label]) => ({
      kind,
      label,
      resources: pkg.resources.filter((resource) => resource.kind === kind),
    }))
    .filter((group) => group.resources.length > 0);

  if (groups.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
        {pkg.disabled ? t("i18n.packageDisabled") : t("i18n.noResolvedResources")}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {groups.map((group, groupIndex) => (
        <div
          key={group.kind}
          style={{
            borderTop: groupIndex === 0 ? "none" : "1px solid var(--border)",
            paddingTop: groupIndex === 0 ? 0 : 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--text-dim)",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            {group.label}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {group.resources.map((resource) => (
              <div key={`${resource.kind}:${resource.path}`} style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={resource.path}
                >
                  {resource.name}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: "var(--text-dim)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginTop: 1,
                  }}
                  title={resource.path}
                >
                  {resource.relativePath}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Toggle({
  enabled,
  loading,
  onToggle,
  label,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      title={label}
      aria-label={label}
      aria-pressed={enabled}
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
        opacity: loading ? 0.65 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: enabled ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}


function ScopeTag({ scope }: { scope: PluginScope }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: 3,
        flexShrink: 0,
        background: scope === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
        color: scope === "project" ? "rgba(99,102,241,0.85)" : "var(--text-dim)",
      }}
    >
      {scope}
    </span>
  );
}

function SegmentedScope({
  value,
  projectResourcesLoaded,
  onChange,
}: {
  value: PluginScope;
  projectResourcesLoaded: boolean;
  onChange: (scope: PluginScope) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        borderRadius: 7,
        overflow: "hidden",
        height: 30,
      }}
    >
      {(["global", "project"] as PluginScope[]).map((scope) => {
        const active = value === scope;
        const disabled = scope === "project" && !projectResourcesLoaded;
        return (
          <button
            key={scope}
            onClick={() => {
              if (!disabled) onChange(scope);
            }}
            disabled={disabled}
            title={disabled ? t("trust.projectScopeUnavailable") : undefined}
            style={{
              width: 76,
              border: "none",
              borderRight: scope === "global" ? "1px solid var(--border)" : "none",
              background: active ? "var(--bg-selected)" : "none",
              color: active ? "var(--text)" : "var(--text-muted)",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.45 : 1,
              fontSize: 12,
            }}
          >
            {scope}
          </button>
        );
      })}
    </div>
  );
}

function AddPluginPanel({
  cwd,
  source,
  scope,
  projectResourcesLoaded,
  busy,
  actionError,
  onSourceChange,
  onScopeChange,
  onInstall,
}: {
  cwd: string;
  source: string;
  scope: PluginScope;
  projectResourcesLoaded: boolean;
  busy: boolean;
  actionError: string | null;
  onSourceChange: (value: string) => void;
  onScopeChange: (scope: PluginScope) => void;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const examples = ["npm:@scope/pi-plugin", "git:https://github.com/user/repo", "/absolute/path/to/plugin"];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <ConfigDetailStack className="is-fill">
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <ConfigDetailTitle>{t("i18n.addPlugin")}</ConfigDetailTitle>
          <a
            href="https://pi.dev/packages"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              color: "var(--accent)",
              fontSize: 12,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            <svg width="28" height="28" viewBox="0 0 800 800" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
              <path
                fill="#000"
                fillRule="evenodd"
                d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
              />
              <path fill="#000" d="M517.36 400H634.72V634.72H517.36Z" />
            </svg>
            pi.dev/packages
          </a>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {installLocation(scope, cwd)}
        </div>
      </div>

      <ConfigField label="Source">
        <input
          id="plugin-source"
          ref={inputRef}
          value={source}
          onChange={(e) => onSourceChange(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            const normalized = normalizePluginSourceInput(pasted);
            if (normalized === pasted) return;
            e.preventDefault();
            onSourceChange(normalized);
          }}
          onBlur={(e) => onSourceChange(normalizePluginSourceInput(e.currentTarget.value))}
          placeholder="npm:@scope/package"
          style={{
            width: "100%",
            height: 36,
            padding: "0 11px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && source.trim() && !busy) onInstall();
          }}
        />
      </ConfigField>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SegmentedScope
          value={scope}
          projectResourcesLoaded={projectResourcesLoaded}
          onChange={onScopeChange}
        />
        <ConfigButton
          variant="primary"
          onClick={onInstall}
          disabled={busy || !source.trim()}
          className="is-pushed-right"
        >
          {busy ? t("i18n.installing") : t("i18n.install")}
        </ConfigButton>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>
          Examples
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onSourceChange(example)}
              style={{
                width: "100%",
                minHeight: 30,
                textAlign: "left",
                padding: "6px 9px",
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-panel)",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-panel)";
                e.currentTarget.style.color = "var(--text-dim)";
              }}
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}
    </ConfigDetailStack>
  );
}

function PackageDetail({
  pkg,
  cwd,
  busyKey,
  actionError,
  actionMessage,
  sessionId,
  updateStatus,
  checkingUpdate,
  updateError,
  onAction,
  onCheckUpdate,
  onReloadSession,
}: {
  pkg: PluginPackageInfo;
  cwd: string;
  busyKey: string | null;
  actionError: string | null;
  actionMessage: string | null;
  sessionId: string | null;
  updateStatus?: PluginUpdateResult;
  checkingUpdate: boolean;
  updateError: string | null;
  onAction: (action: PluginAction, pkg: PluginPackageInfo) => void;
  onCheckUpdate: () => void;
  onReloadSession: () => void;
}) {
  const { t } = useI18n();
  const key = packageKey(pkg);
  const busy = busyKey?.endsWith(key) ?? false;
  const reloadBusy = busyKey === "reload";
  const enabled = !pkg.disabled;
  const canCheckForUpdates = pkg.canCheckForUpdates;
  const updateAvailable = updateStatus?.state === "update-available";

  return (
    <ConfigDetailStack>
      <ConfigDetailHeader className="is-top-aligned">
        <ConfigDetailHeaderInfo>
          <ScopeTag scope={pkg.scope} />
          {pkg.disabled ? (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(120,120,120,0.12)",
                color: "var(--text-dim)",
              }}
            >
              {t("i18n.disabled")}
            </span>
          ) : pkg.filtered && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(245,158,11,0.12)",
                color: "#d97706",
              }}
            >
              {t("i18n.filtered")}
            </span>
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {pkg.source}
          </span>
        </ConfigDetailHeaderInfo>

        <ConfigDetailActions>
          <ConfigButton
            size="small"
            variant={updateAvailable ? "primary" : undefined}
            onClick={updateAvailable || !canCheckForUpdates
              ? () => onAction("update", pkg)
              : onCheckUpdate}
            disabled={busy || reloadBusy || checkingUpdate}
            title={updateAvailable ? t("i18n.updateAvailable") : undefined}
          >
             {busyKey === `update:${key}`
               ? t("i18n.updating")
               : checkingUpdate
                 ? t("i18n.checking")
                 : updateAvailable || !canCheckForUpdates
                   ? t("i18n.update")
                   : t("i18n.check")}
          </ConfigButton>
          <ConfigButton
            size="small"
            onClick={onReloadSession}
            disabled={!sessionId || reloadBusy || busy}
             title={sessionId ? t("i18n.reloadSession") : t("i18n.openSessionToReload")}
          >
             {reloadBusy ? t("i18n.reloading") : t("i18n.reloadSession")}
          </ConfigButton>
          <ConfigButton
            variant="danger"
            size="small"
            onClick={() => onAction("remove", pkg)}
            disabled={busy || reloadBusy}
          >
             {busyKey === `remove:${key}` ? t("i18n.removing") : t("i18n.remove")}
          </ConfigButton>
          <ConfigSwitch
            checked={enabled}
            loading={busy || reloadBusy}
            onChange={() => onAction(pkg.disabled ? "enable" : "disable", pkg)}
            label={pkg.disabled ? t("i18n.enablePackage") : t("i18n.disablePackage")}
          />
        </ConfigDetailActions>
      </ConfigDetailHeader>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.status")}</div>
        <div style={{ color: statusColor(pkg.status), textTransform: "capitalize" }}>{pkg.status}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.version")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div className="skill-version-row">
            <span className="skill-version-value">{versionSummary(pkg, t)}</span>
            {updateAvailable && (
              <span className="skill-version-value is-update" title={updateStatus.displayName}>
                {t("i18n.updateAvailable")}
              </span>
            )}
            {canCheckForUpdates && (checkingUpdate || (updateStatus && !updateAvailable)) && (
              <span
                className={`skill-update-status ${checkingUpdate
                  ? "is-checking"
                  : updateStatus?.state === "up-to-date"
                    ? "is-success"
                    : updateStatus?.state === "error"
                      ? "is-error"
                      : "is-muted"}`}
              >
                {checkingUpdate
                  ? t("i18n.checking")
                  : updateStatus?.state === "up-to-date"
                    ? t("i18n.upToDate")
                    : updateStatus?.state === "unsupported"
                      ? t("i18n.automaticChecksUnavailable")
                      : updateStatus?.message || t("i18n.checkFailed")}
              </span>
            )}
          </div>
          {updateError && (
            <span style={{ fontSize: 12, color: "#ef4444" }}>{updateError}</span>
          )}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.package")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {pkg.packageName ?? t("i18n.unknown")}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.resources")}</div>
         <div style={{ color: "var(--text-muted)" }}>{resourceSummary(pkg, t)}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.installedPath")}</div>
        <div
          style={{
            color: pkg.installedPath ? "var(--text-muted)" : "#ef4444",
            fontFamily: "var(--font-mono)",
            overflowWrap: "anywhere",
          }}
        >
          {pkg.installedPath ? shortenPath(pkg.installedPath) : t("i18n.notFound")}
        </div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.cwd")}</div>
        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(cwd)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <ConfigSectionTitle>{t("i18n.resolvedResources")}</ConfigSectionTitle>
        <ResourceList pkg={pkg} />
      </div>

      {actionMessage && (
        <div style={{ fontSize: 12, color: "#16a34a" }}>
          {actionMessage}
        </div>
      )}
      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>
          {actionError}
        </div>
      )}
    </ConfigDetailStack>
  );
}

function StandaloneExtensionDetail({ extension }: { extension: PluginStandaloneExtensionInfo }) {
  const { t } = useI18n();
  const status = extension.enabled ? "loaded" : "disabled";

  return (
    <ConfigDetailStack>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <ScopeTag scope={extension.scope} />
          <ConfigDetailTitle>{extension.name}</ConfigDetailTitle>
        </ConfigDetailHeaderInfo>
      </ConfigDetailHeader>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.status")}</div>
        <div style={{ color: extension.enabled ? "var(--accent)" : "var(--text-dim)" }}>{status}</div>
        <div style={{ color: "var(--text-dim)" }}>{t("i18n.installedPath")}</div>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(extension.path)}
        </div>
      </div>
    </ConfigDetailStack>
  );
}

function buttonStyle(disabled?: boolean, danger?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: danger ? "rgba(239,68,68,0.08)" : "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: danger ? "#ef4444" : "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    opacity: disabled ? 0.5 : 1,
  };
}

function McpServerDetail({
  server,
  cwd,
  busy,
  actionError,
  actionMessage,
  onToggle,
  onRemove,
  onMove,
  onTest,
  onEdit,
}: {
  server: McpServerInfo;
  cwd: string;
  busy: boolean;
  actionError: string | null;
  actionMessage: string | null;
  onToggle: () => void;
  onRemove: () => void;
  onMove: () => void;
  onTest: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const enabled = !server.disabled;
  const otherScope = server.scope === "project" ? "global" : "project";
  const target =
    server.kind === "url" ? server.url : server.kind === "socket" ? server.socket : server.command;
  const row: React.CSSProperties = { color: "var(--text-dim)" };
  const val: React.CSSProperties = {
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    overflowWrap: "anywhere",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 680 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          minWidth: 0,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 }}>
          <Toggle
            enabled={enabled}
            loading={busy}
            onToggle={onToggle}
            label={enabled ? t("mcp.disable") : t("mcp.enable")}
          />
          <ScopeTag scope={server.scope} />
          {server.disabled && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(120,120,120,0.12)",
                color: "var(--text-dim)",
              }}
            >
              {t("mcp.disabledBadge")}
            </span>
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {server.name}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={onTest} disabled={busy} style={buttonStyle(busy)}>
            {busy ? t("mcp.testing") : t("mcp.test")}
          </button>
          <button onClick={onEdit} disabled={busy} style={buttonStyle(busy)}>
            {t("mcp.edit")}
          </button>
          <button onClick={onMove} disabled={busy} style={buttonStyle(busy)}>
            {otherScope === "project" ? t("mcp.moveToProject") : t("mcp.moveToGlobal")}
          </button>
          <button onClick={onRemove} disabled={busy} style={buttonStyle(busy, true)}>
            {t("mcp.delete")}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={row}>{t("mcp.fieldType")}</div>
        <div style={val}>{server.kind}</div>
        <div style={row}>{server.kind === "url" ? t("mcp.kindUrl") : server.kind === "socket" ? t("mcp.kindSocket") : t("mcp.kindCommand")}</div>
        <div style={val}>{target ?? "—"}</div>
        {server.kind === "command" && (
          <>
            <div style={row}>{t("mcp.fieldArgs")}</div>
            <div style={val}>{server.args.length ? server.args.join(" ") : "—"}</div>
          </>
        )}
        <div style={row}>{t("mcp.fieldEnv")}</div>
        <div style={val}>{server.envKeys.length ? server.envKeys.join(", ") : "—"}</div>
        <div style={row}>{t("mcp.fieldOptions")}</div>
        <div style={val}>
          {Object.keys(server.options).length ? JSON.stringify(server.options) : "—"}
        </div>
        <div style={row}>{t("mcp.fieldSource")}</div>
        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(server.source)}
        </div>
        <div style={row}>{t("mcp.fieldCwd")}</div>
        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(cwd)}
        </div>
      </div>

      {actionMessage && (
        <div style={{ fontSize: 12, color: "#16a34a", whiteSpace: "pre-wrap" }}>{actionMessage}</div>
      )}
      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>{actionError}</div>
      )}
    </div>
  );
}

function AddMcpServer({
  cwd,
  scope,
  projectResourcesLoaded,
  busy,
  actionError,
  initial,
  onScopeChange,
  onSave,
  onFetchDef,
  onCancel,
}: {
  cwd: string;
  scope: McpScope;
  projectResourcesLoaded: boolean;
  busy: boolean;
  actionError: string | null;
  initial?: McpServerInfo | null;
  onScopeChange: (scope: McpScope) => void;
  onSave: (name: string, def: Record<string, unknown>) => void;
  onFetchDef: (name: string, serverScope: McpScope) => Promise<Record<string, unknown> | null>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const isEdit = !!initial;
  const [name, setName] = useState(isEdit && initial ? initial.name : "");
  const [spec, setSpec] = useState(() => {
    if (!initial) return "";
    if (initial.kind === "command") return [initial.command, ...initial.args].join(" ");
    return initial.url ?? initial.socket ?? "";
  });
  const [argsText, setArgsText] = useState("");
  const [mode, setMode] = useState<"basic" | "json">("basic");
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [loadingJson, setLoadingJson] = useState(false);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    height: 36,
    padding: "0 11px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    outline: "none",
  };
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--text-muted)" };
  const isUrl = /^https?:\/\//.test(spec.trim());

  const buildBasicDef = (): Record<string, unknown> => {
    const specTrim = spec.trim();
    if (/^https?:\/\//.test(specTrim)) return { url: specTrim };
    const tokens = specTrim.split(/\s+/);
    const command = tokens[0] ?? "";
    const extra = argsText.trim() ? argsText.trim().split(/\s+/) : [];
    return { command, args: [...tokens.slice(1), ...extra] };
  };

  const switchToJson = async (): Promise<void> => {
    setJsonError(null);
    if (jsonText !== null) {
      setMode("json");
      return;
    }
    if (isEdit && initial) {
      setMode("json");
      setLoadingJson(true);
      try {
        const def = await onFetchDef(initial.name, initial.scope);
        setJsonText(JSON.stringify(def ?? buildBasicDef(), null, 2));
      } finally {
        setLoadingJson(false);
      }
    } else {
      setJsonText(JSON.stringify(buildBasicDef(), null, 2));
      setMode("json");
    }
  };

  const handleSave = (): void => {
    setJsonError(null);
    if (mode === "json") {
      const text = jsonText ?? "";
      if (!text.trim()) {
        setJsonError(t("mcp.jsonEmpty"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        setJsonError(t("mcp.jsonParseError", { message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setJsonError(t("mcp.jsonNotObject"));
        return;
      }
      const def = parsed as Record<string, unknown>;
      if (!def.command && !def.url && !def.socket) {
        setJsonError(t("mcp.jsonNeedsEntry"));
        return;
      }
      onSave(name, def);
      return;
    }
    onSave(name, buildBasicDef());
  };

  const canSave =
    name.trim() &&
    (mode === "json" ? (jsonText ?? "").trim().length > 0 : spec.trim().length > 0);

  const jsonEditorStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 200,
    padding: "9px 11px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    lineHeight: 1.5,
    outline: "none",
    resize: "vertical",
    whiteSpace: "pre",
    overflow: "auto",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 660, minHeight: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
          {isEdit ? t("mcp.editTitle", { name: initial?.name ?? "" }) : t("mcp.addTitle")}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {scope === "project" ? `${shortenPath(cwd)}/.pi/mcp.json` : "~/.pi/agent/mcp.json"}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {(["basic", "json"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => (m === "json" ? void switchToJson() : setMode("basic"))}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              cursor: "pointer",
              fontSize: 12,
              background: mode === m ? "var(--accent)" : "none",
              color: mode === m ? "white" : "var(--text-muted)",
            }}
          >
            {m === "basic" ? t("mcp.modeBasic") : t("mcp.modeJson")}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <label style={labelStyle}>{t("mcp.nameLabel")}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("mcp.namePlaceholder")}
          style={inputStyle}
        />
      </div>

      {mode === "json" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <label style={labelStyle}>{t("mcp.jsonLabel")}</label>
          {loadingJson ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("mcp.loadingDef")}</div>
          ) : (
            <textarea
              value={jsonText ?? ""}
              onChange={(e) => setJsonText(e.target.value)}
              spellCheck={false}
              placeholder={
                '{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-github"],\n  "env": {}\n}'
              }
              style={jsonEditorStyle}
            />
          )}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <label style={labelStyle}>{t("mcp.specLabel")}</label>
            <input
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              placeholder={t("mcp.specPlaceholder")}
              style={inputStyle}
            />
          </div>

          {!isUrl && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <label style={labelStyle}>{t("mcp.argsLabel")}</label>
              <input value={argsText} onChange={(e) => setArgsText(e.target.value)} style={inputStyle} />
            </div>
          )}
        </>
      )}

      {jsonError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>{jsonError}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SegmentedScope
          value={scope}
          projectResourcesLoaded={projectResourcesLoaded}
          onChange={onScopeChange}
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !canSave}
          style={{
            ...buttonStyle(busy || !canSave),
            background: "var(--accent)",
            color: "white",
            borderColor: "var(--accent)",
          }}
        >
          {busy ? t("mcp.saving") : isEdit ? t("mcp.saveEdit") : t("mcp.save")}
        </button>
        <button type="button" onClick={onCancel} style={buttonStyle(false)}>
          {t("mcp.cancel")}
        </button>
      </div>

      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>{actionError}</div>
      )}
    </div>
  );
}

export function PluginsConfig({
  cwd,
  sessionId,
  onClose,
  onReloaded,
  embedded = false,
}: {
  cwd: string;
  sessionId: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<PluginsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => getLastSettingsSelection("plugins", cwd));
  const [addMode, setAddMode] = useState(false);
  const [installSource, setInstallSource] = useState("");
  const [installScope, setInstallScope] = useState<PluginScope>("global");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  // MCP-related state
  const [view, setView] = useState<"plugins" | "mcp">("plugins");
  const [mcpData, setMcpData] = useState<McpResponse | null>(null);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpSelected, setMcpSelected] = useState<string | null>(null);
  const [mcpAddMode, setMcpAddMode] = useState(false);
  const [mcpScope, setMcpScope] = useState<McpScope>("global");
  const [mcpEditTarget, setMcpEditTarget] = useState<McpServerInfo | null>(null);
  const [mcpActionError, setMcpActionError] = useState<string | null>(null);
  const [mcpActionMessage, setMcpActionMessage] = useState<string | null>(null);
  const [mcpTesting, setMcpTesting] = useState<string | null>(null);
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, PluginUpdateResult>>({});
  const [checkingUpdates, setCheckingUpdates] = useState<Set<string>>(new Set());
  const [checkingAll, setCheckingAll] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);

  const packages = useMemo(() => data?.packages ?? [], [data?.packages]);
  const standaloneExtensions = useMemo(() => data?.standaloneExtensions ?? [], [data?.standaloneExtensions]);
  const selectedPackage = packages.find((pkg) => packageKey(pkg) === selected) ?? null;
  const selectedExtension = standaloneExtensions.find((extension) => extensionKey(extension) === selected) ?? null;
  const projectResourcesLoaded = data?.projectResourcesLoaded ?? true;
  const selectedMcp = useMemo(
    () => mcpData?.servers.find((s) => s.name === mcpSelected) ?? null,
    [mcpData, mcpSelected],
  );
  const groupedMcp = useMemo(() => {
    return (["project", "global"] as McpScope[])
      .map((scope) => ({ scope, servers: (mcpData?.servers ?? []).filter((s) => s.scope === scope) }))
      .filter((group) => group.servers.length > 0);
  }, [mcpData]);

  const groupedPackages = useMemo(() => {
    return (["project", "global"] as PluginScope[])
      .map((scope) => ({ scope, packages: packages.filter((pkg) => pkg.scope === scope) }))
      .filter((group) => group.packages.length > 0);
  }, [packages]);

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/plugins?cwd=${encodeURIComponent(cwd)}`);
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setAddMode((current) => (next.packages.length === 0 && next.standaloneExtensions.length === 0) || current);
      setSelected((current) => {
        if (current && (
          next.packages.some((pkg) => packageKey(pkg) === current)
          || next.standaloneExtensions.some((extension) => extensionKey(extension) === current)
        )) return current;
        return next.packages[0]
          ? packageKey(next.packages[0])
          : next.standaloneExtensions[0]
            ? extensionKey(next.standaloneExtensions[0])
            : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  // Bundled extensions (shipped in vendor/) — one-click install, not forced
  interface BundledExtInfo {
    name: string;
    label: string;
    description: string;
    bundled: boolean;
    installed: boolean;
  }
  const [bundled, setBundled] = useState<BundledExtInfo[]>([]);
  const [bundledBusy, setBundledBusy] = useState<string | null>(null);
  const loadBundled = useCallback(async () => {
    try {
      const res = await fetch("/api/bundled-extensions");
      const data = (await res.json()) as { extensions?: BundledExtInfo[] };
      setBundled(data.extensions ?? []);
    } catch {
      /* ignore */
    }
  }, []);
  const installBundled = useCallback(async (name: string) => {
    setBundledBusy(name);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/bundled-extensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const next = (await res.json()) as { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      await loadBundled();
      await loadPlugins();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBundledBusy(null);
    }
  }, [loadBundled, loadPlugins]);

  useEffect(() => {
    setUpdateStatuses({});
    setUpdateError(null);
    void loadPlugins();
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selected) setLastSettingsSelection("plugins", selected, cwd);
  }, [cwd, selected]);

  const checkForUpdates = useCallback(async (pkg?: PluginPackageInfo) => {
    const targets = pkg ? [pkg] : packages.filter((item) => item.canCheckForUpdates);
    const keys = targets.map(packageKey);
    if (keys.length === 0) return;

    setUpdateError(null);
    setCheckingUpdates((current) => new Set([...current, ...keys]));
    if (!pkg) setCheckingAll(true);
    try {
      const res = await fetch("/api/plugins/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          source: pkg?.source,
          scope: pkg?.scope,
        }),
      });
      const data = (await res.json()) as {
        updates?: PluginUpdateResult[];
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUpdateStatuses((current) => {
        const next = { ...current };
        for (const update of data.updates ?? []) {
          next[packageKey(update)] = update;
        }
        return next;
      });
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdates((current) => {
        const next = new Set(current);
        for (const key of keys) next.delete(key);
        return next;
      });
      if (!pkg) setCheckingAll(false);
    }
  }, [cwd, packages]);

  const updateAllPluginsAction = useCallback(async () => {
    setUpdatingAll(true);
    setActionError(null);
    setActionMessage(null);
    setUpdateError(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setUpdateStatuses({});
      setActionMessage(t("i18n.packagesUpdated"));
      if (sessionId) {
        setActionMessage(`${t("i18n.packagesUpdated")} ${t("agents.reloadRequired")}`);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdatingAll(false);
    }
  }, [cwd, sessionId, t]);

  useEffect(() => {
    void loadBundled();
  }, [loadBundled]);

  const loadMcp = useCallback(async () => {
    setMcpLoading(true);
    setMcpActionError(null);
    try {
      const res = await fetch(`/api/mcp?cwd=${encodeURIComponent(cwd)}`);
      const next = (await res.json()) as McpResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setMcpData(next);
      setMcpSelected((current) =>
        current && next.servers.some((s) => s.name === current)
          ? current
          : next.servers[0]?.name ?? null,
      );
    } catch (err) {
      setMcpActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadMcp();
  }, [loadMcp]);

  const runMcpAction = useCallback(
    async (action: string, payload: Record<string, unknown>): Promise<McpResponse | null> => {
      setBusyKey(`mcp:${action}`);
      setMcpActionError(null);
      setMcpActionMessage(null);
      try {
        const res = await fetch("/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, action, ...payload }),
        });
        const next = (await res.json()) as McpResponse & { error?: string };
        if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
        setMcpData(next);
        return next;
      } catch (err) {
        setMcpActionError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusyKey(null);
      }
    },
    [cwd],
  );

  const toggleMcp = useCallback(
    async (server: McpServerInfo) => {
      const next = await runMcpAction(server.disabled ? "enable" : "disable", {
        name: server.name,
        scope: server.scope,
      });
      if (next) {
        setMcpActionMessage(
          server.disabled
            ? t("mcp.msgEnabled", { name: server.name })
            : t("mcp.msgDisabled", { name: server.name }),
        );
      }
    },
    [runMcpAction],
  );

  const removeMcp = useCallback(
    async (server: McpServerInfo) => {
      const next = await runMcpAction("remove", { name: server.name, scope: server.scope });
      if (next) {
        setMcpSelected(next.servers[0]?.name ?? null);
        setMcpActionMessage(t("mcp.msgDeleted", { name: server.name }));
        if (next.servers.length === 0) setMcpAddMode(true);
      }
    },
    [runMcpAction],
  );

  const moveMcp = useCallback(
    async (server: McpServerInfo) => {
      const to = server.scope === "project" ? "global" : "project";
      const next = await runMcpAction("move", {
        name: server.name,
        fromScope: server.scope,
        toScope: to,
      });
      if (next) setMcpActionMessage(t("mcp.msgMoved", { name: server.name, scope: to }));
    },
    [runMcpAction],
  );

  const saveMcp = useCallback(
    async (name: string, def: Record<string, unknown>) => {
      const isEdit = !!mcpEditTarget;
      const action = isEdit ? "update" : "add";
      const nameFinal = isEdit && mcpEditTarget ? mcpEditTarget.name : name.trim();
      const next = await runMcpAction(action, { name: nameFinal, scope: mcpScope, def });
      if (next) {
        setMcpSelected(nameFinal);
        setMcpAddMode(false);
        setMcpEditTarget(null);
        setMcpActionMessage(
          isEdit
            ? t("mcp.msgUpdated", { name: nameFinal })
            : t("mcp.msgAdded", { name: nameFinal }),
        );
      }
    },
    [mcpScope, mcpEditTarget, runMcpAction],
  );

  const fetchMcpDef = useCallback(
    async (name: string, serverScope: McpScope): Promise<Record<string, unknown> | null> => {
      try {
        const res = await fetch("/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, action: "get", name, scope: serverScope }),
        });
        const json = (await res.json()) as { def?: Record<string, unknown>; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        return json.def ?? null;
      } catch {
        return null;
      }
    },
    [cwd],
  );

  const testMcp = useCallback(
    async (server: McpServerInfo) => {
      setMcpTesting(server.name);
      setMcpActionError(null);
      setMcpActionMessage(null);
      try {
        const res = await fetch("/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, action: "test", name: server.name, scope: server.scope }),
        });
        const json = (await res.json()) as { ok?: boolean; message?: string; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        setMcpActionMessage(t("mcp.msgTestResult", { name: server.name, result: json.message ?? "" }));
      } catch (err) {
        setMcpActionError(
          t("mcp.msgTestError", {
            name: server.name,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        setMcpTesting(null);
      }
    },
    [cwd],
  );


  const runAction = useCallback(async (action: PluginAction, pkg: PluginPackageInfo) => {
    const key = packageKey(pkg);
    setBusyKey(`${action}:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, source: pkg.source, scope: pkg.scope, cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      if (action === "remove") {
        setSelected(next.packages[0]
          ? packageKey(next.packages[0])
          : next.standaloneExtensions[0]
            ? extensionKey(next.standaloneExtensions[0])
            : null);
        if (next.packages.length === 0 && next.standaloneExtensions.length === 0) setAddMode(true);
        setActionMessage("Package removed.");
        setUpdateStatuses((current) => {
          const nextStatuses = { ...current };
          delete nextStatuses[key];
          return nextStatuses;
        });
      } else {
        const messages: Record<Exclude<PluginAction, "remove">, string> = {
          install: "Package installed.",
          update: "Package updated.",
          disable: "Package disabled.",
          enable: "Package enabled.",
        };
        setActionMessage(messages[action]);
        if (action === "update") {
          setUpdateStatuses((current) => {
            const nextStatuses = { ...current };
            delete nextStatuses[key];
            return nextStatuses;
          });
        }
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [cwd]);

  const installPlugin = useCallback(async () => {
    const source = normalizePluginSourceInput(installSource).trim();
    if (!source) return;
    setInstallSource(source);
    const key = `${installScope}\0${source}`;
    setBusyKey(`install:${key}`);
    setActionError(null);
    setActionMessage(null);
    try {
      const res = await fetch("/api/plugins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install", source, scope: installScope, cwd }),
      });
      const next = (await res.json()) as PluginsResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      const installed = findInstalledPackage(next.packages, source, installScope);
      setSelected(installed ? packageKey(installed) : key);
      setAddMode(false);
      setInstallSource("");
      setActionMessage("Package installed.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [cwd, installScope, installSource]);

  const reloadSession = useCallback(async () => {
    if (!sessionId) return;
    setBusyKey("reload");
    setActionError(null);
    setActionMessage(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      onReloaded?.();
      await loadPlugins();
      setActionMessage("Session reloaded.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [loadPlugins, onReloaded, sessionId]);

  const addBusy = busyKey?.startsWith("install:") ?? false;
  const mcpBusy = busyKey?.startsWith("mcp:") ?? false;
  const availableUpdateCount = Object.values(updateStatuses).filter(
    (status) => status.state === "update-available",
  ).length;
  const hasCheckablePackages = packages.some((pkg) => pkg.canCheckForUpdates);
  const footerBusy = loading || busyKey !== null || checkingUpdates.size > 0 || updatingAll;

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.plugins")} subtitle={shortenPath(cwd)} closeLabel={t("i18n.close")} onClose={onClose}>

        {!projectResourcesLoaded && (
          <div role="status" className="config-trust-notice">
            {t("trust.pluginsNotLoaded")}
          </div>
        )}

        <ConfigSplitView>
          <ConfigSidebar>
            <ConfigSidebarList>
              {bundled.length > 0 && (
                <div style={{ padding: "4px 8px 6px", borderBottom: "1px solid var(--border)", marginBottom: 6 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-dim)", marginBottom: 3 }}>
                    {t("bundled.title")}
                  </div>
                  {bundled.map((ext) => (
                    <div key={ext.name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "3px 0" }}>
                      <span
                        style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, cursor: "default" }}
                        title={ext.description}
                      >
                        {ext.label}
                      </span>
                      {ext.installed ? (
                        <span style={{ fontSize: 10, color: "var(--accent)", flexShrink: 0 }}>{t("bundled.installed")}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void installBundled(ext.name)}
                          disabled={bundledBusy === ext.name || !ext.bundled}
                          style={{
                            flexShrink: 0,
                            padding: "2px 8px",
                            background: "var(--bg-hover)",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            color: "var(--text)",
                            fontSize: 10,
                            cursor: bundledBusy === ext.name || !ext.bundled ? "not-allowed" : "pointer",
                            opacity: bundledBusy === ext.name || !ext.bundled ? 0.5 : 1,
                          }}
                        >
                          {bundledBusy === ext.name ? t("bundled.installing") : t("bundled.install")}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {loading ? (
                <div className="config-sidebar-message">
                  Loading...
                </div>
              ) : error ? (
                <div className="config-sidebar-message is-error">
                  {error}
                </div>
              ) : packages.length === 0 && standaloneExtensions.length === 0 ? (
                <div className="config-sidebar-message is-empty">
                  No plugins configured
                </div>
              ) : (
                <>
                  {standaloneExtensions.length > 0 && (
                    <div className="config-sidebar-group">
                      <ConfigSidebarGroupLabel>{t("i18n.extensions")}</ConfigSidebarGroupLabel>
                      {standaloneExtensions.map((extension) => {
                        const key = extensionKey(extension);
                        return (
                          <ConfigSidebarItem
                            key={key}
                            active={!addMode && selected === key}
                            title={extension.path}
                            onClick={() => {
                              setView("plugins");

                              setSelected(key);
                              setAddMode(false);
                              setActionError(null);
                              setActionMessage(null);
                            }}
                          >
                            <ConfigStatusDot active={extension.enabled} />
                            <ConfigSidebarText className={`is-grow${extension.enabled ? "" : " is-muted"}`}>
                              {extension.name}
                            </ConfigSidebarText>
                          </ConfigSidebarItem>
                        );
                      })}
                    </div>
                  )}
                  {groupedPackages.map((group) => (
                    <div key={group.scope} className="config-sidebar-group">
                      <ConfigSidebarGroupLabel>
                        {group.scope}
                      </ConfigSidebarGroupLabel>
                      {group.packages.map((pkg) => {
                        const key = packageKey(pkg);
                        const isSelected = !addMode && selected === key;
                        return (
                          <ConfigSidebarItem
                            key={key}
                            active={isSelected}
                            onClick={() => {
                              setView("plugins");

                              setSelected(key);
                              setAddMode(false);
                              setActionError(null);
                              setActionMessage(null);
                            }}
                          >
                            <ConfigStatusDot active={!pkg.disabled} color={statusColor(pkg.status)} />
                            <ConfigSidebarText className={`is-grow${pkg.disabled ? " is-muted" : ""}`}>
                              {pkg.source}
                            </ConfigSidebarText>
                            {updateStatuses[packageKey(pkg)]?.state === "update-available" && (
                              <span title={t("i18n.updateAvailable")} className="skill-update-indicator">
                                ↑
                              </span>
                            )}
                          </ConfigSidebarItem>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}
              <div
                style={{
                  marginTop: 10,
                  borderTop: "1px solid var(--border)",
                  paddingTop: 8,
                }}
              >
                <div
                  style={{
                    padding: "4px 8px 3px",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-dim)",
                    textTransform: "uppercase",
                  }}
                >
                  {t("mcp.sectionTitle")}
                </div>
                {mcpLoading ? (
                  <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                    Loading...
                  </div>
                ) : !mcpData && mcpActionError ? (
                  <div style={{ padding: "10px 8px", fontSize: 11, color: "#ef4444" }}>
                    {mcpActionError}
                  </div>
                ) : (mcpData?.servers.length ?? 0) === 0 ? (
                  <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-dim)" }}>
                  {t("mcp.emptyList")}
                  </div>
                ) : (
                  groupedMcp.map((group) => (
                    <div key={group.scope} style={{ marginBottom: 6 }}>
                      <div
                        style={{
                          padding: "4px 8px 3px",
                          fontSize: 10,
                          fontWeight: 600,
                          color: "var(--text-dim)",
                          textTransform: "uppercase",
                        }}
                      >
                        {group.scope}
                      </div>
                      {group.servers.map((server) => {
                        const isMcpSelected =
                          view === "mcp" && !mcpAddMode && mcpSelected === server.name;
                        return (
                          <div
                            key={server.name}
                            onClick={() => {
                              setView("mcp");
                              setMcpSelected(server.name);
                              setMcpAddMode(false);
                              setMcpEditTarget(null);
                              setMcpActionError(null);
                              setMcpActionMessage(null);
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              padding: "8px 8px",
                              borderRadius: 5,
                              cursor: "pointer",
                              background: isMcpSelected ? "var(--bg-selected)" : "none",
                            }}
                            onMouseEnter={(e) => {
                              if (!isMcpSelected) e.currentTarget.style.background = "var(--bg-hover)";
                            }}
                            onMouseLeave={(e) => {
                              if (!isMcpSelected) e.currentTarget.style.background = "none";
                            }}
                          >
                            <span
                              style={{
                                flexShrink: 0,
                                width: 7,
                                height: 7,
                                borderRadius: "50%",
                                background: server.disabled ? "var(--text-dim)" : "var(--accent)",
                              }}
                            />
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div
                                style={{
                                  fontSize: 12,
                                  fontWeight: isMcpSelected ? 600 : 400,
                                  color: "var(--text)",
                                  fontFamily: "var(--font-mono)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {server.name}
                              </div>
                              <div
                                style={{
                                  fontSize: 10,
                                  color: "var(--text-dim)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  marginTop: 2,
                                }}
                              >
                                {server.kind} · {server.disabled ? t("mcp.itemDisabled") : t("mcp.itemEnabled")}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </ConfigSidebarList>
            <ConfigListAction
                active={addMode}
                onClick={() => {
                  setView("plugins");
                  setAddMode(true);
                  setActionError(null);
                  setActionMessage(null);
                }}
              >
                 {t("i18n.addPlugin")}
            </ConfigListAction>
            <ConfigListAction
                active={mcpAddMode && view === "mcp"}
                onClick={() => {
                  setView("mcp");
                  setMcpAddMode(true);
                  setMcpEditTarget(null);
                  setMcpActionError(null);
                  setMcpActionMessage(null);
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
                </svg>
                {t("mcp.addButton")}
              </ConfigListAction>
          </ConfigSidebar>

          <ConfigDetail>
            <ConfigDetailStack className="is-fill">
              {view === "mcp" ? (
                mcpAddMode ? (
                  <AddMcpServer
                    cwd={cwd}
                    scope={mcpScope}
                    projectResourcesLoaded={projectResourcesLoaded}
                    busy={mcpBusy}
                    actionError={mcpActionError}
                    initial={mcpEditTarget}
                    onScopeChange={setMcpScope}
                    onSave={(name, def) => void saveMcp(name, def)}
                    onFetchDef={fetchMcpDef}
                    onCancel={() => {
                      setMcpAddMode(false);
                      setMcpEditTarget(null);
                    }}
                  />
                ) : selectedMcp ? (
                  <McpServerDetail
                    key={selectedMcp.name}
                    server={selectedMcp}
                    cwd={cwd}
                    busy={mcpBusy || mcpTesting === selectedMcp.name}
                    actionError={mcpActionError}
                    actionMessage={mcpActionMessage}
                    onToggle={() => void toggleMcp(selectedMcp)}
                    onRemove={() => void removeMcp(selectedMcp)}
                    onMove={() => void moveMcp(selectedMcp)}
                    onTest={() => void testMcp(selectedMcp)}
                    onEdit={() => {
                      setMcpEditTarget(selectedMcp);
                      setMcpAddMode(true);
                      setMcpActionError(null);
                      setMcpActionMessage(null);
                    }}
                  />
                ) : (
                  <div
                    style={{
                      height: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--text-dim)",
                      fontSize: 13,
                    }}
                  >
                    {t("mcp.emptyDetail")}
                  </div>
                )
              ) : addMode ? (
              <AddPluginPanel
                cwd={cwd}
                source={installSource}
                scope={installScope}
                projectResourcesLoaded={projectResourcesLoaded}
                busy={addBusy}
                actionError={actionError}
                onSourceChange={setInstallSource}
                onScopeChange={setInstallScope}
                onInstall={installPlugin}
              />
            ) : loading ? null : selectedExtension ? (
              <StandaloneExtensionDetail extension={selectedExtension} />
            ) : selectedPackage ? (
              <PackageDetail
                key={packageKey(selectedPackage)}
                pkg={selectedPackage}
                cwd={cwd}
                busyKey={busyKey}
                actionError={actionError}
                actionMessage={actionMessage}
                sessionId={sessionId}
                updateStatus={updateStatuses[packageKey(selectedPackage)]}
                checkingUpdate={checkingUpdates.has(packageKey(selectedPackage))}
                updateError={updateError}
                onAction={runAction}
                onCheckUpdate={() => void checkForUpdates(selectedPackage)}
                onReloadSession={reloadSession}
              />
              ) : (
                <ConfigEmptyState>{t("i18n.selectPackage")}</ConfigEmptyState>
              )}
            </ConfigDetailStack>
          </ConfigDetail>
        </ConfigSplitView>

        <ConfigFooter status={
            availableUpdateCount > 0 ? (
              <span style={{ fontSize: 12, color: "var(--accent)" }}>
                {availableUpdateCount}{" "}
                {availableUpdateCount === 1 ? t("i18n.update") : t("i18n.updates")}
              </span>
            ) : data?.diagnostics.length ? (
              <span
                title={data.diagnostics.map((d) => `${d.type}: ${d.source ? `${d.source}: ` : ""}${d.message}`).join("\n")}
                style={{ color: data.diagnostics.some((d) => d.type === "error") ? "#ef4444" : "#d97706" }}
              >
                {data.diagnostics.length} diagnostic{data.diagnostics.length === 1 ? "" : "s"}
              </span>
            ) : (
              <span>
                {data ? `${data.totals.extensions} ext · ${data.totals.skills} skills · ${data.totals.prompts} prompts · ${data.totals.themes} themes` : ""}
              </span>
            )}
        >
          {!embedded && <ConfigButton onClick={onClose}>{t("i18n.close")}</ConfigButton>}
          {hasCheckablePackages && (
            <ConfigButton
              variant={availableUpdateCount > 0 ? "primary" : "secondary"}
              onClick={() => void (availableUpdateCount > 0 ? updateAllPluginsAction() : checkForUpdates())}
              disabled={footerBusy}
              title={availableUpdateCount > 0 ? t("i18n.updateAllPluginsHint") : undefined}
            >
              {updatingAll
                ? t("i18n.updating")
                : checkingAll
                  ? t("i18n.checking")
                  : availableUpdateCount > 0
                    ? `${t("i18n.updateAllPlugins")} (${availableUpdateCount})`
                    : t("i18n.checkUpdates")}
            </ConfigButton>
          )}
          <ConfigButton variant="secondary" onClick={() => void loadPlugins()} disabled={footerBusy}>
             {t("i18n.refresh")}
          </ConfigButton>
        </ConfigFooter>
    </ConfigPanelShell>
  );
}
