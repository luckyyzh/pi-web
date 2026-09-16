import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  ExtensionWidgets,
  MAX_EXTENSION_WIDGET_LINES,
} = await jiti.import("./ExtensionWidgets.tsx");

test("renders short extension widgets without a truncation marker", () => {
  const html = renderToStaticMarkup(
    React.createElement(ExtensionWidgets, {
      widgets: [{ key: "short", lines: ["first", "second"] }],
    }),
  );

  assert.match(html, /first\nsecond/);
  assert.doesNotMatch(html, /widget truncated/);
});

test("matches the Pi TUI extension widget line limit", () => {
  const lines = Array.from(
    { length: MAX_EXTENSION_WIDGET_LINES + 2 },
    (_, index) => `line-${index + 1}`,
  );
  const html = renderToStaticMarkup(
    React.createElement(ExtensionWidgets, {
      widgets: [{ key: "long", lines }],
    }),
  );

  assert.match(html, new RegExp(`line-${MAX_EXTENSION_WIDGET_LINES}`));
  assert.doesNotMatch(html, new RegExp(`line-${MAX_EXTENSION_WIDGET_LINES + 1}`));
  assert.match(html, /\.\.\. \(widget truncated\)/);
});

test("hides widgets that render no lines", () => {
  const html = renderToStaticMarkup(
    React.createElement(ExtensionWidgets, {
      widgets: [
        { key: "pi-better-goal", lines: [] },
        { key: "pi-better-plan", lines: [] },
      ],
    }),
  );

  assert.equal(html, "");
});

test("hides widgets whose lines are blank only", () => {
  const html = renderToStaticMarkup(
    React.createElement(ExtensionWidgets, {
      widgets: [{ key: "pi-better-goal", lines: ["", "   ", "\t"] }],
    }),
  );

  assert.equal(html, "");
});

test("keeps non-empty widgets when an empty sibling is present", () => {
  const html = renderToStaticMarkup(
    React.createElement(ExtensionWidgets, {
      widgets: [
        { key: "pi-better-goal", lines: [] },
        { key: "pi-better-plan", lines: ["Step 1 done", "Step 2 active"] },
      ],
    }),
  );

  assert.doesNotMatch(html, /pi-better-goal/);
  assert.match(html, /pi-better-plan/);
  assert.match(html, /Step 1 done/);
});

test("still renders a widget that only looks blank on its trailing lines", () => {
  const html = renderToStaticMarkup(
    React.createElement(ExtensionWidgets, {
      widgets: [{ key: "goal", lines: ["Goal: ship it", ""] }],
    }),
  );

  assert.match(html, /Goal: ship it/);
});
