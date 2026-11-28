// Full-canvas Progress view (stage.kind === "progress"): one calm page that answers "explore
// more, or practice?" and then shows the numbers behind the answer. Boxless and typographic:
// the read and two actions, the backlog and the days after it, the past week's intake against
// passing reps, mastery and depth, and every topic.
// It takes the same /api/progress payload the rail already fetches, so nothing here polls.
import type { Depth } from "@myelin/core";
import { createMemo, createSignal, For, onSettled, Show, useContext } from "solid-js";
import type { ProgressResponse, ProgressTopic } from "./drillApi.js";
import { PracticeContext } from "./practiceStore.js";
import {
  BALANCE_LABEL,
  BALANCE_ORDER,
  BALANCE_SCALE,
  barScale,
  caughtUpCaption,
  decisionRead,
  dueSplit,
  fmtMinutes,
  fmtSeconds,
  sum,
  topicReadout,
} from "./progressCopy.js";
import { plainSidebarText } from "./sidebar.js";

const DEPTH_STEPS: readonly Depth[] = ["recall", "rebuild", "explain", "use"];

type TopicFilter = "all" | "due";

/** Solid / learning / new as one slim bar; the same three tonal steps as the rail. */
function MasteryBar(props: { solid: number; learning: number; fresh: number; slim?: boolean }) {
  return (
    <span class={{ "v2-pv-seg": true, "is-slim": Boolean(props.slim) }} aria-hidden="true">
      <Show when={props.solid > 0}>
        <i class="is-solid" style={{ flex: props.solid }} />
      </Show>
      <Show when={props.learning > 0}>
        <i class="is-learning" style={{ flex: props.learning }} />
      </Show>
      <Show when={props.fresh > 0}>
        <i class="is-new" style={{ flex: props.fresh }} />
      </Show>
    </span>
  );
}

export function ProgressView(props: {
  data: ProgressResponse | null;
  /** What the practice action would do right now ("Start sitting", "Continue sitting"); null when nothing can be practiced. */
  practiceLabel: string | null;
  onPractice: () => void;
  onExplore: () => void;
  onClose: () => void;
}) {
  const practice = useContext(PracticeContext)!;
  const [filter, setFilter] = createSignal<TopicFilter>("all");

  // Escape steps back, unless an overlay above the page (the rail on a narrow screen) owns the key.
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".v2-rail.is-overlay")) return;
      props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const status = () => props.data?.balance.status ?? "balanced";
  const isEmpty = () => (props.data?.mastery.total ?? 0) === 0;
  const dueTotal = () => props.data?.backlog.due.total ?? 0;

  const read = createMemo(() => (props.data ? decisionRead(props.data) : []));

  // Exploring leads only when there is room for it; otherwise the sitting does.
  const exploreLeads = () => status() === "explore" || !props.practiceLabel;

  const upcoming = createMemo(() => {
    const b = props.data?.backlog;
    const counts = b?.forecast_upcoming ?? [];
    const scale = barScale(counts);
    const days = b?.forecast_upcoming_days ?? [];
    return counts.map((count, i) => ({ count, frac: scale[i] ?? 0, day: days[i] ?? `+${i + 1}d` }));
  });
  const upcomingTotal = createMemo(() => sum(upcoming().map((u) => u.count)));

  // Added and passed share one scale, so a day's two bars compare directly.
  const week = createMemo(() => {
    const days = props.data?.balance.activity_7d ?? [];
    const max = Math.max(4, ...days.map((d) => Math.max(d.added, d.passed)));
    return days.map((d, i) => ({ ...d, addedFrac: d.added / max, passedFrac: d.passed / max, today: i === days.length - 1 }));
  });

  const depths = createMemo(() => {
    const counts = props.data?.mastery.depth_counts;
    const values = DEPTH_STEPS.map((step) => counts?.[step] ?? 0);
    const max = Math.max(1, ...values);
    return DEPTH_STEPS.map((step, i) => ({ step, count: values[i] ?? 0, frac: (values[i] ?? 0) / max }));
  });

  const topics = createMemo(() => props.data?.mastery.topics ?? []);
  const dueTopics = createMemo(() => topics().filter((t) => t.due > 0));
  const shownTopics = createMemo(() => (filter() === "due" ? dueTopics() : topics()));

  const barPx = (frac: number, height: number) => (frac > 0 ? `${Math.max(3, Math.round(frac * height))}px` : "2px");
  const pct = (frac: number) => `${Math.max(frac > 0 ? 2 : 0, Math.round(frac * 100))}%`;

  const topicRow = (t: ProgressTopic) => {
    const name = plainSidebarText(t.topic) || t.topic;
    const readout = topicReadout(t);
    return (
      <button
        type="button"
        class="v2-pv-topic"
        data-tip={t.due > 0 ? `Practice ${name} (${t.due} due)` : `Review ${name}`}
        onClick={() => practice.startTopicSitting(t.topic)}
      >
        <span class="v2-pv-topic-name">{name}</span>
        <span class="v2-pv-topic-bar">
          <MasteryBar solid={t.solid} learning={t.learning} fresh={t.new} slim />
        </span>
        <span class="v2-pv-topic-ratio" aria-label={`${t.solid} of ${t.units} solid`}>
          {t.solid}/{t.units}
        </span>
        <span class={{ "v2-pv-topic-due": true, "is-quiet": readout.quiet }}>{readout.text}</span>
      </button>
    );
  };

  return (
    <div class="v2-pv">
      <div class="v2-pv-top">
        <span class="v2-pv-label">Progress</span>
        <button type="button" class="v2-ghost-btn v2-pv-close" onClick={() => props.onClose()}>
          Close
          <span class="v2-kbd" aria-hidden="true">
            esc
          </span>
        </button>
      </div>

      <Show
        when={props.data}
        fallback={
          <div class="v2-loading-dots">
            <span />
            <span />
            <span />
          </div>
        }
      >
        <Show
          when={!isEmpty()}
          fallback={
            <header class="v2-pv-lede">
              <h1 class="v2-pv-title">Nothing to track yet</h1>
              <p class="v2-pv-read">
                Your backlog, weekly rhythm and mastery appear here once your first exploration saves a unit.
              </p>
              <div class="v2-pv-actions">
                <button type="button" class="v2-btn-primary" onClick={() => props.onExplore()}>
                  Start exploring
                </button>
              </div>
            </header>
          }
        >
          {/* 1. The read, and the two ways to act on it */}
          <header class="v2-pv-lede">
            <div class="v2-pv-title-row">
              <h1 class="v2-pv-title">{BALANCE_LABEL[status()]}</h1>
              <span
                class={{ "v2-rail-pips": true, "is-balance": true, "is-warm": status() === "practice" }}
                role="img"
                aria-label={`Balance: ${BALANCE_LABEL[status()]}`}
                data-tip={BALANCE_SCALE}
              >
                <For each={BALANCE_ORDER}>{(step) => <i class={{ "is-on": step === status() }} />}</For>
              </span>
            </div>
            <p class="v2-pv-read">
              <For each={read()}>{(part) => (typeof part === "string" ? part : <b>{part.b}</b>)}</For>
            </p>
            <div class="v2-pv-actions">
              <Show
                when={exploreLeads()}
                fallback={
                  <>
                    <button type="button" class="v2-btn-primary" onClick={() => props.onPractice()}>
                      {props.practiceLabel}
                    </button>
                    <button type="button" class="v2-btn-secondary" onClick={() => props.onExplore()}>
                      Explore
                    </button>
                  </>
                }
              >
                <button type="button" class="v2-btn-primary" onClick={() => props.onExplore()}>
                  New exploration
                </button>
                <Show when={props.practiceLabel}>
                  <button type="button" class="v2-btn-secondary" onClick={() => props.onPractice()}>
                    {props.practiceLabel}
                  </button>
                </Show>
              </Show>
            </div>
          </header>

          {/* 2. Backlog: today's pile on the left, the days after it on their own scale on the right */}
          <section class="v2-pv-sec" aria-labelledby="v2-pv-backlog">
            <div class="v2-pv-head">
              <h2 class="v2-pv-label" id="v2-pv-backlog">
                Backlog
              </h2>
            </div>
            <div class="v2-pv-cols">
              <div>
                <p class={{ "v2-pv-stat": true, "is-quiet": dueTotal() === 0 }}>
                  <b>{dueTotal()}</b> due now
                </p>
                <Show
                  when={dueTotal() > 0}
                  fallback={<p class="v2-pv-cap">{props.data ? caughtUpCaption(props.data.backlog, false) : ""}</p>}
                >
                  <p class="v2-pv-cap">
                    About {fmtMinutes((props.data?.backlog.estimated_minutes ?? 0) * 60_000)}
                    <Show when={(props.data?.backlog.median_rep_ms ?? 0) > 0}>
                      {" "}
                      at {fmtSeconds(props.data?.backlog.median_rep_ms ?? 0)} a rep
                    </Show>
                    {" · "}
                    {props.data?.backlog.sittings_left ?? 0}{" "}
                    {(props.data?.backlog.sittings_left ?? 0) === 1 ? "sitting" : "sittings"}
                  </p>
                  <span class="v2-pv-seg is-due" aria-hidden="true">
                    <Show when={(props.data?.backlog.due.shaky ?? 0) > 0}>
                      <i class="is-shaky" style={{ flex: props.data?.backlog.due.shaky ?? 0 }} />
                    </Show>
                    <Show when={(props.data?.backlog.due.review ?? 0) > 0}>
                      <i class="is-learning" style={{ flex: props.data?.backlog.due.review ?? 0 }} />
                    </Show>
                    <Show when={(props.data?.backlog.due.new ?? 0) > 0}>
                      <i class="is-new" style={{ flex: props.data?.backlog.due.new ?? 0 }} />
                    </Show>
                  </span>
                  <p class="v2-pv-cap">{props.data ? dueSplit(props.data.backlog.due) : ""}</p>
                </Show>
                <dl class="v2-pv-kv">
                  <Show when={(props.data?.backlog.due_later_today ?? 0) > 0}>
                    <div>
                      <dt>Later today</dt>
                      <dd>+{props.data?.backlog.due_later_today ?? 0}</dd>
                    </div>
                  </Show>
                  <div>
                    <dt>Cleared today</dt>
                    <dd class={{ "is-quiet": (props.data?.backlog.cleared_today ?? 0) === 0 }}>
                      {props.data?.backlog.cleared_today ?? 0}
                    </dd>
                  </div>
                </dl>
              </div>

              <div>
                <p class="v2-pv-stat is-sub">
                  <b>{upcomingTotal()}</b> over the next {upcoming().length} days
                </p>
                <div
                  class="v2-pv-bars"
                  role="img"
                  aria-label={`Due per day: ${upcoming().map((u) => `${u.day} ${u.count}`).join(", ")}`}
                >
                  <For each={upcoming()}>
                    {(u) => (
                      <span class="v2-pv-bar-col">
                        <span class={{ "v2-pv-bar-val": true, "is-quiet": u.count === 0 }}>{u.count}</span>
                        <i class={{ "is-zero": u.count === 0 }} style={{ height: barPx(u.frac, 56) }} />
                        <span class="v2-pv-bar-day">{u.day}</span>
                      </span>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </section>

          {/* 3. Past 7 days: what came in against what was passed, day by day */}
          <section class="v2-pv-sec" aria-labelledby="v2-pv-week">
            <div class="v2-pv-head">
              <h2 class="v2-pv-label" id="v2-pv-week">
                Past 7 days
              </h2>
              <span class="v2-pv-label">
                {fmtMinutes(props.data?.balance.active_ms_7d ?? 0)} active · {props.data?.balance.first_try_7d ?? 0}{" "}
                first try
              </span>
            </div>
            <div class="v2-pv-flow" role="table" aria-label="Units added, reps passed and reps practiced per day">
              <div class="v2-pv-flow-row is-bars" aria-hidden="true">
                <span />
                <For each={week()}>
                  {(day) => (
                    <span class="v2-pv-pair">
                      <i class={{ "is-added": true, "is-zero": day.added === 0 }} style={{ height: barPx(day.addedFrac, 72) }} />
                      <i class={{ "is-passed": true, "is-zero": day.passed === 0 }} style={{ height: barPx(day.passedFrac, 72) }} />
                    </span>
                  )}
                </For>
                <span />
              </div>
              <div class="v2-pv-flow-row is-days" role="row">
                <span role="columnheader" />
                <For each={week()}>
                  {(day) => (
                    <span role="columnheader" class={{ "is-today": day.today }}>
                      {day.label}
                    </span>
                  )}
                </For>
                <span role="columnheader">Total</span>
              </div>
              <div class="v2-pv-flow-row" role="row">
                <span role="rowheader">
                  <i class="v2-pv-key is-added" aria-hidden="true" />
                  Added
                </span>
                <For each={week()}>
                  {(day) => (
                    <span role="cell" class={{ "is-zero": day.added === 0 }}>
                      {day.added}
                    </span>
                  )}
                </For>
                <span role="cell" class="is-total">
                  {props.data?.balance.added_7d ?? 0}
                </span>
              </div>
              <div class="v2-pv-flow-row" role="row">
                <span role="rowheader">
                  <i class="v2-pv-key is-passed" aria-hidden="true" />
                  Passed
                </span>
                <For each={week()}>
                  {(day) => (
                    <span role="cell" class={{ "is-zero": day.passed === 0 }}>
                      {day.passed}
                    </span>
                  )}
                </For>
                <span role="cell" class="is-total">
                  {props.data?.balance.passed_7d ?? 0}
                </span>
              </div>
              <div class="v2-pv-flow-row is-quiet" role="row">
                <span role="rowheader">
                  <i class="v2-pv-key" aria-hidden="true" />
                  Reps
                </span>
                <For each={week()}>
                  {(day) => (
                    <span role="cell" class={{ "is-zero": day.practiced === 0 }}>
                      {day.practiced}
                    </span>
                  )}
                </For>
                <span role="cell" class="is-total">
                  {props.data?.balance.practiced_7d ?? 0}
                </span>
              </div>
            </div>
          </section>

          {/* 4. Mastery, and how deep the units go */}
          <section class="v2-pv-sec" aria-labelledby="v2-pv-mastery">
            <div class="v2-pv-head">
              <h2 class="v2-pv-label" id="v2-pv-mastery">
                Mastery
              </h2>
              <span class="v2-pv-label">
                {props.data?.mastery.total ?? 0} {(props.data?.mastery.total ?? 0) === 1 ? "unit" : "units"}
              </span>
            </div>
            <div class="v2-pv-cols">
              <div>
                <p class="v2-pv-stat">
                  <b>{props.data?.mastery.solid_pct ?? 0}%</b> solid
                </p>
                <MasteryBar
                  solid={props.data?.mastery.solid ?? 0}
                  learning={props.data?.mastery.learning ?? 0}
                  fresh={props.data?.mastery.new ?? 0}
                />
                <p class="v2-pv-cap v2-pv-legend">
                  <span>
                    <b>{props.data?.mastery.solid ?? 0}</b> solid
                  </span>
                  <span>
                    <b>{props.data?.mastery.learning ?? 0}</b> learning
                  </span>
                  <span>
                    <b>{props.data?.mastery.new ?? 0}</b> new
                  </span>
                </p>
                <Show when={(props.data?.mastery.at_risk ?? 0) > 0}>
                  <dl class="v2-pv-kv">
                    <div>
                      <dt>
                        <i class="v2-pv-key is-shaky" aria-hidden="true" />
                        Shaky, at risk of slipping
                      </dt>
                      <dd>{props.data?.mastery.at_risk ?? 0}</dd>
                    </div>
                  </dl>
                </Show>
              </div>

              <div>
                <p class="v2-pv-stat is-sub">Depth</p>
                <div class="v2-pv-ladder" role="list">
                  <For each={depths()}>
                    {(row, idx) => (
                      <div role="listitem" data-step={idx() + 1}>
                        <span>{row.step}</span>
                        <span class="v2-pv-ladder-bar" aria-hidden="true">
                          <i style={{ width: pct(row.frac) }} />
                        </span>
                        <span class={{ "is-quiet": row.count === 0 }}>{row.count}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </section>

          {/* 5. Every topic; a row starts a sitting on it */}
          <Show when={topics().length > 0}>
            <section class="v2-pv-sec" aria-labelledby="v2-pv-topics">
              <div class="v2-pv-head">
                <h2 class="v2-pv-label" id="v2-pv-topics">
                  Topics
                </h2>
                <div class="v2-pv-filter" role="group" aria-label="Show topics">
                  <button
                    type="button"
                    class={{ "is-on": filter() === "all" }}
                    aria-pressed={filter() === "all" ? "true" : "false"}
                    onClick={() => setFilter("all")}
                  >
                    All {topics().length}
                  </button>
                  <button
                    type="button"
                    class={{ "is-on": filter() === "due" }}
                    aria-pressed={filter() === "due" ? "true" : "false"}
                    disabled={dueTopics().length === 0}
                    onClick={() => setFilter("due")}
                  >
                    Due {dueTopics().length}
                  </button>
                </div>
              </div>
              <div class="v2-pv-topics">
                <For each={shownTopics()}>{(t) => topicRow(t)}</For>
              </div>
            </section>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
