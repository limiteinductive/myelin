import { describe, expect, it } from "vitest";
import { assembleFilledStarter, countStarterBlanks, parseStarterBlanks } from "../src/blanks.js";

describe("interactive fill-in-the-blank starter parser", () => {
  const qkNormStarter = [
    "1. At $\\gamma=1$, $\\|q\\|_2 = \\|k\\|_2 =$ ___, capping $\\frac{q \\cdot k}{\\sqrt{d_k}}$ at ___.",
    "2. Unconstrained $\\gamma$ still stabilizes logits over unnormalized $W_Q, W_K$ because ___.",
    "3. Order: apply QK-Norm ___ RoPE; when does order matter vs. not matter? ___.",
  ].join("\n");

  it("parses numbered KaTeX blanks without corrupting TeX underscores", () => {
    expect(countStarterBlanks(qkNormStarter)).toBe(5);
    const parsed = parseStarterBlanks(qkNormStarter);
    expect(parsed.blankCount).toBe(5);
    expect(parsed.listKind).toBe("ol");
    expect(parsed.lines).toHaveLength(3);
    expect(parsed.lines[0]!.marker).toBe("1.");
    expect(parsed.lines[0]!.segments.filter((s) => s.kind === "blank").map((s) => s.index)).toEqual([0, 1]);
    expect(parsed.lines[1]!.segments.filter((s) => s.kind === "blank").map((s) => s.index)).toEqual([2]);
    expect(parsed.lines[2]!.segments.filter((s) => s.kind === "blank").map((s) => s.index)).toEqual([3, 4]);
  });

  it("parses code skeleton blanks preserving indentation and plain lines", () => {
    const code = "dx_hat = dy * gamma\ndx_ln = ___\ndx_rms = ___";
    const parsed = parseStarterBlanks(code);
    expect(parsed.listKind).toBe("plain");
    expect(parsed.blankCount).toBe(2);
    expect(parsed.lines).toHaveLength(3);
  });

  it("substitutes filled answers in order and keeps unfilled blanks as ___", () => {
    const out = assembleFilledStarter(qkNormStarter, ["sqrt(d_k)", "sqrt(d_k)", "", "before", "when gamma != 1"]);
    expect(out).toContain("=\\|k\\|_2 =$".replace("=\\", " = \\") ? "sqrt(d_k), capping" : "");
    expect(out).toContain("at sqrt(d_k).");
    expect(out).toContain("because ___.");
    expect(out).toContain("apply QK-Norm before RoPE");
    expect(out).toContain("when gamma != 1.");
  });

  it("submits clarifying question directly when no blanks were filled", () => {
    expect(assembleFilledStarter(qkNormStarter, ["", "", "", "", ""], "what does unconstrained gamma mean?")).toBe(
      "what does unconstrained gamma mean?",
    );
  });
});
