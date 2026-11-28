// Floating right-hand Progress rail: session clock, the explore-or-practice read, the due pile and
// what it costs, mastery as a share solid, and the contextual card/thread inspector.
// The full backlog, weekly rhythm and every topic live in ProgressView; the rail links there once
// ("Overview") and steps back to the Session section alone while that view is open.
import type { Depth } from "@myelin/core";
import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, Switch, useContext } from "solid-js";
import { fetchProgress, type ProgressResponse } from "./drillApi.js";
import { PracticeContext } from "./practiceStore.js";
import {
  BALANCE_LABEL,
  BALANCE_ORDER,
  BALANCE_SCALE,
  barScale,
  caughtUpCaption,
  dueSplit,
  effortCaption,
  fmtMinutes,
  sum,
  weekCaption,
} from "./progressCopy.js";
import { plainSidebarText } from "./sidebar.js";

/** Topics the fold lists; the rest are in the full view. */
const RAIL_TOPICS = 5;

const DEPTH_STEPS: readonly Depth[] = ["recall", "rebuild", "explain", "use"];

type TargetChoice = null | 15 | 25;

interface SavedTarget {
  minutes: TargetChoice;
  startedAt: number;
}

function targetStorageKey(userId: string): string {
  return `myelin:rail-target:${userId}`;
}

function readSavedTarget(userId: string): SavedTarget {
  try {
    const raw = localStorage.getItem(targetStorageKey(userId));
    if (!raw) return { minutes: null, startedAt: Date.now() };
    const parsed = JSON.parse(raw) as { minutes?: unknown; startedAt?: unknown };
    const minutes: TargetChoice = parsed.minutes === 15 || parsed.minutes === 25 ? parsed.minutes : null;
    const startedAt = typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt) ? parsed.startedAt : Date.now();
    // Reset stale timed target after 6 hours
    if (minutes !== null && Date.now() - startedAt > 6 * 3_600_000) {
      return { minutes: null, startedAt: Date.now() };
    }
    return { minutes, startedAt };
  } catch {
    return { minutes: null, startedAt: Date.now() };
  }
}

function writeSavedTarget(userId: string, t: SavedTarget): void {
  try {
    localStorage.setItem(targetStorageKey(userId), JSON.stringify(t));
  } catch {
    /* ignore storage quota */
  }
}

function topicsStorageKey(userId: string): string {
  return `myelin:rail-topics:${userId}`;
}

function readTopicsOpen(userId: string): boolean {
  try {
    return localStorage.getItem(topicsStorageKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writeTopicsOpen(userId: string, open: boolean): void {
  try {
    localStorage.setItem(topicsStorageKey(userId), open ? "1" : "0");
  } catch {
    /* ignore storage quota */
  }
}

// Same chevron the sidebar folds use (App.tsx ChevronIcon); the rail sizes it in CSS.
const ChevronIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M4.5 2.75 7.75 6 4.5 9.25" />
  </svg>
);

const ArrowIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M2.25 6h7.5M6.75 3 9.75 6l-3 3" />
  </svg>
);

function fmtClock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtLatencySec(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function fmtInterval(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d}d`;
  return `${Math.round(d / 30)}mo`;
}

export interface MobileProgressReadout {
  time?: string;
  due?: string;
  label: string;
}

export function formatMobileProgressReadout(args: {
  data: ProgressResponse | null;
  hasTimedRun: boolean;
  fallbackDueCount: number;
}): MobileProgressReadout {
  const { data, hasTimedRun, fallbackDueCount } = args;
  if (!data) {
    if (fallbackDueCount > 0) {
      return { due: `${fallbackDueCount} due`, label: `${fallbackDueCount} due, toggle progress` };
    }
    return { due: "Progress", label: "Toggle progress" };
  }
  const todayMs = Math.max(data.session.today_active_ms, data.session.active_ms);
  const time = !hasTimedRun && todayMs >= 60_000 ? fmtMinutes(todayMs) : undefined;
  const dueTotal = data.backlog.due.total;
  const due = dueTotal > 0 ? `${dueTotal} due` : data.mastery.total > 0 ? "Caught up" : undefined;
  if (!time && !due) {
    return { due: "Progress", label: "Toggle progress" };
  }
  const parts = [time ? `${time} today` : null, due].filter(Boolean);
  return { time, due, label: `${parts.join(", ")}, toggle progress` };
}

export function ProgressRail(props: {
  userId: string;
  open: boolean;
  overlay: boolean;
  revision: number;
  keepFresh?: boolean;
  /** True while the full Progress view fills the stage: the rail keeps only its Session section. */
  overviewOpen?: boolean;
  onOpenOverview?: () => void;
  onData?: (data: ProgressResponse | null) => void;
  onCloseOverlay: () => void;
}) {
  const practice = useContext(PracticeContext)!;
  const [data, setData] = createSignal<ProgressResponse | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [target, setTarget] = createSignal<SavedTarget>(readSavedTarget(props.userId));
  const [topicsOpen, setTopicsOpen] = createSignal(readTopicsOpen(props.userId));
  let railEl: HTMLElement | undefined;

  const tz = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  })();

  const focusParams = createMemo(() => {
    const st = practice.state.stage;
    if (st.kind === "unit") return { unit: st.unitId, exploration: null as string | null };
    if (st.kind === "exploration") return { unit: null as string | null, exploration: st.explorationId };
    return { unit: null as string | null, exploration: null as string | null };
  });

  const shouldFetch = () => props.open || Boolean(props.keepFresh);

  // Reactive signature of changes that should refresh /api/progress cleanly.
  const refreshKey = createMemo(() => {
    const f = focusParams();
    const qLen = practice.state.queue.length;
    const completed = Object.keys(practice.state.sittingCompletedIds).length;
    const exp = f.exploration ? practice.state.explorations.find((e) => e.id === f.exploration) : null;
    const expSig = exp ? `${exp.turns.length}:${exp.crystallized_turn_count ?? 0}:${exp.crystallized_units?.length ?? 0}` : "";
    const sessBeats = f.exploration ? (practice.state.sessions[`explore:${f.exploration}`]?.beats.length ?? 0) : 0;
    return `${shouldFetch() ? 1 : 0}|${props.open ? 1 : 0}|${props.revision}|${f.unit ?? ""}|${f.exploration ?? ""}|${qLen}|${completed}|${expSig}|${sessBeats}`;
  });

  // Live debounced fetch whenever open (or keepFresh on mobile) and relevant state changes, plus 60s background refresh.
  createEffect(
    () => refreshKey(),
    () => {
      if (!shouldFetch()) return;
      const f = focusParams();
      let ctrl: AbortController | null = null;
      const load = async () => {
        ctrl?.abort();
        ctrl = new AbortController();
        try {
          const res = await fetchProgress({ tz, unit: f.unit, exploration: f.exploration }, ctrl.signal);
          setData(res);
          props.onData?.(res);
          setNow(Date.now());
        } catch {
          /* ignore transient or aborted fetch */
        }
      };
      const debounce = setTimeout(() => void load(), 120);
      const poll = setInterval(() => {
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          void load();
        }
      }, 60_000);
      return () => {
        clearTimeout(debounce);
        clearInterval(poll);
        ctrl?.abort();
      };
    },
  );

  // Smooth 1-second local stopwatch tick while the rail is visible.
  createEffect(
    () => props.open,
    (isOpen) => {
      if (!isOpen) return;
      setNow(Date.now());
      const t = setInterval(() => {
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          setNow(Date.now());
        }
      }, 1000);
      return () => clearInterval(t);
    },
  );

  // Dismiss overlay on Escape or outside click.
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && props.open && props.overlay) {
        props.onCloseOverlay();
      }
    };
    const onPointerDown = (e: Event) => {
      if (!props.open || !props.overlay) return;
      const el = e.target as HTMLElement | null;
      if (!el) return;
      if (railEl?.contains(el)) return;
      if (el.closest("[data-rail-toggle='true']")) return;
      props.onCloseOverlay();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  });

  const chooseTarget = (minutes: TargetChoice) => {
    const next: SavedTarget = { minutes, startedAt: Date.now() };
    setTarget(next);
    writeSavedTarget(props.userId, next);
  };

  // Compute live elapsed session & today active time (adding wall delta only while actively open, capped at 5m).
  const liveDeltaMs = createMemo(() => {
    const d = data();
    if (!d) return 0;
    const raw = Math.max(0, now() - d.as_of);
    return Math.min(raw, 5 * 60_000);
  });

  const activeRun = () => data()?.session.run ?? null;

  const targetDurationMs = createMemo(() => {
    const r = activeRun();
    if (r) return r.duration_ms;
    const m = target().minutes;
    return m ? m * 60_000 : null;
  });

  const stopwatchMs = createMemo(() => {
    const r = activeRun();
    if (r) {
      return r.paused ? r.elapsed_ms : Math.min(r.duration_ms, r.elapsed_ms + liveDeltaMs());
    }
    const t = target();
    if (t.minutes !== null) {
      return Math.max(0, now() - t.startedAt);
    }
    const base = data()?.session.active_ms ?? 0;
    return base + liveDeltaMs();
  });

  const todayMs = createMemo(() => (data()?.session.today_active_ms ?? 0) + liveDeltaMs());

  const targetReached = createMemo(() => {
    const dur = targetDurationMs();
    return dur !== null && stopwatchMs() >= dur;
  });

  const targetPct = createMemo(() => {
    const dur = targetDurationMs();
    if (!dur || dur <= 0) return 0;
    return Math.min(100, Math.round((stopwatchMs() / dur) * 1000) / 10);
  });

  const isNewLearner = createMemo(() => {
    const d = data();
    return Boolean(d && d.mastery.total === 0 && d.session.practiced === 0);
  });

  // One caption under the clock: today's time, then the sitting's count and first-try count.
  const sessionSummary = createMemo(() => {
    const s = data()?.session;
    const parts: string[] = [];
    if (todayMs() >= 60_000) parts.push(`${fmtMinutes(todayMs())} today`);
    if (s && s.practiced > 0) parts.push(`${s.practiced} practiced`, `${s.first_try} first try`);
    return parts.length > 0 ? parts.join(" · ") : "Nothing practiced yet";
  });

  // Two captions under "Due now": what the pile costs, then how it splits. Once it is clear,
  // one caption says what comes next.
  const dueCaptions = createMemo(() => {
    const b = data()?.backlog;
    if (!b) return [];
    if (b.due.total === 0) return [caughtUpCaption(b)];
    return [effortCaption(b), dueSplit(b.due)].filter(Boolean);
  });

  // The days after today, scaled among themselves so today's pile never flattens them.
  const upcoming = createMemo(() => {
    const b = data()?.backlog;
    const counts = b?.forecast_upcoming ?? [];
    const scale = barScale(counts);
    const days = b?.forecast_upcoming_days ?? [];
    return counts.map((count, i) => ({ count, frac: scale[i] ?? 0, day: days[i] ?? `+${i + 1}d` }));
  });
  const upcomingTotal = createMemo(() => sum(upcoming().map((u) => u.count)));
  const upcomingLabel = createMemo(() => {
    const days = upcoming();
    return `Due over the next ${days.length} days: ${upcomingTotal()}. ${days.map((u) => `${u.day} ${u.count}`).join(", ")}`;
  });

  const railTopics = createMemo(() => (data()?.mastery.topics ?? []).slice(0, RAIL_TOPICS));
  const topicsCount = createMemo(() => {
    const m = data()?.mastery;
    const total = Math.max(m?.topics_total ?? 0, m?.topics.length ?? 0);
    const shown = railTopics().length;
    return shown < total ? `${shown} of ${total}` : String(total);
  });

  const toggleTopics = () => {
    const next = !topicsOpen();
    setTopicsOpen(next);
    writeTopicsOpen(props.userId, next);
  };

  const isSittingDone = () => practice.state.stage.kind === "sitting-done";
  const isFreshExplore = () => practice.state.stage.kind === "explore";

  const onSelectTopic = (topic: string) => {
    practice.startTopicSitting(topic);
    if (props.overlay) props.onCloseOverlay();
  };

  const openOverview = () => {
    props.onOpenOverview?.();
    if (props.overlay) props.onCloseOverlay();
  };

  return (
    <Show when={props.open}>
      <aside
        ref={railEl}
        class={{ "v2-rail": true, "is-overlay": props.overlay }}
        aria-label="Progress"
      >
        <Show
          when={data()}
          fallback={
            <section class="v2-rail-sec">
              <div class="v2-rail-head">
                <span class="v2-rail-label">Session</span>
              </div>
              <div class="v2-rail-clock is-quiet">00:00</div>
              <div class="v2-rail-cap">Loading…</div>
            </section>
          }
        >
          {(d) => (
            <>
              {/* 1. Session: the rail's only display figure */}
              <section class="v2-rail-sec">
                <div class="v2-rail-head">
                  <span class="v2-rail-label">Session</span>
                  <Show when={!activeRun()}>
                    <div class="v2-rail-target" role="group" aria-label="Session target">
                      <button
                        type="button"
                        class={{ "is-on": target().minutes === null }}
                        aria-pressed={target().minutes === null ? "true" : "false"}
                        onClick={() => chooseTarget(null)}
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        class={{ "is-on": target().minutes === 15 }}
                        aria-pressed={target().minutes === 15 ? "true" : "false"}
                        onClick={() => chooseTarget(15)}
                      >
                        15m
                      </button>
                      <button
                        type="button"
                        class={{ "is-on": target().minutes === 25 }}
                        aria-pressed={target().minutes === 25 ? "true" : "false"}
                        onClick={() => chooseTarget(25)}
                      >
                        25m
                      </button>
                    </div>
                  </Show>
                </div>
                <div class={{ "v2-rail-clock": true, "is-reached": targetReached() }}>
                  {fmtClock(stopwatchMs())}
                  <Show when={targetDurationMs()}>
                    {(dur) => <small>/ {fmtClock(dur() ?? 0)}</small>}
                  </Show>
                </div>
                <Show when={targetDurationMs() !== null}>
                  <div class="v2-rail-track" aria-hidden="true">
                    <i style={{ width: `${targetPct()}%` }} />
                  </div>
                </Show>
                <div class="v2-rail-cap">{sessionSummary()}</div>
              </section>

              {/* While the full Progress view is open the rail is the session clock and nothing else,
                  so no figure is on screen twice. */}
              <Show when={!props.overviewOpen}>
              {/* 2-4. Balance, Due, Mastery (or a calm note for brand-new learners) */}
              <Show
                when={!isNewLearner()}
                fallback={
                  <section class="v2-rail-sec">
                    <div class="v2-rail-head">
                      <span class="v2-rail-label">Progress</span>
                    </div>
                    <p class="v2-rail-note">
                      Backlog and mastery appear here once your first exploration saves a unit.
                    </p>
                  </section>
                }
              >
                {/* 2. The read: practice first, balanced, or room to explore */}
                <section class="v2-rail-sec">
                  <div class="v2-rail-head">
                    <span class="v2-rail-lead">{BALANCE_LABEL[d()?.balance.status ?? "balanced"]}</span>
                    <span
                      class={{ "v2-rail-pips": true, "is-balance": true, "is-warm": d()?.balance.status === "practice" }}
                      role="img"
                      aria-label={`Balance: ${BALANCE_LABEL[d()?.balance.status ?? "balanced"]}`}
                      data-tip={BALANCE_SCALE}
                    >
                      <For each={BALANCE_ORDER}>
                        {(step) => <i class={{ "is-on": step === (d()?.balance.status ?? "balanced") }} />}
                      </For>
                    </span>
                  </div>
                  <div class="v2-rail-cap">{d() ? weekCaption(d()!.balance) : ""}</div>
                </section>

                {/* 3. Due now: the pile, what it costs, how it splits, and what follows it */}
                <section class="v2-rail-sec">
                  <div class="v2-rail-head">
                    <span class="v2-rail-lead">Due now</span>
                    <span class={{ "v2-rail-value": true, "is-quiet": (d()?.backlog.due.total ?? 0) === 0 }}>
                      {d()?.backlog.due.total ?? 0}
                    </span>
                  </div>
                  <For each={dueCaptions()}>{(line) => <div class="v2-rail-cap">{line}</div>}</For>
                  <div class="v2-rail-rows">
                    <Show when={(d()?.backlog.due.total ?? 0) > 0 && (d()?.backlog.due_later_today ?? 0) > 0}>
                      <div class="v2-rail-row">
                        <span>Later today</span>
                        <span>+{d()?.backlog.due_later_today ?? 0}</span>
                      </div>
                    </Show>
                    <div class="v2-rail-row">
                      <span>Next {upcoming().length} days</span>
                      <span class="v2-rail-next" role="img" aria-label={upcomingLabel()}>
                        <span class="v2-rail-spark" aria-hidden="true">
                          <For each={upcoming()}>
                            {(u) => (
                              <span data-tip={`${u.day}: ${u.count} due`}>
                                <i
                                  class={{ "is-zero": u.count === 0 }}
                                  style={{ height: u.count > 0 ? `${Math.max(3, Math.round(u.frac * 18))}px` : "2px" }}
                                />
                              </span>
                            )}
                          </For>
                        </span>
                        <b class={{ "is-quiet": upcomingTotal() === 0 }}>{upcomingTotal()}</b>
                      </span>
                    </div>
                  </div>
                </section>

                {/* 4. Mastery: anchored on the share that is solid */}
                <section class="v2-rail-sec">
                  <div class="v2-rail-head">
                    <span class="v2-rail-lead">Mastery</span>
                    <span class="v2-rail-value">
                      {d()?.mastery.solid_pct ?? 0}%<small>solid</small>
                    </span>
                  </div>
                  <Show when={(d()?.mastery.total ?? 0) > 0}>
                    <div class="v2-rail-seg" aria-hidden="true">
                      <Show when={(d()?.mastery.solid ?? 0) > 0}>
                        <i class="is-solid" style={{ flex: d()?.mastery.solid ?? 0 }} />
                      </Show>
                      <Show when={(d()?.mastery.learning ?? 0) > 0}>
                        <i class="is-learning" style={{ flex: d()?.mastery.learning ?? 0 }} />
                      </Show>
                      <Show when={(d()?.mastery.new ?? 0) > 0}>
                        <i class="is-new" style={{ flex: d()?.mastery.new ?? 0 }} />
                      </Show>
                    </div>
                    <div class="v2-rail-cap v2-rail-legend">
                      <span>
                        <b>{d()?.mastery.solid ?? 0}</b> solid
                      </span>
                      <span>
                        <b>{d()?.mastery.learning ?? 0}</b> learning
                      </span>
                      <span>
                        <b>{d()?.mastery.new ?? 0}</b> new
                      </span>
                    </div>
                  </Show>
                  <Show when={railTopics().length > 0}>
                    <button
                      type="button"
                      class={{ "v2-rail-fold": true, "is-open": topicsOpen() }}
                      aria-expanded={topicsOpen() ? "true" : "false"}
                      aria-controls="v2-rail-topics"
                      onClick={toggleTopics}
                    >
                      <span>Topics</span>
                      <ChevronIcon />
                      <span>{topicsCount()}</span>
                    </button>
                    <Show when={topicsOpen()}>
                      <div class="v2-rail-rows" id="v2-rail-topics">
                        <For each={railTopics()}>
                          {(t) => {
                            const name = plainSidebarText(t.topic) || t.topic;
                            return (
                              <button
                                type="button"
                                class="v2-rail-row"
                                data-tip={t.due > 0 ? `Practice ${name} (${t.due} due)` : `Review ${name}`}
                                onClick={() => onSelectTopic(t.topic)}
                              >
                                <span>{name}</span>
                                <span>{t.due > 0 ? t.due : ""}</span>
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </section>

                {/* The one way into the full Progress view: a footer row under the global sections */}
                <Show when={props.onOpenOverview}>
                  <section class="v2-rail-sec v2-rail-foot">
                    <button type="button" class="v2-rail-row v2-rail-go" onClick={openOverview}>
                      <span>Overview</span>
                      <ArrowIcon />
                    </button>
                  </section>
                </Show>
              </Show>

              {/* 5. Contextual section: This card or This thread (hidden on the sitting-done receipt) */}
              <Show when={!isSittingDone()}>
                <Switch>
                  <Match when={(() => { const f = d()?.focus; return f?.kind === "unit" ? f : null; })()}>
                    {(u) => {
                      const unit = () => u() ?? null;
                      const depth = (): Depth => unit()?.depth ?? "recall";
                      const depthIdx = () => Math.max(0, DEPTH_STEPS.indexOf(depth()));
                      const isFirst = () => (unit()?.reviews ?? 0) === 0;
                      const caption = () => {
                        const cur = unit();
                        if (!cur || isFirst()) return "First time · interval is set after this rep";
                        const reviews = `${cur.reviews} ${cur.reviews === 1 ? "review" : "reviews"}`;
                        if (cur.last_latency_ms === null) return reviews;
                        if (cur.first_latency_ms && cur.first_latency_ms !== cur.last_latency_ms) {
                          return `${reviews} · ${fmtLatencySec(cur.first_latency_ms)} → ${fmtLatencySec(cur.last_latency_ms)}`;
                        }
                        return `${reviews} · last answer ${fmtLatencySec(cur.last_latency_ms)}`;
                      };
                      const recall = () => {
                        const p = unit()?.p_imm;
                        return p === null || p === undefined ? null : `${Math.round(p * 100)}%`;
                      };
                      const interval = () => {
                        const ms = unit()?.interval_ms;
                        return ms ? fmtInterval(ms) : null;
                      };
                      return (
                        <section class="v2-rail-sec">
                          <div class="v2-rail-head">
                            <span class="v2-rail-label">This card</span>
                            <span
                              class="v2-rail-depth"
                              role="img"
                              aria-label={`Depth: ${depth()}, step ${depthIdx() + 1} of ${DEPTH_STEPS.length}`}
                              data-tip={DEPTH_STEPS.join(" → ")}
                            >
                              <span class="v2-rail-pips" aria-hidden="true">
                                <For each={DEPTH_STEPS}>
                                  {(_, idx) => <i class={{ "is-on": idx() <= depthIdx() }} />}
                                </For>
                              </span>
                              {depth()}
                            </span>
                          </div>
                          <div class="v2-rail-title">{plainSidebarText(unit()?.topic ?? "") || "General"}</div>
                          <div class="v2-rail-cap">{caption()}</div>
                          <Show when={!isFirst()}>
                            <div class="v2-rail-rows">
                              <div class="v2-rail-row">
                                <span>Recall</span>
                                <span class={{ "is-quiet": recall() === null }}>{recall() ?? "—"}</span>
                              </div>
                              <div class="v2-rail-row">
                                <span>Interval</span>
                                <span class={{ "is-quiet": interval() === null }}>{interval() ?? "—"}</span>
                              </div>
                            </div>
                          </Show>
                        </section>
                      );
                    }}
                  </Match>

                  <Match when={(() => { const f = d()?.focus; return f?.kind === "exploration" ? f : null; })()}>
                    {(e) => {
                      const exp = () => e() ?? null;
                      const summary = () => {
                        const turns = exp()?.turns ?? 0;
                        const saved = exp()?.saved_units ?? 0;
                        const units = saved > 0 ? `${saved} ${saved === 1 ? "unit" : "units"} saved` : "no units yet";
                        return `${turns} ${turns === 1 ? "turn" : "turns"} · ${units}`;
                      };
                      return (
                        <section class="v2-rail-sec">
                          <div class="v2-rail-head">
                            <span class="v2-rail-label">This thread</span>
                          </div>
                          <div class="v2-rail-title">{plainSidebarText(exp()?.title ?? "") || "Exploration"}</div>
                          <div class="v2-rail-cap">{summary()}</div>
                          <Show when={exp()?.saving || (exp()?.unsaved_turns ?? 0) > 0}>
                            <div class="v2-rail-cap">
                              {exp()?.saving
                                ? "Saving…"
                                : `${exp()?.unsaved_turns} unsaved ${exp()?.unsaved_turns === 1 ? "turn" : "turns"} · saves on leave`}
                            </div>
                          </Show>
                        </section>
                      );
                    }}
                  </Match>

                  <Match when={isFreshExplore()}>
                    <section class="v2-rail-sec">
                      <div class="v2-rail-head">
                        <span class="v2-rail-label">This thread</span>
                      </div>
                      <div class="v2-rail-title">New exploration</div>
                      <div class="v2-rail-cap">Units save when you leave</div>
                    </section>
                  </Match>
                </Switch>
              </Show>
              </Show>
            </>
          )}
        </Show>
      </aside>
    </Show>
  );
}
