import { describe, expect, it } from "vitest";
import { formatMobileProgressReadout } from "../src/ProgressRail.js";
import { barScale, decisionRead, effortCaption, topicReadout } from "../src/progressCopy.js";
import { plainSidebarText } from "../src/sidebar.js";
import type { ProgressResponse } from "../src/drillApi.js";

function makeProgress(overrides?: {
  todayActiveMs?: number;
  sessionActiveMs?: number;
  dueTotal?: number;
  dueShaky?: number;
  dueLaterToday?: number;
  estimatedMinutes?: number;
  sittingsLeft?: number;
  masteryTotal?: number;
  added7d?: number;
  passed7d?: number;
}): ProgressResponse {
  const dueTotal = overrides?.dueTotal ?? 0;
  const dueShaky = overrides?.dueShaky ?? 0;
  const dueNew = Math.max(0, dueTotal - dueShaky);
  const masteryTotal = overrides?.masteryTotal ?? 0;
  return {
    as_of: 1_700_000_000_000,
    session: {
      started_at: 1_700_000_000_000,
      active_ms: overrides?.sessionActiveMs ?? 0,
      today_active_ms: overrides?.todayActiveMs ?? 0,
      practiced: 0,
      first_try: 0,
      run: null,
    },
    backlog: {
      due: { total: dueTotal, new: dueNew, review: 0, shaky: dueShaky },
      due_later_today: overrides?.dueLaterToday ?? 0,
      estimated_minutes: overrides?.estimatedMinutes ?? dueTotal,
      median_rep_ms: 60_000,
      sittings_left: overrides?.sittingsLeft ?? (dueTotal > 0 ? Math.ceil(dueTotal / 8) : 0),
      cleared_today: 0,
      next_due_in_ms: null,
      forecast: [dueTotal, 0, 0, 0, 0, 0, 0],
      forecast_days: ["M", "T", "W", "T", "F", "S", "S"],
      forecast_upcoming: [0, 0, 0, 0, 0, 0],
      forecast_upcoming_days: ["Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    },
    balance: {
      status: dueTotal >= 16 ? "practice" : dueTotal <= 8 ? "explore" : "balanced",
      added_7d: overrides?.added7d ?? 0,
      added_24h: 0,
      practiced_7d: overrides?.passed7d ?? 0,
      passed_7d: overrides?.passed7d ?? 0,
      first_try_7d: overrides?.passed7d ?? 0,
      active_ms_7d: 0,
      activity_7d: [
        { label: "Sun", initial: "S", added: 0, practiced: 0, passed: 0 },
        { label: "Mon", initial: "M", added: 0, practiced: 0, passed: 0 },
        { label: "Tue", initial: "T", added: 0, practiced: 0, passed: 0 },
        { label: "Wed", initial: "W", added: 0, practiced: 0, passed: 0 },
        { label: "Thu", initial: "T", added: 0, practiced: 0, passed: 0 },
        { label: "Fri", initial: "F", added: 0, practiced: 0, passed: 0 },
        { label: "Sat", initial: "S", added: 0, practiced: 0, passed: 0 },
      ],
    },
    mastery: {
      solid: 0,
      solid_pct: 0,
      learning: 0,
      new: masteryTotal,
      total: masteryTotal,
      at_risk: dueShaky,
      depth_counts: { recall: masteryTotal, rebuild: 0, explain: 0, use: 0 },
      topics_total: 0,
      topics: [],
    },
    focus: null,
  };
}

describe("formatMobileProgressReadout", () => {
  it("uses local fallback due count before progress loads", () => {
    expect(formatMobileProgressReadout({ data: null, hasTimedRun: false, fallbackDueCount: 6 })).toEqual({
      due: "6 due",
      label: "6 due, toggle progress",
    });
    expect(formatMobileProgressReadout({ data: null, hasTimedRun: false, fallbackDueCount: 0 })).toEqual({
      due: "Progress",
      label: "Toggle progress",
    });
  });

  it("shows today's minutes and due count when both are active", () => {
    const res = formatMobileProgressReadout({
      data: makeProgress({ todayActiveMs: 14 * 60_000, dueTotal: 7, masteryTotal: 20 }),
      hasTimedRun: false,
      fallbackDueCount: 0,
    });
    expect(res).toEqual({
      time: "14m",
      due: "7 due",
      label: "14m today, 7 due, toggle progress",
    });
  });

  it("omits 0m when under a minute today, and shows Caught up when queue is clear", () => {
    expect(
      formatMobileProgressReadout({
        data: makeProgress({ todayActiveMs: 25_000, dueTotal: 4, masteryTotal: 10 }),
        hasTimedRun: false,
        fallbackDueCount: 0,
      }),
    ).toEqual({
      time: undefined,
      due: "4 due",
      label: "4 due, toggle progress",
    });

    expect(
      formatMobileProgressReadout({
        data: makeProgress({ todayActiveMs: 0, dueTotal: 0, masteryTotal: 12 }),
        hasTimedRun: false,
        fallbackDueCount: 0,
      }),
    ).toEqual({
      time: undefined,
      due: "Caught up",
      label: "Caught up, toggle progress",
    });
  });

  it("suppresses duplicate time when a timed run clock is already shown", () => {
    expect(
      formatMobileProgressReadout({
        data: makeProgress({ todayActiveMs: 12 * 60_000, dueTotal: 5, masteryTotal: 15 }),
        hasTimedRun: true,
        fallbackDueCount: 0,
      }),
    ).toEqual({
      time: undefined,
      due: "5 due",
      label: "5 due, toggle progress",
    });
  });

  it("falls back to Progress for a brand new learner with no units or active time", () => {
    expect(
      formatMobileProgressReadout({
        data: makeProgress({ todayActiveMs: 0, dueTotal: 0, masteryTotal: 0 }),
        hasTimedRun: false,
        fallbackDueCount: 0,
      }),
    ).toEqual({
      due: "Progress",
      label: "Toggle progress",
    });
  });
});

describe("progressCopy and sidebar text", () => {
  it("scales upcoming bars against a floor without letting zero inflate", () => {
    expect(barScale([5, 2, 5, 2, 1, 0])).toEqual([1, 0.4, 1, 0.4, 0.2, 0]);
    expect(barScale([1, 0, 2], 4)).toEqual([0.25, 0, 0.5]);
  });

  it("formats effort, decision read, and topic readouts accurately", () => {
    const p = makeProgress({
      dueTotal: 32,
      dueShaky: 18,
      dueLaterToday: 12,
      estimatedMinutes: 29,
      sittingsLeft: 4,
      masteryTotal: 68,
      added7d: 65,
      passed7d: 72,
    });
    expect(effortCaption(p.backlog)).toBe("About 29m · 4 sittings");
    const sentence = decisionRead(p)
      .map((part) => (typeof part === "string" ? part : part.b))
      .join("");
    expect(sentence).toContain("32 due now");
    expect(sentence).toContain("29 minutes across 4 sittings");
    expect(sentence).toContain("18 shaky");
    expect(sentence).toContain("12 more arriving later today");
    expect(sentence).toContain("65 units");
    expect(sentence).toContain("72 reps");

    expect(
      topicReadout({
        topic: "Sauron",
        units: 9,
        due: 8,
        shaky: 5,
        solid: 2,
        learning: 7,
        new: 0,
        due_later_today: 0,
      }),
    ).toEqual({ text: "8 due · 5 shaky", quiet: false });
    expect(
      topicReadout({
        topic: "Linear attention",
        units: 4,
        due: 0,
        shaky: 0,
        solid: 2,
        learning: 2,
        new: 0,
        due_later_today: 0,
      }),
    ).toEqual({ text: "Caught up", quiet: true });
  });

  it("cleans truncated trailing inline TeX without breaking currency", () => {
    expect(plainSidebarText("Because RMSNorm ($\\gamma = 1$) projects $x")).toBe("Because RMSNorm (γ = 1) projects x");
    expect(plainSidebarText("Costs $5 today")).toBe("Costs $5 today");
  });
});
