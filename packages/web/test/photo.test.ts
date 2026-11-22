import { describe, expect, it } from "vitest";
import { fit, MAX_SIDE } from "../src/photo.js";

describe("fit", () => {
  it("scales the longer side down to the limit and keeps the shape", () => {
    expect(fit(4032, 3024)).toEqual({ width: MAX_SIDE, height: 1200 });
    expect(fit(3024, 4032)).toEqual({ width: 1200, height: MAX_SIDE });
  });

  it("never enlarges a small photo", () => {
    expect(fit(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("keeps a sliver at least a pixel wide", () => {
    expect(fit(10_000, 2)).toEqual({ width: MAX_SIDE, height: 1 });
  });
});
