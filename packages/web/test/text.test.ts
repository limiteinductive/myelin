import { describe, expect, it } from "vitest";
import { INLINE, inlineCodeClass } from "../src/text.js";

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

describe("inlineCodeClass", () => {
  it("renders short symbols bare, medium identifiers nowrap, and long expressions wrappable", () => {
    expect(inlineCodeClass("Q")).toBe("app-code is-bare");
    expect(inlineCodeClass("T=1")).toBe("app-code is-bare");
    expect(inlineCodeClass("(B, H, T, D)")).toBe("app-code is-nowrap");
    expect(inlineCodeClass("torch.einsum")).toBe("app-code is-nowrap");
    expect(inlineCodeClass("dx = (dx_hat - dx_hat.mean(-1, keepdim=True)) / std")).toBe("app-code");
  });
});
