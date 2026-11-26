import { describe, expect, it } from "vitest";
import {
  buildAnnotatedLines,
  buildEditHighlightSegments,
  isAnnotationEdited,
  isCoachMessageRedundant,
  locateAnnotation,
} from "../src/annotate.js";

describe("inline annotation grounding", () => {
  it("locates exact and whitespace-tolerant substrings cleanly", () => {
    const text = "line 1\nthen E[sigmabar] = 1/4(sum_i E[(xi - mu)**2] + sum_i E[(mu - xbar)**2])\nline 3";
    const exact = locateAnnotation(text, "+ sum_i E[(mu - xbar)**2]");
    expect(exact).not.toBeNull();
    expect(text.slice(exact!.start, exact!.end)).toBe("+ sum_i E[(mu - xbar)**2]");

    const fuzzy = locateAnnotation(text, "+  sum_i  e[(mu - xbar)**2]");
    expect(fuzzy).not.toBeNull();
    expect(text.slice(fuzzy!.start, fuzzy!.end)).toBe("+ sum_i E[(mu - xbar)**2]");
  });

  it("splits lines, highlights spans inline, and anchors pins beneath the ending line", () => {
    const text = "I expect the answer to be < 1.\nLet I_i = 1 if face i never appears.\nE = 1/n sum_i (5/6)^10";
    const { lines, matchedCount } = buildAnnotatedLines(text, [
      { quote: "I expect the answer to be < 1.", note: "Good upfront bound estimate.", kind: "move" },
      { quote: "1/n sum_i", note: "Each face already has probability (5/6)^10 — why divide by n?", kind: "slip" },
    ]);
    expect(matchedCount).toBe(2);
    expect(lines).toHaveLength(3);
    expect(lines[0]!.pins).toHaveLength(1);
    expect(lines[0]!.pins[0]!.annotation.kind).toBe("move");
    expect(lines[1]!.pins).toHaveLength(0);
    expect(lines[2]!.pins).toHaveLength(1);
    expect(lines[2]!.pins[0]!.annotation.kind).toBe("slip");
    expect(lines[2]!.segments.some((s) => s.text === "1/n sum_i" && s.kind === "slip")).toBe(true);
  });

  it("detects when a flagged substring is fixed in the living draft and avoids duplicate coach boxes", () => {
    const quote = "+ sum_i E[(mu - xbar)**2]";
    expect(isAnnotationEdited("E = 1/4(sum_i E[(xi - mu)**2] + sum_i E[(mu - xbar)**2])", quote)).toBe(false);
    expect(isAnnotationEdited("E = 1/4(sum_i E[(xi - mu)**2] - sum_i E[(mu - xbar)**2])", quote)).toBe(true);

    expect(
      isCoachMessageRedundant("Check the sign before the offset term.", [
        { quote, note: "Check the sign before the offset term.", kind: "slip" },
      ]),
    ).toBe(true);
    expect(
      isCoachMessageRedundant("Good setup overall; fix the sign above and recompute.", [
        { quote, note: "Should this be minus?", kind: "slip" },
      ]),
    ).toBe(false);
  });

  it("splits live edit drafts into highlighted action spans and clears them once edited", () => {
    const anns = [
      { quote: "std (+eps)", note: "Check where ε sits relative to the square root.", kind: "slip" as const },
      { quote: "learned gamma", note: "Good detail.", kind: "move" as const },
    ];
    const before = buildEditHighlightSegments("dividing by the std (+eps) and learned gamma", anns);
    expect(before).toEqual([
      { text: "dividing by the " },
      { text: "std (+eps)", kind: "slip" },
      { text: " and learned gamma" },
    ]);
    const after = buildEditHighlightSegments("dividing by sqrt(var + eps) and learned gamma", anns);
    expect(after).toEqual([{ text: "dividing by sqrt(var + eps) and learned gamma" }]);
  });
});
