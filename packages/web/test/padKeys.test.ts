import { describe, expect, it } from "vitest";
import { applyAutoIndentEnter, applyTabIndent } from "../src/padKeys.js";

describe("padKeys", () => {
  it("inserts 4 spaces on Tab and dedents current line on Shift+Tab", () => {
    const indented = applyTabIndent("x = 1", 0, 0, false);
    expect(indented).toEqual({ value: "    x = 1", selectionStart: 4, selectionEnd: 4 });

    const dedented = applyTabIndent("    x = 1", 7, 7, true);
    expect(dedented).toEqual({ value: "x = 1", selectionStart: 3, selectionEnd: 3 });

    const partial = applyTabIndent("  x = 1", 5, 5, true);
    expect(partial).toEqual({ value: "x = 1", selectionStart: 3, selectionEnd: 3 });
  });

  it("indents and dedents multi-line selections cleanly", () => {
    const src = "a = 1\nb = 2";
    const ind = applyTabIndent(src, 0, src.length, false);
    expect(ind?.value).toBe("    a = 1\n    b = 2");

    const ded = applyTabIndent(ind!.value, ind!.selectionStart, ind!.selectionEnd, true);
    expect(ded?.value).toBe(src);
  });

  it("auto-indents +4 spaces after Python colon or opening bracket and carries indent on Enter", () => {
    const afterDef = applyAutoIndentEnter("def rms_norm(x):", 16, 16);
    expect(afterDef).toEqual({
      value: "def rms_norm(x):\n    ",
      selectionStart: 21,
      selectionEnd: 21,
    });

    const carry = applyAutoIndentEnter("def f(x):\n    rms = x.pow(2)", 28, 28);
    expect(carry).toEqual({
      value: "def f(x):\n    rms = x.pow(2)\n    ",
      selectionStart: 33,
      selectionEnd: 33,
    });

    // Plain prose with no indent and no block opener falls through to native Enter
    expect(applyAutoIndentEnter("hello world", 11, 11)).toBeNull();
  });
});
