import { describe, expect, it } from "vitest";
import { inFence, insertFence } from "../src/fence.js";

const apply = (text: string, e: ReturnType<typeof insertFence>) => text.slice(0, e.from) + e.insert + text.slice(e.to);

describe("insertFence", () => {
  it("starts an empty block with the caret on its blank line", () => {
    const e = insertFence("", 0, 0);
    expect(apply("", e)).toBe("```\n\n```");
    expect(e.caret).toBe(4);
  });

  it("puts the fences on lines of their own after typed text", () => {
    const text = "this fails:";
    const e = insertFence(text, text.length, text.length);
    expect(apply(text, e)).toBe("this fails:\n```\n\n```");
    expect(apply(text, e).slice(e.caret)).toBe("\n```");
  });

  it("wraps the selection, caret after it", () => {
    const text = "see x = 1 here";
    const e = insertFence(text, 4, 9);
    expect(apply(text, e)).toBe("see \n```\nx = 1\n```\n here");
    expect(apply(text, e).slice(0, e.caret)).toBe("see \n```\nx = 1");
  });
});

describe("inFence", () => {
  const text = "look:\n```\nfor i in range(3):\n    print(i)\n```\nwhy?";
  it("is true between the fences and false outside them", () => {
    expect(inFence(text, 3)).toBe(false);
    expect(inFence(text, text.indexOf("for"))).toBe(true);
    expect(inFence(text, text.indexOf("print") + 3)).toBe(true);
    expect(inFence(text, text.indexOf("why"))).toBe(false);
    expect(inFence(text, text.length)).toBe(false);
  });

  it("counts a fence once the caret is past its backticks", () => {
    expect(inFence("```", 3)).toBe(true);
    expect(inFence("```", 2)).toBe(false);
    expect(inFence("```\nx\n```", 10)).toBe(false);
  });

  it("is open after an unclosed fence", () => {
    expect(inFence("```python\nx = 1", 15)).toBe(true);
  });
});
