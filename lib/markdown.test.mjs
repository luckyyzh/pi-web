import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { unified } from "unified";
import remarkParse from "remark-parse";

import { markdownRemarkPlugins, normalizeDisplayMath } from "./markdown.ts";

function renderPipeline(markdown) {
  // Mirror the parse phase of react-markdown: remarkParse + the plugin list
  // exported by lib/markdown.ts (unified .runSync = parse + transform phase).
  const processor = unified().use(remarkParse).use(markdownRemarkPlugins).freeze();
  const tree = processor.parse(markdown);
  return processor.runSync(tree) ?? tree;
}

function emphasisTexts(markdown) {
  const found = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "strong" || node.type === "emphasis") {
      found.push({ type: node.type, text: textOf(node) });
      return;
    }
    (node.children ?? []).forEach(walk);
  })(renderPipeline(markdown));
  return found;
}

function textOf(node) {
  if (node.type === "text") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function deleteTexts(markdown) {
  const found = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "delete") found.push(textOf(node));
    (node.children ?? []).forEach(walk);
  })(renderPipeline(markdown));
  return found;
}

describe("normalizeDisplayMath", () => {
  describe("single-line $$…$$", () => {
    it("splits a single-line block into three lines", () => {
      assert.equal(normalizeDisplayMath("$$a + b$$"), "$$\na + b\n$$");
    });

    it("preserves the indent of the surrounding list item", () => {
      assert.equal(
        normalizeDisplayMath("- item:\n  $$a + b$$\n- next"),
        "- item:\n  $$\n  a + b\n  $$\n- next",
      );
    });
  });

  describe("multi-line blocks with glued delimiters", () => {
    it("moves a glued opening delimiter to its own line", () => {
      const input = "$$\n\\frac{a}{b} = c\n<d$$\n\nafter";
      assert.equal(normalizeDisplayMath(input), "$$\n\\frac{a}{b} = c\n<d\n$$\n\nafter");
    });

    it("moves a glued closing delimiter to its own line", () => {
      const input = "$$\nx = y\nz = w$$\n\nafter";
      assert.equal(normalizeDisplayMath(input), "$$\nx = y\nz = w\n$$\n\nafter");
    });
  });

  describe("blocks nested in GFM list items", () => {
    it("re-indents lazy content lines of an indented bare-fence block", () => {
      const input = "- item:\n  $$\nx = y\n  $$\n- next";
      assert.equal(normalizeDisplayMath(input), "- item:\n  $$\n  x = y\n  $$\n- next");
    });

    it("re-indents partially indented content lines", () => {
      const input = "- item:\n  $$\n x = y\n  $$\n- next";
      assert.equal(normalizeDisplayMath(input), "- item:\n  $$\n  x = y\n  $$\n- next");
    });

    it("does not use a sibling list item's formula as a closing fence", () => {
      const input = "- first\n  $$x = y\n- second\n  $$z = w$$\n- third";
      assert.equal(
        normalizeDisplayMath(input),
        "- first\n  $$x = y\n- second\n  $$\n  z = w\n  $$\n- third",
      );
    });

    it("does not scan a bare fence past a sibling list item", () => {
      const input = "- first\n  $$\nx = y\n- second\n  $$z = w$$\n- third";
      assert.equal(
        normalizeDisplayMath(input),
        "- first\n  $$\nx = y\n- second\n  $$\n  z = w\n  $$\n- third",
      );
    });
  });

  describe("blocks that must stay untouched", () => {
    it("leaves a top-level block with detached delimiters untouched", () => {
      const input = "$$\n\\frac{a}{b}\n$$\n\nend";
      assert.equal(normalizeDisplayMath(input), input);
    });

    it("leaves content inside fenced code blocks untouched", () => {
      const input = "```\n$$ not math $$\n$$\n```\n\nreal $$x = 1$$ end";
      const normalized = normalizeDisplayMath(input);
      assert.ok(normalized.includes("```\n$$ not math $$\n$$\n```"));
      // every `$$` is preserved: 3 inside the fence + 2 in inline math
      assert.equal(normalized.match(/\$\$/g)?.length, 5);
    });

    it("leaves inline math and plain prose untouched", () => {
      const input = "text $x = 1$ and $$a + b$$ more";
      assert.equal(normalizeDisplayMath(input), input);
    });

    it("does not treat a glued opener with mid-line $$ as a block", () => {
      const input = "$$x$$ and text";
      assert.equal(normalizeDisplayMath(input), input);
    });
  });

  describe("\\[ … \\] blocks", () => {
    it("normalizes single-line brackets", () => {
      assert.equal(normalizeDisplayMath("\\[a + b\\]"), "$$\na + b\n$$");
    });

    it("keeps content indented when nested in a list item", () => {
      assert.equal(
        normalizeDisplayMath("- item:\n  \\[a + b\\]\n- next"),
        "- item:\n  $$\n  a + b\n  $$\n- next",
      );
    });

    it("normalizes multi-line brackets without double-indenting", () => {
      assert.equal(
        normalizeDisplayMath("- item:\n  \\[\n  x = y\n  \\]\n- next"),
        "- item:\n  $$\n  x = y\n  $$\n- next",
      );
    });
  });

  describe("loose [ … ] formula blocks", () => {
    it("normalizes model-emitted bracket-only formula lines", () => {
      assert.equal(
        normalizeDisplayMath("[ C(x) = \\frac{2}{T(T-1)} \\sum_{i<j} S(\\hat{y}^{(i)}, \\hat{y}^{(j)}) ]"),
        "$$\nC(x) = \\frac{2}{T(T-1)} \\sum_{i<j} S(\\hat{y}^{(i)}, \\hat{y}^{(j)})\n$$",
      );
    });

    it("leaves ambiguous bracket-only Markdown untouched", () => {
      for (const input of [
        "[普通说明文字]",
        "[See note (important)]",
        "[status=ready]",
        "[yes/no]",
        "[API_v2]\n\n[API_v2]: https://example.com/docs",
        "[C:\\Users\\alex]",
        "[\\\\server\\share]",
        "[https://example.com/\\alpha]",
      ]) {
        assert.equal(normalizeDisplayMath(input), input);
      }
    });
  });
});

describe("markdownRemarkPlugins (CJK emphasis, spec #650)", () => {
  it("bolds ** whose closing run sits behind 》 and before a CJK character", () => {
    const md =
      "- 词曲：汪苏泷（两版共用同一词曲）；2016 年 11 月随**手游《梦幻诛仙》**上线发行（完美世界出品，端游原作 2009 年，IP 源自萧鼎小说《诛仙》）";
    const nodes = emphasisTexts(md);
    assert.ok(
      nodes.some((n) => n.type === "strong" && n.text === "手游《梦幻诛仙》"),
      `missing bold 手游《梦幻诛仙》 in ${JSON.stringify(nodes)}`,
    );
  });

  it("bolds the 辛弃疾 case and keeps neighbouring bolds in the same paragraph", () => {
    const md = [
      '**"今日饮一杯愁滋味，不醉不归"**',
      '"愁滋味"是**辛弃疾《丑奴儿》**的典故（"少年不识愁滋味……这次第，怎一个愁字了得"）。',
    ].join("\n");
    const strongs = emphasisTexts(md).filter((n) => n.type === "strong").map((n) => n.text);
    assert.deepEqual(strongs, ['"今日饮一杯愁滋味，不醉不归"', "辛弃疾《丑奴儿》"]);
  });

  it("handles other CJK punctuation before the closing run", () => {
    assert.deepEqual(
      emphasisTexts("结论：**水温适度。**水的温度与室温相同").map((n) => n.text),
      ["水温适度。"],
    );
    assert.deepEqual(emphasisTexts("x**a）**中").map((n) => n.text), ["a）"]);
    assert.deepEqual(emphasisTexts("x*a》*中"), [{ type: "emphasis", text: "a》" }]);
  });

  it("bolds CJK emphasis inside GFM table cells", () => {
    const md = "| 句 | 评 |\n| --- | --- |\n| **青云山飞过燕》**好 | x |";
    assert.deepEqual(emphasisTexts(md).map((n) => n.text), ["青云山飞过燕》"]);
  });

  it("does not change Latin emphasis behavior", () => {
    assert.deepEqual(emphasisTexts("foo*bar*baz"), [{ type: "emphasis", text: "bar" }]);
    assert.deepEqual(emphasisTexts("foo_bar_baz"), []);
    assert.deepEqual(emphasisTexts("abc.**def"), []);
    assert.deepEqual(emphasisTexts("- **双版本发行**：汪苏泷自唱一版").map((n) => n.text), ["双版本发行"]);
  });

  it("keeps strikethrough, code spans, and single-tilde ranges intact", () => {
    assert.deepEqual(deleteTexts("这是~~删除线~~文字"), ["删除线"]);
    const code = renderPipeline("前 `**a》**b` 后");
    const inlineCode = [];
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "inlineCode") inlineCode.push(node.value);
      (node.children ?? []).forEach(walk);
    })(code);
    assert.deepEqual(inlineCode, ["**a》**b"]);
    assert.equal(emphasisTexts("频率 5~7U，倍率 100~200倍").length, 0);
    assert.equal(deleteTexts("频率 5~7U").length, 0);
  });
});
