import { describe, expect, it } from "vitest";
import { formatMobileProgressReadout } from "../src/ProgressRail.js";
import type { ProgressResponse } from "../src/drillApi.js";

function makeProgress(overrides?: {
  todayActiveMs?: number;
  sessionActiveMs?: number;
  dueTotal?: number;
  masteryTotal?: number;
}): ProgressResponse {
  const dueTotal = overrides?.dueTotal ?? 0;
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
      due: { total: dueTotal, new: dueTotal, review: 0, shaky: 0 },
      cleared_today: 0,
      next_due_in_ms: null,
      forecast: [dueTotal, 0, 0, 0, 0, 0, 0],
      forecast_days: ["M", "T", "W", "T", "F", "S", "S"],
    },
    mastery: {
      solid: 0,
      learning: 0,
      new: overrides?.masteryTotal ?? 0,
      total: overrides?.masteryTotal ?? 0,
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
