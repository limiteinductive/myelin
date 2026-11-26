import { describe, expect, it } from "vitest";
import type { QueueUnit } from "../src/drillApi.js";
import { formatSidebarDrillLabel, groupQueueByTopic, plainSidebarText } from "../src/sidebar.js";

function mkUnit(id: string, topic: string | null): QueueUnit {
  return {
    unit_id: id,
    text: `Unit ${id}`,
    prompt: `Prompt ${id}`,
    kind: "concept",
    topic,
    depth: "recall",
    p_imm: 0.4,
    reviews: 0,
    next_in_ms: null,
    due: true,
  };
}

describe("sidebar helpers", () => {
  it("converts TeX math and markdown into crisp single-line plain text", () => {
    expect(
      plainSidebarText(
        "At decoding step $t$, attention outputs $\\sum_{i=1}^t (\\phi(q_t)^T \\phi(k_i)) v_i$ in `PyTorch`.",
      ),
    ).toBe("At decoding step t, attention outputs ∑ (φ(q_t)^T φ(k_i)) v_i in PyTorch.");

    expect(
      plainSidebarText("An unbounded vector $x \\in \\mathbb{R}^d$ via $c \\tanh(z/c)$ and $\\frac{1}{n}$"),
    ).toBe("An unbounded vector x ∈ ℝ^d via c tanh(z/c) and 1/n");
  });

  it("trims empty meta lead-ins while keeping spoiler-free context", () => {
    expect(
      formatSidebarDrillLabel("You want to train a model to predict raw genomic read-counts.", "Genomics"),
    ).toBe("Train a model to predict raw genomic read-counts.");
    expect(formatSidebarDrillLabel(null, "Borzoi · recall")).toBe("Borzoi · recall");
  });

  it("groups due items by normalized topic in priority order", () => {
    const groups = groupQueueByTopic([
      mkUnit("1", "Borzoi Genomics"),
      mkUnit("2", "Linear Attention"),
      mkUnit("3", "borzoi genomics"),
      mkUnit("4", null),
      mkUnit("5", "Linear Attention"),
    ]);
    expect(groups.map((g) => ({ title: g.title, ids: g.items.map((u) => u.unit_id) }))).toEqual([
      { title: "Borzoi Genomics", ids: ["1", "3"] },
      { title: "Linear Attention", ids: ["2", "5"] },
      { title: "General", ids: ["4"] },
    ]);
  });
});
