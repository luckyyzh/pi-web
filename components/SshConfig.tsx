"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface SshConfigData {
  enabled: boolean;
  host: string;
  path: string;
}

interface SshModeChangeInfo {
  enabled: boolean;
  shadowRoot?: string | null;
  host?: string;
  path?: string;
}

interface Props {
  onClose: () => void;
  /** 配置变化（启用/退出远程模式）时回调；启用时携带 shadowRoot，供父组件切换工作目录 */
  onModeChange: (info?: SshModeChangeInfo) => void;
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-dim)",
  marginBottom: 5,
  display: "block",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 13,
  padding: "7px 9px",
  outline: "none",
};

export default function SshConfig({ onClose, onModeChange }: Props) {
  const [config, setConfig] = useState<SshConfigData>({ enabled: false, host: "", path: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; cwd?: string; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ssh 扩展一键安装状态
  const [extInstalled, setExtInstalled] = useState<boolean | null>(null);
  const [extInstalling, setExtInstalling] = useState(false);
  const [extMessage, setExtMessage] = useState<string | null>(null);
  const hostRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/ssh/config");
        const data = await res.json();
        if (alive) {
          setConfig({
            enabled: !!data.enabled,
            host: typeof data.host === "string" ? data.host : "",
            path: typeof data.path === "string" ? data.path : "",
          });
        }
      } catch {
        if (alive) setError("读取配置失败");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/ssh/install-extension")
      .then((r) => r.json())
      .then((d) => { if (alive) setExtInstalled(!!d.installed); })
      .catch(() => { if (alive) setExtInstalled(null); });
    return () => { alive = false; };
  }, []);

  const installExtension = useCallback(async () => {
    setExtInstalling(true);
    setExtMessage(null);
    try {
      const res = await fetch("/api/ssh/install-extension", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setExtMessage(`安装失败：${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setExtInstalled(true);
      setExtMessage("已安装 ssh 扩展。新开会话（或重启 pi-web）后生效，届时 read/write/edit/bash 会转发到远程。");
    } catch {
      setExtMessage("安装失败：网络错误");
    } finally {
      setExtInstalling(false);
    }
  }, []);

  const save = useCallback(
    async (enabled: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/ssh/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled, host: config.host, path: config.path }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "保存失败");
          return;
        }
        setConfig({ enabled: !!data.enabled, host: data.host ?? "", path: data.path ?? "" });
        onModeChange({
          enabled: !!data.enabled,
          shadowRoot: typeof data.shadowRoot === "string" ? data.shadowRoot : null,
          host: data.host ?? "",
          path: data.path ?? "",
        });
      } catch {
        setError("保存失败");
      } finally {
        setSaving(false);
      }
    },
    [config.host, config.path, onModeChange],
  );

  const test = useCallback(async () => {
    if (!config.host) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await fetch("/api/ssh/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: config.host, path: config.path }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTestResult({ ok: false, error: data.error ?? "测试失败" });
      } else {
        setTestResult(data);
      }
    } catch {
      setTestResult({ ok: false, error: "连接测试失败" });
    } finally {
      setTesting(false);
    }
  }, [config.host, config.path]);

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div style={{ width: 440, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.22)", overflow: "hidden" }}>
        {/* Header */}
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1 }}>远程配置 (SSH)</span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 14, padding: 2 }}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          {extInstalled === false && (
            <div style={{ fontSize: 12, padding: "8px 10px", borderRadius: 6, border: "1px solid var(--accent-dim, #1f6feb)", background: "rgba(31,111,235,0.08)", color: "var(--text)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ flex: 1, minWidth: 150 }}>ssh 扩展未安装，远程文件/agent 工具转发需要它。</span>
              <button
                onClick={installExtension}
                disabled={extInstalling}
                style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: "var(--accent, #1f6feb)", color: "#fff", fontSize: 12, cursor: extInstalling ? "default" : "pointer", fontWeight: 600, opacity: extInstalling ? 0.6 : 1 }}
              >
                {extInstalling ? "安装中…" : "一键安装 ssh 扩展"}
              </button>
            </div>
          )}
          {extMessage && (
            <div style={{ fontSize: 11, padding: "6px 9px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-panel)", color: extMessage.startsWith("安装失败") ? "var(--err, #f85149)" : "var(--ok, #3fb950)", lineHeight: 1.5 }}>
              {extMessage}
            </div>
          )}
          <div>
            <span style={labelStyle}>SSH 目标（user@host）</span>
            <input
              ref={hostRef}
              value={config.host}
              onChange={(e) => setConfig((c) => ({ ...c, host: e.target.value }))}
              placeholder="如 user@192.168.1.10"
              style={inputStyle}
            />
          </div>

          <div>
            <span style={labelStyle}>远程工作目录（可选，留空 = 登录目录）</span>
            <input
              value={config.path}
              onChange={(e) => setConfig((c) => ({ ...c, path: e.target.value }))}
              placeholder="如 /home/user/project"
              style={inputStyle}
            />
          </div>

          {/* Test result */}
          {testResult && (
            <div style={{ fontSize: 12, padding: "7px 9px", borderRadius: 6, border: "1px solid", background: "var(--bg-panel)", color: testResult.ok ? "var(--ok, #3fb950)" : "var(--err, #f85149)", borderColor: testResult.ok ? "var(--ok, #3fb950)" : "var(--err, #f85149)" }}>
              {testResult.ok ? `连接成功：${testResult.cwd ?? ""}` : `连接失败：${testResult.error ?? ""}`}
            </div>
          )}
          {error && (
            <div style={{ fontSize: 12, padding: "7px 9px", borderRadius: 6, border: "1px solid var(--err, #f85149)", background: "var(--bg-panel)", color: "var(--err, #f85149)" }}>
              {error}
            </div>
          )}

          {/* Footer */}
          <div style={{ display: "flex", gap: 8, marginTop: 2, flexWrap: "wrap" }}>
            <button
              onClick={test}
              disabled={testing || !config.host}
              style={{ flex: 1, minWidth: 90, padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", fontSize: 12, cursor: "pointer", opacity: testing || !config.host ? 0.6 : 1 }}
            >
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button
              onClick={() => save(true)}
              disabled={saving}
              style={{ flex: 1, minWidth: 110, padding: "7px 10px", borderRadius: 6, border: "none", background: config.enabled ? "var(--accent-dim, #1f6feb)" : "var(--accent, #1f6feb)", color: config.enabled ? "var(--text)" : "#fff", fontSize: 12, cursor: "pointer", opacity: saving ? 0.6 : 1, fontWeight: 600 }}
            >
              {config.enabled ? "已启用 · 点此保存" : "启用远程模式"}
            </button>
            {config.enabled && (
              <button
                onClick={() => save(false)}
                disabled={saving}
                style={{ flex: 1, minWidth: 90, padding: "7px 10px", borderRadius: 6, border: "1px solid var(--err, #f85149)", background: "transparent", color: "var(--err, #f85149)", fontSize: 12, cursor: "pointer" }}
              >
                退出远程模式
              </button>
            )}
          </div>

          <div style={{ fontSize: 10.5, color: "var(--text-dim)", lineHeight: 1.5 }}>
            当前：{config.enabled ? `远程模式（${config.host}${config.path ? ":" + config.path : ""}）` : "本地模式"}
            {" · "}远程模式文件浏览器仅支持浏览目录和查看文本；agent 的 read/write/edit/bash 会转发到远程执行（需 SSH 密钥免密）。
          </div>
        </div>
      </div>
    </div>
  );
}
