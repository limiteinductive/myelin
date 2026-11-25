import { describe, expect, it } from "vitest";
import { INLINE } from "../src/text.js";

describe("inline math regex", () => {
  const splitPieces = (s: string) => s.split(INLINE).filter(Boolean);

  it("handles escaped currency dollars inside inline math like $\\$10$ and $\\$0$", () => {
    const pieces = splitPieces("You win $\\$10$ with probability $0.2$ and $\\$0$ otherwise.");
    expect(pieces).toEqual([
      "You win ",
      "$\\$10$",
      " with probability ",
      "$0.2$",
      " and ",
      "$\\$0$",
      " otherwise.",
    ]);
  });

  it("handles single-character inline math like $x$ and standalone escaped \\$", () => {
    expect(splitPieces("Let $x$ cost \\$5.")).toEqual(["Let ", "$x$", " cost ", "\\$", "5."]);
  });

  it("does not swallow plain currency pairs like $10 and $20", () => {
    expect(splitPieces("Costs $10 and $20 today.")).toEqual(["Costs $10 and $20 today."]);
  });
});
