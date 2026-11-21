import { newPage, type PageState } from "@myelin/core";
import { describe, expect, it } from "vitest";
import { pageFacts } from "../src/pages.js";

const written = (lines: string[]): PageState => ({
  ...newPage("p1", "Scratch", null, Date.UTC(2026, 10, 22, 6, 41)),
  doc: { type: "doc", content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) },
  rev: 1,
});

describe("pageFacts", () => {
  it("counts what is written and shows no time", () => {
    const facts = pageFacts(written(["x = 1", "y = 2"]));
    expect(facts).toBe("2 lines");
    expect(facts).not.toMatch(/\d:\d\d|edited/);
  });

  it("names the tutor's questions about the page", () => {
    expect(pageFacts(written(["x = 1"]), 2)).toBe("1 line, 2 questions from the tutor");
  });

  it("says when nothing is written", () => {
    expect(pageFacts(newPage("p2", "Scratch", null, 0))).toBe("Nothing written yet");
    expect(pageFacts(newPage("p3", "Limits", "Find the limit.", 0))).toBe("A problem, not started");
  });
});
