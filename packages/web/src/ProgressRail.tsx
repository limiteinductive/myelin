// Floating right-hand Progress rail: quiet, real-time session timer, backlog & 7-day forecast,
// global mastery breakdown, and contextual card/thread inspector.
import type { Depth } from "@myelin/core";
import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, Switch, useContext } from "solid-js";
import { fetchProgress, type ProgressResponse } from "./drillApi.js";
import { PracticeContext } from "./practiceStore.js";
import { plainSidebarText } from "./sidebar.js";

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

function fmtClock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtMinutes(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

function fmtWait(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM >= 5 ? `${h}h ${remM}m` : `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
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

export function ProgressRail(props: {
  userId: string;
  open: boolean;
  overlay: boolean;
  revision: number;
  onCloseOverlay: () => void;
}) {
  const practice = useContext(PracticeContext)!;
  const [data, setData] = createSignal<ProgressResponse | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [target, setTarget] = createSignal<SavedTarget>(readSavedTarget(props.userId));
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

  // Reactive signature of changes that should refresh /api/progress cleanly.
  const refreshKey = createMemo(() => {
    const f = focusParams();
    const qLen = practice.state.queue.length;
    const completed = Object.keys(practice.state.sittingCompletedIds).length;
    const exp = f.exploration ? practice.state.explorations.find((e) => e.id === f.exploration) : null;
    const expSig = exp ? `${exp.turns.length}:${exp.crystallized_turn_count ?? 0}:${exp.crystallized_units?.length ?? 0}` : "";
    const sessBeats = f.exploration ? (practice.state.sessions[`explore:${f.exploration}`]?.beats.length ?? 0) : 0;
    return `${props.open ? 1 : 0}|${props.revision}|${f.unit ?? ""}|${f.exploration ?? ""}|${qLen}|${completed}|${expSig}|${sessBeats}`;
  });

  // Live debounced fetch whenever open and relevant state changes, plus 60s background refresh.
  createEffect(
    () => refreshKey(),
    () => {
      if (!props.open) return;
      const f = focusParams();
      let ctrl: AbortController | null = null;
      const load = async () => {
        ctrl?.abort();
        ctrl = new AbortController();
        try {
          const res = await fetchProgress({ tz, unit: f.unit, exploration: f.exploration }, ctrl.signal);
          setData(res);
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
    const onPointerDown = (e: MouseEvent) => {
      if (!props.open || !props.overlay) return;
      const el = e.target as HTMLElement | null;
      if (!el) return;
      if (railEl?.contains(el)) return;
      if (el.closest("[data-rail-toggle='true']")) return;
      props.onCloseOverlay();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointerDown);
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

  const forecastMax = createMemo(() => {
    const f = data()?.backlog.forecast ?? [];
    return Math.max(1, ...f);
  });

  const sessionSummary = createMemo(() => {
    const s = data()?.session;
    if (!s || s.practiced === 0) return "Nothing practiced yet";
    return `${s.practiced} practiced · ${s.first_try} first-try`;
  });

  const dueSplit = createMemo(() => {
    const due = data()?.backlog.due;
    if (!due) return "";
    return `${due.new} new · ${due.review} review · ${due.shaky} shaky`;
  });

  const isSittingDone = () => practice.state.stage.kind === "sitting-done";
  const isFreshExplore = () => practice.state.stage.kind === "explore";

  const onSelectTopic = (topic: string) => {
    practice.startTopicSitting(topic);
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
              <div class="v2-rail-lead">
                <span class="v2-rail-figure">00:00</span>
              </div>
              <div class="v2-rail-sub">Loading…</div>
            </section>
          }
        >
          {(d) => (
            <>
              {/* 1. Session */}
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
                <div class="v2-rail-lead">
                  <span class={{ "v2-rail-figure": true, "is-reached": targetReached() }}>
                    {fmtClock(stopwatchMs())}
                    <Show when={targetDurationMs()}>
                      {(dur) => <small>/ {fmtClock(dur() ?? 0)}</small>}
                    </Show>
                  </span>
                  <span class="v2-rail-aside">{fmtMinutes(todayMs())} today</span>
                </div>
                <Show when={targetDurationMs() !== null}>
                  <div class="v2-rail-track" aria-hidden="true">
                    <i style={{ width: `${targetPct()}%` }} />
                  </div>
                </Show>
                <div class="v2-rail-sub">{sessionSummary()}</div>
              </section>

              {/* 2 & 3. Backlog + Mastery (or calm empty note for brand-new learners) */}
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
                <section class="v2-rail-sec">
                  <div class="v2-rail-head">
                    <span class="v2-rail-label">Due now</span>
                  </div>
                  <div class="v2-rail-lead">
                    <span class="v2-rail-figure">{d()?.backlog.due.total ?? 0}</span>
                    <Show when={(d()?.backlog.cleared_today ?? 0) > 0}>
                      <span class="v2-rail-aside">{d()?.backlog.cleared_today} cleared today</span>
                    </Show>
                  </div>
                  <div class="v2-rail-sub">
                    <Show
                      when={(d()?.backlog.due.total ?? 0) > 0}
                      fallback={
                        d()?.backlog.next_due_in_ms
                          ? `Next due in ${fmtWait(d()!.backlog.next_due_in_ms!)}`
                          : "All caught up"
                      }
                    >
                      {dueSplit()}
                    </Show>
                  </div>
                  <div class="v2-rail-bars" aria-label="7-day due forecast">
                    <For each={d()?.backlog.forecast ?? []}>
                      {(count, idx) => {
                        const pct = () => (count > 0 ? Math.max(12, Math.round((count / forecastMax()) * 100)) : 0);
                        return (
                          <i
                            class={{ "is-today": idx() === 0 }}
                            style={{ height: pct() > 0 ? `${pct()}%` : "2px" }}
                            data-tip={`${idx() === 0 ? "Today" : `+${idx()}d`}: ${count} due`}
                          />
                        );
                      }}
                    </For>
                  </div>
                  <div class="v2-rail-days" aria-hidden="true">
                    <For each={d()?.backlog.forecast_days ?? []}>
                      {(day, idx) => <span class={{ "is-today": idx() === 0 }}>{day}</span>}
                    </For>
                  </div>
                </section>

                <section class="v2-rail-sec">
                  <div class="v2-rail-head">
                    <span class="v2-rail-label">Mastery</span>
                  </div>
                  <div class="v2-rail-lead">
                    <span class="v2-rail-figure">
                      {d()?.mastery.total ?? 0}
                      <small>{(d()?.mastery.total ?? 0) === 1 ? "unit" : "units"}</small>
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
                  </Show>
                  <div class="v2-rail-legend">
                    <span>
                      <i class="is-solid" />
                      <b>{d()?.mastery.solid ?? 0}</b> solid
                    </span>
                    <span>
                      <i class="is-learning" />
                      <b>{d()?.mastery.learning ?? 0}</b> learning
                    </span>
                    <span>
                      <i class="is-new" />
                      <b>{d()?.mastery.new ?? 0}</b> new
                    </span>
                  </div>
                  <Show when={(d()?.mastery.topics.length ?? 0) > 0}>
                    <div class="v2-rail-rows">
                      <For each={d()?.mastery.topics ?? []}>
                        {(t) => (
                          <button
                            type="button"
                            class="v2-rail-row"
                            data-tip={t.due > 0 ? `Practice ${t.topic} (${t.due} due)` : `Review ${t.topic}`}
                            onClick={() => onSelectTopic(t.topic)}
                          >
                            <span>{t.topic}</span>
                            <span class={{ "is-quiet": t.due === 0 }}>{t.due > 0 ? t.due : "·"}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </section>
              </Show>

              {/* 4. Contextual footer: This card or This thread (hidden on sitting-done receipt) */}
              <Show when={!isSittingDone()}>
                <Switch>
                  <Match when={(() => { const f = d()?.focus; return f?.kind === "unit" ? f : null; })()}>
                    {(u) => {
                      const unit = () => u() ?? null;
                      const depthIdx = () => {
                        const dep = unit()?.depth;
                        return dep ? DEPTH_STEPS.indexOf(dep) : 0;
                      };
                      const isFirst = () => (unit()?.reviews ?? 0) === 0;
                      const latencyLabel = () => {
                        const cur = unit();
                        if (!cur || isFirst() || cur.last_latency_ms === null) return "First time";
                        if (cur.first_latency_ms && cur.first_latency_ms !== cur.last_latency_ms) {
                          return `${fmtLatencySec(cur.first_latency_ms)} → ${fmtLatencySec(cur.last_latency_ms)}`;
                        }
                        return fmtLatencySec(cur.last_latency_ms);
                      };
                      const intervalLabel = () => {
                        const cur = unit();
                        if (!cur || isFirst() || !cur.interval_ms) return "Set after this rep";
                        return fmtInterval(cur.interval_ms);
                      };
                      return (
                        <section class="v2-rail-sec">
                          <div class="v2-rail-head">
                            <span class="v2-rail-label">This card</span>
                          </div>
                          <div class="v2-rail-title">{unit()?.topic || "General"}</div>
                          <div class="v2-rail-depth" aria-label={`Depth: ${unit()?.depth ?? "recall"}`}>
                            <For each={DEPTH_STEPS}>
                              {(step, idx) => (
                                <>
                                  <Show when={idx() > 0}>
                                    <i aria-hidden="true" />
                                  </Show>
                                  <span
                                    class={{
                                      "is-past": idx() < depthIdx(),
                                      "is-now": idx() === depthIdx(),
                                    }}
                                  >
                                    {step}
                                  </span>
                                </>
                              )}
                            </For>
                          </div>
                          <div class="v2-rail-rows">
                            <div class="v2-rail-row">
                              <span>Recall</span>
                              <span class={{ "is-quiet": isFirst() }}>
                                {isFirst() || unit()?.p_imm === null || unit()?.p_imm === undefined
                                  ? "New"
                                  : `${Math.round(unit()!.p_imm! * 100)}%`}
                              </span>
                            </div>
                            <div class="v2-rail-row">
                              <span>Reviews</span>
                              <span class={{ "is-quiet": isFirst() }}>{unit()?.reviews ?? 0}</span>
                            </div>
                            <div class="v2-rail-row">
                              <span>Latency</span>
                              <span class={{ "is-quiet": isFirst() || unit()?.last_latency_ms === null }}>
                                {latencyLabel()}
                              </span>
                            </div>
                            <div class="v2-rail-row">
                              <span>Interval</span>
                              <span class={{ "is-quiet": isFirst() || !unit()?.interval_ms }}>
                                {intervalLabel()}
                              </span>
                            </div>
                          </div>
                        </section>
                      );
                    }}
                  </Match>

                  <Match when={(() => { const f = d()?.focus; return f?.kind === "exploration" ? f : null; })()}>
                    {(e) => {
                      const exp = () => e() ?? null;
                      return (
                        <section class="v2-rail-sec">
                          <div class="v2-rail-head">
                            <span class="v2-rail-label">This thread</span>
                          </div>
                          <div class="v2-rail-title">{plainSidebarText(exp()?.title ?? "Exploration")}</div>
                          <div class="v2-rail-rows">
                            <div class="v2-rail-row">
                              <span>Turns</span>
                              <span>{exp()?.turns ?? 0}</span>
                            </div>
                            <div class="v2-rail-row">
                              <span>Units</span>
                              <span class={{ "is-quiet": (exp()?.saved_units ?? 0) === 0 }}>
                                {(exp()?.saved_units ?? 0) > 0
                                  ? `${exp()?.saved_units} saved`
                                  : "None yet"}
                              </span>
                            </div>
                            <Show when={exp()?.saving || (exp()?.unsaved_turns ?? 0) > 0}>
                              <div class="v2-rail-row">
                                <span>Unsaved</span>
                                <span class="is-quiet">
                                  {exp()?.saving
                                    ? "Saving…"
                                    : `${exp()?.unsaved_turns} ${exp()?.unsaved_turns === 1 ? "turn" : "turns"} · saves on leave`}
                                </span>
                              </div>
                            </Show>
                          </div>
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
                      <div class="v2-rail-rows">
                        <div class="v2-rail-row">
                          <span>Turns</span>
                          <span class="is-quiet">0</span>
                        </div>
                        <div class="v2-rail-row">
                          <span>Units</span>
                          <span class="is-quiet">Saves on leave</span>
                        </div>
                      </div>
                    </section>
                  </Match>
                </Switch>
              </Show>
            </>
          )}
        </Show>
      </aside>
    </Show>
  );
}
