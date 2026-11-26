import { describe, expect, it } from "vitest";
import { citationLabel, formatCitedMessage, normalizeCitedText } from "../src/cite.js";

describe("citations", () => {
  it("formats multiple citations with optional comments and main body text", () => {
    const out = formatCitedMessage(
      [
        { id: "c1", text: "why is $\\mathbb{E}[\\sum_i X_i] = \\sum_i \\mathbb{E}[X_i]$ valid here", comment: "does this need finite variance?" },
        { id: "c2", text: "divide by $n!$", comment: "" },
      ],
      "Wait, what if n is infinite?",
    );
    expect(out).toBe(
      "> why is $\\mathbb{E}[\\sum_i X_i] = \\sum_i \\mathbb{E}[X_i]$ valid here\ndoes this need finite variance?\n\n> divide by $n!$\n\nWait, what if n is infinite?",
    );
  });

  it("handles citation-only submissions with empty body", () => {
    const out = formatCitedMessage([{ id: "c1", text: "line 1\nline 2", comment: "explain this step" }], "   ");
    expect(out).toBe("> line 1\n> line 2\nexplain this step");
  });

  it("prefers comment over quote text for chip labels and truncates cleanly", () => {
    expect(citationLabel({ text: "long quoted passage", comment: "test citation" })).toBe("test citation");
    expect(citationLabel({ text: "a very long quoted passage without a comment attached to it", comment: "" }, 20)).toBe(
      "a very long quoted…",
    );
  });

  it("normalizes copied whitespace without collapsing paragraphs", () => {
    expect(normalizeCitedText("  hello   world \n\n\n  next   line  ")).toBe("hello world\n\nnext line");
  });

  it("formats 1-click ??? confused annotations alongside normal citations and main reply", () => {
    const out = formatCitedMessage(
      [
        { id: "c1", kind: "confused", text: "Poisson–multinomial", comment: "" },
        { id: "c2", kind: "confused", text: "$\\hat{y}_i / \\sum_j \\hat{y}_j$", comment: "why normalize?" },
      ],
      "Maybe so huge counts don't dominate?",
    );
    expect(out).toBe(
      "> Poisson–multinomial\n[I don't understand this]\n\n> $\\hat{y}_i / \\sum_j \\hat{y}_j$\n[I don't understand this] why normalize?\n\nMaybe so huge counts don't dominate?",
    );
  });
});
