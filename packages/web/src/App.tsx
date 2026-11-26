// The whole app: the sign-in screen, or the Myelin v2 practice shell backed by one account-scoped PracticeStore.
import { applyRunEvent, clockText, currentRun, runLeft, type Run } from "@myelin/core";
import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import { watchActivity } from "./activity.js";
import { extractSelectionText, selectionHasMath } from "./cite.js";
import { DrillView } from "./DrillView.js";
import { createPracticeStore, PracticeContext, sessionHasWork, sessionKeyForStage, type Stage } from "./practiceStore.js";
import { login, SignInError, Sync, type Me } from "./sync.js";
import { formatSidebarDrillLabel, plainSidebarText, sidebarLayout } from "./sidebar.js";
import { installSidebarRoll, trackSidebarOverflow } from "./sidebarRoll.js";
import { installStyledTooltips } from "./tooltip.js";
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

// Sidebar density: how many exploration rows show before folding the rest behind a quiet toggle.
const EXPLORATION_LIMIT = 8;
const EXPLORATION_SHOWN = 7;

const ICON_STROKE = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.5",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  "aria-hidden": "true",
} as const;

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...ICON_STROKE}>
    <path d="M6 2v8M2 6h8" />
  </svg>
);
const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...ICON_STROKE}>
    <path d="M3 3l6 6M9 3l-6 6" />
  </svg>
);
const ArchiveIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...ICON_STROKE} stroke-width="1.2">
    <rect x="2.25" y="2.25" width="7.5" height="2.5" rx=".75" />
    <path d="M3 4.75v3.9a1.1 1.1 0 0 0 1.1 1.1h3.8A1.1 1.1 0 0 0 9 8.65v-3.9" />
    <path d="M5 7h2" />
  </svg>
);
const ChevronIcon = () => (
  <svg class="v2-sb-chev" width="12" height="12" viewBox="0 0 12 12" {...ICON_STROKE}>
    <path d="M4.5 2.75 7.75 6 4.5 9.25" />
  </svg>
);
const BranchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" {...ICON_STROKE}>
    <path d="M3 9l6-6M4.5 3H9v4.5" />
  </svg>
);
const SidebarToggleIcon = () => (
  <svg width="15" height="15" viewBox="0 0 18 18" {...ICON_STROKE}>
    <rect x="2.5" y="3" width="13" height="12" rx="2.5" />
    <path d="M6.75 3v12" />
  </svg>
);
const BackIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" {...ICON_STROKE}>
    <path d="M12.5 8H3.5M7.5 4 3.5 8l4 4" />
  </svg>
);
const ForwardIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" {...ICON_STROKE}>
    <path d="M3.5 8h9M8.5 4l4 4-4 4" />
  </svg>
);

/** A single-line sidebar title: fades only where clipped, and rolls on a sustained hover. */
const RollingSidebarText = (props: { text: string }) => (
  <span class="v2-sb-text" ref={trackSidebarOverflow}>
    <span class="v2-sb-roll">{props.text}</span>
  </span>
);

function fmtWait(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function App(props: { screen: Screen; go: (s: Screen) => void }) {
  // Follow device light/dark preference + install styled global tooltips with clean teardown.
  onSettled(() => {
    const cleanupTips = installStyledTooltips();
    if (typeof matchMedia !== "function") return cleanupTips;
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const t = dark.matches ? "dark" : "light";
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    };
    applyTheme();
    dark.addEventListener("change", applyTheme);
    return () => {
      dark.removeEventListener("change", applyTheme);
      cleanupTips();
    };
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
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          goBack();
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          goForward();
          return;
        }
      }
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key === "\\") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (e.key === "[" || e.key === "]") {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        if (e.key === "[") goBack();
        else goForward();
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

  // ----- In-app Back / Forward navigation history -----
  type NavEntry = { stage: Stage };
  const navKey = (e: NavEntry) => sessionKeyForStage(e.stage);
  const [navStack, setNavStack] = createSignal<NavEntry[]>([]);
  const [navIdx, setNavIdx] = createSignal(-1);
  let replayingNav = false;

  const currentNavEntry = createMemo<NavEntry>(() => {
    const s = practice.state.stage;
    const stage: Stage =
      s.kind === "unit"
        ? { kind: "unit", unitId: s.unitId }
        : s.kind === "frontier"
          ? { kind: "frontier", frontierId: s.frontierId }
          : s.kind === "exploration"
            ? { kind: "exploration", explorationId: s.explorationId }
            : { kind: "explore" };
    return { stage };
  });

  createEffect(
    () => (practice.state.queueLoaded ? currentNavEntry() : null),
    (entry) => {
      if (!entry) return;
      if (replayingNav) {
        replayingNav = false;
        return;
      }
      const stack = navStack();
      const idx = navIdx();
      const cur = idx >= 0 ? stack[idx] : undefined;
      if (cur && navKey(cur) === navKey(entry)) return;
      const next = [...stack.slice(0, idx + 1), entry].slice(-50);
      setNavStack(next);
      setNavIdx(next.length - 1);
    },
  );

  const canGoBack = () => navIdx() > 0;
  const canGoForward = () => navIdx() >= 0 && navIdx() < navStack().length - 1;

  const applyNavEntry = (entry: NavEntry) => {
    replayingNav = true;
    const s = entry.stage;
    if (s.kind === "unit") practice.selectUnit(s.unitId);
    else if (s.kind === "exploration") practice.selectExploration(s.explorationId);
    else if (s.kind === "frontier") practice.selectFrontier(s.frontierId);
    else practice.selectExplore();
  };

  const goBack = () => {
    const idx = navIdx();
    if (idx <= 0) return;
    const target = navStack()[idx - 1];
    if (!target) return;
    setNavIdx(idx - 1);
    applyNavEntry(target);
  };

  const goForward = () => {
    const idx = navIdx();
    const stack = navStack();
    if (idx < 0 || idx >= stack.length - 1) return;
    const target = stack[idx + 1];
    if (!target) return;
    setNavIdx(idx + 1);
    applyNavEntry(target);
  };

  const NavChrome = () => (
    <div class="v2-nav-chrome">
      <button
        type="button"
        class="v2-icon-toggle"
        aria-label={sidebarOpen() ? "Hide sidebar" : "Show sidebar"}
        aria-pressed={sidebarOpen() ? "true" : "false"}
        data-tip="Toggle sidebar (⌘\)"
        data-tip-side="bottom"
        onClick={() => setSidebarOpen((v) => !v)}
      >
        <SidebarToggleIcon />
      </button>
      <button
        type="button"
        class="v2-icon-toggle"
        aria-label="Back"
        disabled={!canGoBack()}
        data-tip={canGoBack() ? "Back (⌘[)" : undefined}
        data-tip-side="bottom"
        onClick={goBack}
      >
        <BackIcon />
      </button>
      <button
        type="button"
        class="v2-icon-toggle"
        aria-label="Forward"
        disabled={!canGoForward()}
        data-tip={canGoForward() ? "Forward (⌘])" : undefined}
        data-tip-side="bottom"
        onClick={goForward}
      >
        <ForwardIcon />
      </button>
    </div>
  );

  // ----- Sidebar view state (session-only; the record lives in the practice store) -----
  const stageUnitId = () => (practice.state.stage.kind === "unit" ? practice.state.stage.unitId : null);
  const isUnitActive = (id: string) => stageUnitId() === id;

  const [explorationsExpanded, setExplorationsExpanded] = createSignal(false);
  const visibleExplorations = createMemo(() => {
    const all = practice.state.explorations;
    if (explorationsExpanded() || all.length <= EXPLORATION_LIMIT) return all;
    const head = all.slice(0, EXPLORATION_SHOWN);
    const stage = practice.state.stage;
    const activeId = stage.kind === "exploration" ? stage.explorationId : null;
    const active = activeId ? all.find((e) => e.id === activeId) : undefined;
    return active && !head.includes(active) ? [...head, active] : head;
  });
  const hiddenExplorations = () => practice.state.explorations.length - visibleExplorations().length;

  const drillRow = (u: QueueUnit, done = false) => {
    const isActive = () => isUnitActive(u.unit_id);
    const isDone = () => done || practice.state.justCompletedId === u.unit_id;
    return (
      <button
        type="button"
        class={{ "v2-sb-item": true, "is-active": isActive(), "is-done": isDone() }}
        aria-current={isActive() ? "true" : undefined}
        onClick={() => {
          practice.selectUnit(u.unit_id);
          closeSidebarOnNarrow();
        }}
      >
        <RollingSidebarText
          text={formatSidebarDrillLabel(
            practice.sidebarLabel(u),
            [u.topic || u.kind, u.depth].filter(Boolean).join(" · "),
          )}
        />
      </button>
    );
  };

  const layout = () =>
    sidebarLayout({
      due: practice.dueQueue().length,
      backlog: practice.backlogDueCount(),
      done: practice.doneQueue().length,
      archived: practice.state.archivedExplorations.length,
      briefings: practice.state.frontiers.length,
    });

  const isPracticeActive = () => {
    const s = practice.state.stage;
    if (s.kind === "sitting-done") return true;
    if (s.kind !== "unit") return false;
    return practice.dueQueue().some((u) => u.unit_id === s.unitId);
  };

  const practiceDueTotal = () =>
    practice.remainingCount() > 0 ? practice.remainingCount() : practice.backlogDueCount();

  const canOpenPractice = () =>
    practice.dueQueue().length > 0 || practice.backlogDueCount() > 0;

  const openPractice = () => {
    const due = practice.dueQueue();
    if (due.length > 0) {
      const curId = stageUnitId();
      if (curId && due.some((u) => u.unit_id === curId)) {
        closeSidebarOnNarrow();
        return;
      }
      // Resume an in-progress due card first; otherwise take the scheduler's next due card.
      const inProgress = due.find((u) => {
        const sess = practice.state.sessions[u.unit_id];
        return Boolean(sess && sessionHasWork(sess) && !sess.passedVerdict?.ok);
      });
      const next = inProgress ?? due.find((u) => u.unit_id !== practice.state.justCompletedId) ?? due[0]!;
      practice.selectUnit(next.unit_id);
      closeSidebarOnNarrow();
      return;
    }
    if (practice.backlogDueCount() > 0) {
      practice.startNextSitting();
      closeSidebarOnNarrow();
    }
  };

  // A quiet sub-fold that closes its parent section: Done under Practice, Archived under Explorations.
  const subFold = (title: string, listId: string, count: () => number, open: () => boolean, toggle: () => void) => (
    <button
      type="button"
      class={{ "v2-sb-fold": true, "is-sub": true, "is-open": open() }}
      aria-expanded={open() ? "true" : "false"}
      aria-controls={listId}
      onClick={toggle}
    >
      <span class="v2-sb-fold-title">{title}</span>
      <span class="v2-sb-slot">
        <ChevronIcon />
      </span>
      <span class="v2-sidebar-count">{count()}</span>
    </button>
  );

  return (
    <PracticeContext value={practice}>
      <div class={{ "v2-workspace": true, "has-sidebar": sidebarOpen() }}>
        <aside class="v2-sidebar" aria-label="Explorations and practice" aria-hidden={sidebarOpen() ? "false" : "true"}>
          <div class="v2-sb-chrome">
            <NavChrome />
          </div>
          <div class="v2-sidebar-list" ref={installSidebarRoll}>
            <Show when={layout().practice}>
              <section class="v2-sb-section">
                <div class="v2-sb-block">
                  <button
                    type="button"
                    class={{
                      "v2-sb-practice-btn": true,
                      "is-active": isPracticeActive(),
                    }}
                    disabled={!canOpenPractice()}
                    aria-current={isPracticeActive() ? "true" : undefined}
                    data-tip={
                      practice.dueQueue().length === 0 && practice.backlogDueCount() > 0
                        ? `Start next sitting (${Math.min(8, practice.backlogDueCount())})`
                        : undefined
                    }
                    onClick={openPractice}
                  >
                    <span class="v2-sidebar-title">Practice</span>
                    <Show
                      when={practiceDueTotal() > 0}
                      fallback={
                        <Show when={practice.soonestNextMs()}>
                          {(ms) => <span class="v2-sidebar-count">in {fmtWait(ms())}</span>}
                        </Show>
                      }
                    >
                      <span class="v2-sidebar-count">{practiceDueTotal()}</span>
                    </Show>
                  </button>
                  <Show when={layout().done}>
                    {subFold(
                      "Done",
                      "v2-sb-done-list",
                      () => practice.doneQueue().length,
                      () => practice.state.doneOpen,
                      () => practice.setDoneOpen((v) => !v),
                    )}
                    <Show when={practice.state.doneOpen}>
                      <div class="v2-sb-fold-list" id="v2-sb-done-list">
                        <For each={practice.doneQueue()}>{(u) => drillRow(u, true)}</For>
                      </div>
                    </Show>
                  </Show>
                </div>
              </section>
            </Show>

            <section class="v2-sb-section">
              <div class="v2-sb-block">
                <div class="v2-sb-section-head">
                  <span class="v2-sidebar-title">Explorations</span>
                  <button
                    type="button"
                    class={{
                      "v2-sb-head-add": true,
                      "is-active": practice.state.stage.kind === "explore",
                    }}
                    aria-label="New exploration"
                    data-tip="New exploration"
                    onClick={() => {
                      practice.selectExplore();
                      closeSidebarOnNarrow();
                    }}
                  >
                    <PlusIcon />
                  </button>
                </div>
                <Show when={practice.state.explorations.length > 0}>
                  <For each={visibleExplorations()}>
                    {(e) => {
                      const isActive = () =>
                        practice.state.stage.kind === "exploration" &&
                        practice.state.stage.explorationId === e.id;
                      return (
                        <div class="v2-sb-row">
                          <button
                            type="button"
                            class={{ "v2-sb-item": true, "is-active": isActive() }}
                            aria-current={isActive() ? "true" : undefined}
                            onClick={() => {
                              practice.selectExploration(e.id);
                              closeSidebarOnNarrow();
                            }}
                          >
                            <RollingSidebarText text={plainSidebarText(e.title)} />
                          </button>
                          <button
                            type="button"
                            class="v2-sb-act"
                            aria-label={`Archive ${plainSidebarText(e.title)}`}
                            data-tip="Archive exploration"
                            onClick={() => void practice.archiveExplorationById(e.id)}
                          >
                            <ArchiveIcon />
                          </button>
                        </div>
                      );
                    }}
                  </For>
                  <Show when={practice.state.explorations.length > EXPLORATION_LIMIT}>
                    <button
                      type="button"
                      class="v2-sb-more"
                      aria-expanded={explorationsExpanded() ? "true" : "false"}
                      onClick={() => setExplorationsExpanded((v) => !v)}
                    >
                      {explorationsExpanded() ? "Show less" : `${hiddenExplorations()} more`}
                    </button>
                  </Show>
                </Show>
                <Show when={layout().archived}>
                  {subFold(
                    "Archived",
                    "v2-sb-archived-list",
                    () => practice.state.archivedExplorations.length,
                    () => practice.state.archivedOpen,
                    () => practice.setArchivedOpen((v) => !v),
                  )}
                  <Show when={practice.state.archivedOpen}>
                    <div class="v2-sb-fold-list" id="v2-sb-archived-list">
                      <For each={practice.state.archivedExplorations}>
                        {(e) => (
                          <div class="v2-sb-row">
                            <button
                              type="button"
                              class="v2-sb-item is-done"
                              onClick={() => {
                                void practice.unarchiveExplorationById(e.id);
                                closeSidebarOnNarrow();
                              }}
                            >
                              <RollingSidebarText text={plainSidebarText(e.title)} />
                            </button>
                            <button
                              type="button"
                              class="v2-sb-act"
                              aria-label={`Start new exploration from ${plainSidebarText(e.title)}`}
                              data-tip="Start new exploration with this context"
                              onClick={() => {
                                practice.startExplorationFrom(e);
                                closeSidebarOnNarrow();
                              }}
                            >
                              <BranchIcon />
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>
            </section>

            <Show when={layout().briefings}>
              <section class="v2-sb-section">
                <div class="v2-sb-block">
                  <div class="v2-sb-section-head">
                    <span class="v2-sidebar-title">Briefings</span>
                  </div>
                  <For each={practice.state.frontiers}>
                    {(f) => {
                      const isActive = () =>
                        practice.state.stage.kind === "frontier" && practice.state.stage.frontierId === f.id;
                      return (
                        <div class="v2-sb-row">
                          <button
                            type="button"
                            class={{ "v2-sb-item": true, "is-active": isActive() }}
                            aria-current={isActive() ? "true" : undefined}
                            onClick={() => {
                              practice.selectFrontier(f.id);
                              closeSidebarOnNarrow();
                            }}
                          >
                            <RollingSidebarText text={plainSidebarText(f.title)} />
                          </button>
                          <button
                            type="button"
                            class="v2-sb-act"
                            aria-label={`Remove ${plainSidebarText(f.title)}`}
                            data-tip="Remove briefing"
                            onClick={() => void practice.removeFrontierById(f.id)}
                          >
                            <CloseIcon />
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </section>
            </Show>
          </div>
        </aside>

        <Show when={sidebarOpen() && narrow()}>
          <div class="v2-sidebar-scrim" onClick={() => setSidebarOpen(false)} />
        </Show>

        <div class="v2-main">
          <header class="v2-topbar">
            <div class="v2-topbar-left">
              <Show when={!sidebarOpen() || narrow()}>
                <NavChrome />
              </Show>
            </div>

            <div class="v2-topbar-right">
              <Show when={run()}>{(r) => <RunClock run={r()} now={clockNow()} />}</Show>
            </div>
          </header>

          <div class="v2-body">
            <DrillView />
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
