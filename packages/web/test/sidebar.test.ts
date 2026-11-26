import { describe, expect, it } from "vitest";
import type { QueueUnit } from "../src/drillApi.js";
import { formatSidebarDrillLabel, groupQueueByTopic, plainSidebarText, sidebarLayout } from "../src/sidebar.js";

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

  it("keeps Done with Practice and Archived with Explorations", () => {
    const none = { due: 0, backlog: 0, done: 0, archived: 0, briefings: 0 };
    expect(sidebarLayout(none)).toEqual({ practice: false, done: false, archived: false, briefings: false });
    // Live work shows Practice without a Done fold.
    expect(sidebarLayout({ ...none, due: 3 })).toMatchObject({ practice: true, done: false });
    expect(sidebarLayout({ ...none, backlog: 5 })).toMatchObject({ practice: true, done: false });
    // Finished cards alone keep Practice visible so Done stays reachable.
    expect(sidebarLayout({ ...none, done: 51 })).toMatchObject({ practice: true, done: true });
    // Archived shows on its own count, with or without active explorations.
    expect(sidebarLayout({ ...none, archived: 7 })).toMatchObject({ practice: false, archived: true });
    expect(sidebarLayout({ ...none, briefings: 1 }).briefings).toBe(true);
  });
});
