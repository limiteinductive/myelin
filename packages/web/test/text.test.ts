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

  it("keeps inline math and code intact inside bold and italic spans for recursive rendering", () => {
    const line = "**Quotient rule for $\\frac{\\partial \\hat{x}_j}{\\partial x_i}$:** and **The $1/d$ factor in $\\text{rms}'$:**";
    const outer = splitPieces(line);
    expect(outer).toEqual([
      "**Quotient rule for $\\frac{\\partial \\hat{x}_j}{\\partial x_i}$:**",
      " and ",
      "**The $1/d$ factor in $\\text{rms}'$:**",
    ]);
    // Recursively splitting the inner bold content extracts the math spans cleanly
    expect(splitPieces(outer[0]!.slice(2, -2))).toEqual([
      "Quotient rule for ",
      "$\\frac{\\partial \\hat{x}_j}{\\partial x_i}$",
      ":",
    ]);
    expect(splitPieces(outer[2]!.slice(2, -2))).toEqual([
      "The ",
      "$1/d$",
      " factor in ",
      "$\\text{rms}'$",
      ":",
    ]);
    // Also handles * inside math inside bold, and _ inside math inside _italic_
    expect(splitPieces("**Optimal $x^*$ in `a*b`:**")).toEqual(["**Optimal $x^*$ in `a*b`:**"]);
    expect(splitPieces("_look at $x_i$ here_")).toEqual(["_look at $x_i$ here_"]);
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
