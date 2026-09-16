"use client";

export const MAX_EXTENSION_WIDGET_LINES = 10;

function getDisplayLines(lines: string[]): string[] {
  if (lines.length <= MAX_EXTENSION_WIDGET_LINES) return lines;
  return [
    ...lines.slice(0, MAX_EXTENSION_WIDGET_LINES),
    "... (widget truncated)",
  ];
}

export function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  // Extensions that register a widget before they have anything to show render an
  // empty line array (pi-better-goal before a goal exists, pi-better-plan before a
  // plan exists, or while its display mode is hidden). Drop those instead of
  // drawing a header-only box with no body.
  const visibleWidgets = widgets
    .map((widget) => ({ key: widget.key, text: getDisplayLines(widget.lines).join("\n") }))
    .filter((widget) => widget.text.trim() !== "");
  if (visibleWidgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {visibleWidgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "5px 9px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {widget.key}
          </div>
          <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
            {widget.text}
          </pre>
        </div>
      ))}
    </div>
  );
}
