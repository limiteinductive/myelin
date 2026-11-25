// The whole app: the sign-in screen, or the Myelin v2 practice shell backed by one account-scoped PracticeStore.
import { applyRunEvent, clockText, currentRun, runLeft, type Run } from "@myelin/core";
import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import { watchActivity } from "./activity.js";
import { extractSelectionText, selectionHasMath } from "./cite.js";
import { DrillView } from "./DrillView.js";
import { MapView } from "./MapView.js";
import { createPracticeStore, PracticeContext } from "./practiceStore.js";
import { login, SignInError, Sync, type Me } from "./sync.js";
import { inline } from "./text.js";
import type { QueueUnit } from "./drillApi.js";

export type Screen = { kind: "loading" } | { kind: "signin"; error?: string } | { kind: "thread"; session: Me };

const SEND_ICON = "M9 14V4M4.5 8.5 9 4l4.5 4.5";

function media(query: string): () => boolean {
  const m = typeof matchMedia === "function" ? matchMedia(query) : null;
  const [get, set] = createSignal(m?.matches ?? false);
  onSettled(() => {
    if (!m) return;
    const onChange = (e: MediaQueryListEvent) => set(e.matches);
    set(m.matches);
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  });
  return get;
}

function fmtWait(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function App(props: { screen: Screen; go: (s: Screen) => void }) {
  // Follow device light/dark preference with clean owner-scoped teardown.
  onSettled(() => {
    if (typeof matchMedia !== "function") return;
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const t = dark.matches ? "dark" : "light";
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    };
    applyTheme();
    dark.addEventListener("change", applyTheme);
    return () => dark.removeEventListener("change", applyTheme);
  });

  const signin = () => (props.screen.kind === "signin" ? props.screen : null);
  const session = () => (props.screen.kind === "thread" ? props.screen.session : null);
  return (
    <Switch>
      <Match when={signin()}>{(s) => <SignIn error={s().error} go={props.go} />}</Match>
      <Match when={session()} keyed>
        {(me) => <Workspace session={me} go={props.go} />}
      </Match>
    </Switch>
  );
}

function SignIn(props: { error?: string | undefined; go: (s: Screen) => void }) {
  const [empty, setEmpty] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let field!: HTMLInputElement;
  const shownError = () => error() ?? props.error ?? null;

  const submit = async (ev: SubmitEvent) => {
    ev.preventDefault();
    if (!field.value.trim()) return;
    setBusy(true);
    try {
      props.go({ kind: "thread", session: await login(field.value) });
    } catch (e) {
      setError(e instanceof SignInError ? e.message : "Could not reach the server.");
      setBusy(false);
    }
  };

  return (
    <main class="myl-signin">
      <span class="myl-logo" style={{ "font-size": "40px" }}>
        <svg class="myl-logo__mark" viewBox="0 0 96 96" aria-hidden="true">
          <path d="M12 88V56a18 18 0 0 1 36 0M48 88V32a18 18 0 0 1 36 0V88" fill="none" stroke="currentColor" stroke-width="12" stroke-linejoin="round" />
        </svg>
        Myelin
      </span>
      <form class="myl-composer" onSubmit={submit}>
        <div class="myl-composer__row">
          <input
            ref={field}
            class="myl-composer__field"
            type="text"
            aria-label="Invite link"
            placeholder="Paste your invite link"
            autocomplete="off"
            onInput={(e) => setEmpty(e.currentTarget.value.trim() === "")}
          />
          <button type="submit" class="myl-send" aria-label="Sign in" disabled={empty() || busy()}>
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d={SEND_ICON} />
            </svg>
          </button>
        </div>
      </form>
      <p class={{ "myl-trace": true, "app-warning": Boolean(shownError()) }} role="status">
        {shownError() ?? "Whoever runs this server can make you a link."}
      </p>
    </main>
  );
}

function Workspace(props: { session: Me; go: (s: Screen) => void }) {
  // Consistent 900px breakpoint matching v2.css @media (max-width: 900px)
  const narrow = media("(max-width: 900px)");
  const [sidebarOpen, setSidebarOpen] = createSignal(typeof matchMedia === "function" ? !matchMedia("(max-width: 900px)").matches : true);

  // Single account-scoped reactive store owned by this authenticated session.
  const practice = createPracticeStore(props.session.user.id);

  // Minimal Sync consumer: tracks timed runs (<Clock />), sign-out detection, and learner activity.
  const [run, setRun] = createSignal<Run | null>(null);
  const runTicking = createMemo(() => {
    const r = run();
    return r !== null && r.paused_at === null;
  });
  const [clockNow, setClockNow] = createSignal(Date.now());

  createEffect(
    () => runTicking(),
    (running) => {
      setClockNow(Date.now());
      if (!running) return;
      const t = setInterval(() => setClockNow(Date.now()), 250);
      return () => clearInterval(t);
    },
  );

  onSettled(() => {
    const s = new Sync(props.session, { passive: true });
    const runMap: Record<string, Run> = {};
    let folded = 0;

    const pull = () => {
      if (s.signedOut) {
        s.stop();
        props.go({ kind: "signin" });
        return;
      }
      if (s.events.length > folded) {
        for (; folded < s.events.length; folded++) {
          applyRunEvent(runMap, s.events[folded]!);
        }
        const cur = currentRun(runMap);
        setRun(cur ? { ...cur } : null);
      }
    };

    const off = s.subscribe(pull);
    s.start();
    const unwatch = watchActivity(s);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && practice.state.mapOpen) {
        practice.setMapOpen(false);
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key === "\\") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (e.key.toLowerCase() === "m") {
        e.preventDefault();
        practice.setMapOpen((v) => !v);
      }
    };
    const onCopy = (e: ClipboardEvent) => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!selectionHasMath(range)) return;
      const clean = extractSelectionText(range);
      if (!clean || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", clean);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("copy", onCopy);

    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("copy", onCopy);
      unwatch();
      off();
      s.stop();
    };
  });

  const closeSidebarOnNarrow = () => {
    if (narrow()) setSidebarOpen(false);
  };

  const strengthOpacity = (u: QueueUnit) => (u.reviews === 0 ? 0.24 : Math.max(0.22, Math.min(1, u.p_imm)));

  return (
    <PracticeContext value={practice}>
      <div class={{ "v2-workspace": true, "has-sidebar": sidebarOpen() }}>
        <aside class="v2-sidebar" aria-label="Up next" aria-hidden={sidebarOpen() ? "false" : "true"}>
          <div class="v2-sidebar-head">
            <span class="v2-sidebar-title">Up next</span>
            <Show when={practice.remainingCount() > 0}>
              <span class="v2-sidebar-count">{practice.remainingCount()}</span>
            </Show>
          </div>

          <div class="v2-sidebar-list">
            <Show
              when={practice.dueQueue().length > 0}
              fallback={
                <p class="v2-sidebar-empty">
                  {practice.doneQueue().length > 0
                    ? practice.soonestNextMs() !== null
                      ? `All caught up — next recall in ~${fmtWait(practice.soonestNextMs()!)}. Start an exploration or check Done below.`
                      : "All caught up for now. Start an exploration or check Done below."
                    : "Nothing queued yet. Explore something new to build your map."}
                </p>
              }
            >
              <For each={practice.dueQueue()}>
                {(u) => {
                  const isActive = () =>
                    !practice.state.mapOpen && practice.state.stage.kind === "unit" && practice.state.stage.unitId === u.unit_id;
                  const isDone = () => practice.state.justCompletedId === u.unit_id;
                  return (
                    <button
                      type="button"
                      class={{ "v2-sb-item": true, "is-active": isActive(), "is-done": isDone() }}
                      onClick={() => {
                        practice.selectUnit(u.unit_id);
                        closeSidebarOnNarrow();
                      }}
                    >
                      <span class="v2-sb-bar" style={{ opacity: isDone() ? 0.85 : strengthOpacity(u) }} />
                      <span class="v2-sb-text">{inline(practice.sidebarLabel(u))}</span>
                    </button>
                  );
                }}
              </For>
            </Show>

            <Show when={practice.state.explorations.length > 0}>
              <div class="v2-sb-briefings">
                <div class="v2-sb-section-head">
                  <span class="v2-sidebar-title">Explorations</span>
                </div>
                <For each={practice.state.explorations}>
                  {(e) => {
                    const isActive = () =>
                      !practice.state.mapOpen &&
                      practice.state.stage.kind === "exploration" &&
                      practice.state.stage.explorationId === e.id;
                    return (
                      <div class={{ "v2-sb-briefing-row": true, "is-active": isActive() }}>
                        <button
                          type="button"
                          class={{ "v2-sb-item": true, "is-active": isActive() }}
                          title={e.title}
                          onClick={() => {
                            practice.selectExploration(e.id);
                            closeSidebarOnNarrow();
                          }}
                        >
                          <span class="v2-sb-bar" style={{ opacity: isActive() ? 1 : 0.35 }} />
                          <span class="v2-sb-text">{inline(e.title)}</span>
                        </button>
                        <button
                          type="button"
                          class="v2-sb-frontier-rm"
                          aria-label={`Archive ${e.title}`}
                          title="Archive exploration (kept in Archived)"
                          onClick={() => void practice.archiveExplorationById(e.id)}
                        >
                          ×
                        </button>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>

            <Show when={practice.state.frontiers.length > 0}>
              <div class="v2-sb-briefings">
                <div class="v2-sb-section-head">
                  <span class="v2-sidebar-title">Briefings</span>
                </div>
                <For each={practice.state.frontiers}>
                  {(f) => {
                    const isActive = () =>
                      !practice.state.mapOpen && practice.state.stage.kind === "frontier" && practice.state.stage.frontierId === f.id;
                    return (
                      <div class={{ "v2-sb-briefing-row": true, "is-active": isActive() }}>
                        <button
                          type="button"
                          class={{ "v2-sb-item": true, "is-active": isActive() }}
                          title={f.title}
                          onClick={() => {
                            practice.selectFrontier(f.id);
                            closeSidebarOnNarrow();
                          }}
                        >
                          <span class="v2-sb-bar" style={{ opacity: isActive() ? 1 : 0.35 }} />
                          <span class="v2-sb-text">{inline(f.title)}</span>
                        </button>
                        <button
                          type="button"
                          class="v2-sb-frontier-rm"
                          aria-label={`Remove ${f.title}`}
                          title="Remove briefing"
                          onClick={() => void practice.removeFrontierById(f.id)}
                        >
                          ×
                        </button>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>

            <Show when={practice.doneQueue().length > 0}>
              <div class="v2-sb-done-wrap">
                <button
                  type="button"
                  class={{ "v2-sb-done-toggle": true, "is-open": practice.state.doneOpen }}
                  aria-expanded={practice.state.doneOpen ? "true" : "false"}
                  onClick={() => practice.setDoneOpen((v) => !v)}
                >
                  <svg class="v2-sb-done-chev" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M4.5 2.75L7.75 6 4.5 9.25" />
                  </svg>
                  <span>Done</span>
                  <span class="v2-sidebar-count">{practice.doneQueue().length}</span>
                </button>
                <Show when={practice.state.doneOpen}>
                  <div class="v2-sb-done-list">
                    <For each={practice.doneQueue()}>
                      {(u) => {
                        const isActive = () =>
                          !practice.state.mapOpen && practice.state.stage.kind === "unit" && practice.state.stage.unitId === u.unit_id;
                        return (
                          <button
                            type="button"
                            class={{ "v2-sb-item": true, "is-active": isActive(), "is-done": true }}
                            onClick={() => {
                              practice.selectUnit(u.unit_id);
                              closeSidebarOnNarrow();
                            }}
                          >
                            <span class="v2-sb-bar" style={{ opacity: 0.75 }} />
                            <span class="v2-sb-text">{inline(practice.sidebarLabel(u))}</span>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={practice.state.archivedExplorations.length > 0}>
              <div class="v2-sb-done-wrap">
                <button
                  type="button"
                  class={{ "v2-sb-done-toggle": true, "is-open": practice.state.archivedOpen }}
                  aria-expanded={practice.state.archivedOpen ? "true" : "false"}
                  onClick={() => practice.setArchivedOpen((v) => !v)}
                >
                  <svg class="v2-sb-done-chev" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M4.5 2.75L7.75 6 4.5 9.25" />
                  </svg>
                  <span>Archived</span>
                  <span class="v2-sidebar-count">{practice.state.archivedExplorations.length}</span>
                </button>
                <Show when={practice.state.archivedOpen}>
                  <div class="v2-sb-done-list">
                    <For each={practice.state.archivedExplorations}>
                      {(e) => (
                        <div class="v2-sb-briefing-row">
                          <button
                            type="button"
                            class="v2-sb-item is-done"
                            title={`Reopen "${e.title}"`}
                            onClick={() => {
                              void practice.unarchiveExplorationById(e.id);
                              closeSidebarOnNarrow();
                            }}
                          >
                            <span class="v2-sb-bar" style={{ opacity: 0.35 }} />
                            <span class="v2-sb-text">{inline(e.title)}</span>
                          </button>
                          <button
                            type="button"
                            class="v2-sb-frontier-rm"
                            aria-label={`Start new exploration from ${e.title}`}
                            title="Start new exploration with this context"
                            onClick={() => {
                              practice.startExplorationFrom(e);
                              closeSidebarOnNarrow();
                            }}
                          >
                            ↗
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </div>

          <div class="v2-sidebar-foot">
            <button
              type="button"
              class={{ "v2-sb-explore": true, "is-active": !practice.state.mapOpen && practice.state.stage.kind === "explore" }}
              onClick={() => {
                practice.selectExplore();
                closeSidebarOnNarrow();
              }}
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <path d="M7 2.5v9M2.5 7h9" />
              </svg>
              New exploration
            </button>
          </div>
        </aside>

        <Show when={sidebarOpen() && narrow()}>
          <div class="v2-sidebar-scrim" onClick={() => setSidebarOpen(false)} />
        </Show>

        <div class="v2-main">
          <header class="v2-topbar">
            <button
              type="button"
              class="v2-icon-toggle"
              aria-label={sidebarOpen() ? "Hide queue" : "Show queue"}
              aria-pressed={sidebarOpen() ? "true" : "false"}
              title="Toggle sidebar (⌘\)"
              onClick={() => setSidebarOpen((v) => !v)}
            >
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2.5" y="3" width="13" height="12" rx="2.5" />
                <path d="M6.75 3v12" />
              </svg>
            </button>

            <div class="v2-topbar-right">
              <Show when={run()}>{(r) => <RunClock run={r()} now={clockNow()} />}</Show>
              <button
                type="button"
                class={{ "v2-map-toggle": true, "is-active": practice.state.mapOpen }}
                aria-pressed={practice.state.mapOpen ? "true" : "false"}
                title="Toggle Map (⌘M)"
                onClick={() => practice.setMapOpen((v) => !v)}
              >
                Map
              </button>
            </div>
          </header>

          <div class="v2-body">
            {/* Keep DrillView mounted across Map toggles so in-flight checks & canvas strokes survive ⌘M */}
            <div class={{ "v2-stage-hidden": practice.state.mapOpen }}>
              <DrillView />
            </div>
            <Show when={practice.state.mapOpen}>
              <MapView />
            </Show>
          </div>
        </div>
      </div>
    </PracticeContext>
  );
}

/** A countdown reads whole seconds rounded up, so it shows 0:00 only at zero; padded like 05:30. */
const countdown = (ms: number) => {
  const t = clockText(Math.ceil(Math.max(0, ms) / 1000) * 1000);
  return t.length === 4 ? `0${t}` : t;
};

/** The run clock: the time left in a timed run. */
function RunClock(props: { run: Run; now: number }) {
  const paused = () => props.run.paused_at !== null;
  const left = () => runLeft(props.run, props.now);
  const last = () => !paused() && left() <= 60_000;
  return (
    <div
      class={{ "myl-clock": true, "myl-clock--last": last(), "myl-clock--paused": paused() }}
      role="timer"
      aria-label={paused() ? "Paused" : last() ? "Time left, last minute" : "Time left"}
    >
      <span class="myl-clock__time">{countdown(left())}</span>
      <span class="myl-clock__of">{paused() ? "paused" : `left of ${countdown(props.run.duration_ms)}`}</span>
    </div>
  );
}
