// Progressive Solveit-style Practice, Briefing & Exploration stage:
// Always ONE single active pad at the bottom. Reads and writes directly into the account-scoped
// PracticeStore (zero duplicated session signals, zero module-level globals, zero flush races).
import { uuidv7, type Grade } from "@myelin/core";
import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, snapshot, Switch, useContext } from "solid-js";
import {
  buildAnnotatedLines,
  buildEditHighlightSegments,
  isAnnotationEdited,
  isCoachMessageRedundant,
  locateAnnotation,
  type InlineAnnotation,
} from "./annotate.js";
import { citationLabel, extractSelectionText, formatCitedMessage, type Citation } from "./cite.js";
import {
  askDrillFollowUp,
  checkDrill,
  createQuickUnit,
  exploreDrill,
  fetchNextDrill,
  overrideDrillGrade,
  respondFrontier,
  saveExploration,
  tidyDraft,
  type AddedUnit,
  type CheckDrillResponse,
  type Frontier,
} from "./drillApi.js";
import { PracticeContext, sessionHasWork, type Beat } from "./practiceStore.js";
import { handlePadIndentKey } from "./padKeys.js";
import { Body, inline, mathOnly } from "./text.js";

type CitePillState = { text: string; top: number; left: number };
type CiteEditorState =
  | { mode: "new"; text: string; top: number; left: number }
  | { mode: "edit"; id: string; text: string; top: number; left: number };

function beatUserPayload(b: Beat): string {
  return formatCitedMessage(b.citations ?? [], b.user);
}

function isFailedBeat(b: Beat): boolean {
  return Boolean(
    b.failed ||
      (!b.pending &&
        (/^(Could not (check|reach) .+ just now|Something feels incomplete or skipped)/.test(b.coach))),
  );
}

function failedBeatMessage(b: Beat): string {
  if (b.coach.startsWith("Something feels incomplete or skipped")) {
    return "Could not reach the judge earlier — retry to check your answer.";
  }
  return b.coach;
}

function RetryIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.46-3.54L13 6" />
      <path d="M13 2.75V6H9.75" />
    </svg>
  );
}

function AnnoIcon(props: { kind: InlineAnnotation["kind"] }) {
  return (
    <Switch
      fallback={
        <svg class="v2-anno-ico" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <path d="M6.4 6.3a1.7 1.7 0 0 1 3.2.6c0 1.1-1.6 1.4-1.6 2.3" />
          <path d="M8 11.6h.01" />
        </svg>
      }
    >
      <Match when={props.kind === "slip"}>
        <svg class="v2-anno-ico" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 5.2v3.3M8 11h.01" />
        </svg>
      </Match>
      <Match when={props.kind === "move"}>
        <svg class="v2-anno-ico" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3.5 8.5l3 3 6-6.5" />
        </svg>
      </Match>
    </Switch>
  );
}

function AnnotatedUserWork(props: {
  text: string;
  annotations: readonly InlineAnnotation[];
  canEdit: boolean;
  onEdit: () => void;
}) {
  const [hovered, setHovered] = createSignal<number | null>(null);
  const parsed = createMemo(() => buildAnnotatedLines(props.text, props.annotations));

  return (
    <div
      class="v2-anno-doc"
      onDblClick={() => {
        if (props.canEdit) props.onEdit();
      }}
    >
      <For each={parsed().lines}>
        {(line) => (
          <div class="v2-anno-row">
            <div class="v2-anno-line">
              <For each={line.segments}>
                {(seg) =>
                  seg.annotationIndex !== undefined ? (
                    <mark
                      class={{
                        "v2-anno-mark": true,
                        [`is-${seg.kind ?? "question"}`]: true,
                        "is-hovered": hovered() === seg.annotationIndex,
                      }}
                      onMouseEnter={() => setHovered(seg.annotationIndex!)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      {mathOnly(seg.text)}
                    </mark>
                  ) : (
                    <>{mathOnly(seg.text)}</>
                  )
                }
              </For>
              <Show when={line.segments.length === 1 && line.segments[0]!.text === ""}>{"\u200B"}</Show>
            </div>
            <Show when={line.pins.length > 0}>
              <div class="v2-anno-pins">
                <For each={line.pins}>
                  {(pin) => (
                    <div
                      class={{
                        "v2-anno-pin": true,
                        [`is-${pin.annotation.kind}`]: true,
                        "is-hovered": hovered() === pin.index,
                      }}
                      data-citable="true"
                      onMouseEnter={() => setHovered(pin.index)}
                      onMouseLeave={() => setHovered(null)}
                    >
                      <AnnoIcon kind={pin.annotation.kind} />
                      <div class="v2-anno-pin-body">
                        <Body text={pin.annotation.note} />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

function fmtDur(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function QuoteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6.5 6.5H3.75a.75.75 0 0 1-.75-.75V4.25a.75.75 0 0 1 .75-.75H6a.75.75 0 0 1 .75.75v3.25c0 2.1-1 3.5-2.75 4.25" />
      <path d="M12.75 6.5H10a.75.75 0 0 1-.75-.75V4.25a.75.75 0 0 1 .75-.75h2.25a.75.75 0 0 1 .75.75v3.25c0 2.1-1 3.5-2.75 4.25" />
    </svg>
  );
}

function BeatCitations(props: { items?: readonly Citation[] | undefined }) {
  return (
    <Show when={props.items && props.items.length > 0}>
      <div class="v2-beat-cites">
        <For each={props.items ?? []} keyed={(c) => c.id}>
          {(c) => (
            <div class={{ "v2-beat-cite": true, "is-confused": c().kind === "confused" }}>
              <div class="v2-beat-cite-quote">
                <Show
                  when={c().kind === "confused"}
                  fallback={<QuoteIcon />}
                >
                  <span class="v2-cite-qmark" data-tip="I don't understand this">???</span>
                </Show>
                <span class="v2-beat-cite-text">{inline(c().text)}</span>
              </div>
              <Show when={c().comment.trim().length > 0}>
                <div class="v2-beat-cite-comment">{c().comment}</div>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function AddedUnitsList(props: { items?: readonly AddedUnit[] | undefined; removingId: string | null; onUndo: (u: AddedUnit) => void }) {
  const practice = useContext(PracticeContext);
  return (
    <Show when={props.items && props.items.length > 0}>
      <div class="v2-added-list">
        <For each={props.items ?? []} keyed={(u) => u.unit_id}>
          {(u) => {
            const removed = () => Boolean(practice.state.removedUnits[u().unit_id]);
            return (
              <div class={{ "v2-added-row": true, "is-removed": removed() }}>
                <div class="v2-added-head">
                  <span class="v2-added-tag">{removed() ? "Removed" : u().observe_only ? "Added move" : "Added to map"}</span>
                  <Show when={!removed()}>
                    <button
                      type="button"
                      class="v2-added-undo"
                      disabled={props.removingId === u().unit_id}
                      onClick={() => props.onUndo(u())}
                    >
                      Remove
                    </button>
                  </Show>
                </div>
                <div class="v2-added-text">{inline(u().text)}</div>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

export function DrillView() {
  const practice = useContext(PracticeContext);

  // Local transient UI state only (all persistent session state lives in PracticeStore).
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [postBusy, setPostBusy] = createSignal(false);
  const [exiting, setExiting] = createSignal(false);
  const [sketchOpen, setSketchOpen] = createSignal(false);
  const [hasInk, setHasInk] = createSignal(false);
  const [removingId, setRemovingId] = createSignal<string | null>(null);
  const [overriding, setOverriding] = createSignal(false);
  const [bumpOpen, setBumpOpen] = createSignal(false);
  const [editingBeatIdx, setEditingBeatIdx] = createSignal<number | null>(null);
  const [editDraft, setEditDraft] = createSignal("");
  const [questionReply, setQuestionReply] = createSignal("");
  const [tidying, setTidying] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Selection-based citations & quiet "+ Map" pin (T3 Code-style floating pill on text selection)
  const [citePill, setCitePill] = createSignal<CitePillState | null>(null);
  const [citeEditor, setCiteEditor] = createSignal<CiteEditorState | null>(null);
  const [citeComment, setCiteComment] = createSignal("");
  const [pinningMap, setPinningMap] = createSignal(false);
  const [pinnedMap, setPinnedMap] = createSignal(false);
  const [manualAddedCount, setManualAddedCount] = createSignal(0);
  const [wrapDismissed, setWrapDismissed] = createSignal(false);

  const EXPLORE_WRAP_THRESHOLD = 6;

  // Active stage accessors backed directly by PracticeStore (fine-grained, single source of truth).
  const isExplore = () => practice.state.stage.kind === "explore";
  const activeExploration = () => practice.currentExploration();
  const isExploreMode = () => isExplore() || Boolean(activeExploration());
  const activeFrontier = () => practice.currentFrontier();
  const isNonUnit = () => isExplore() || Boolean(activeExploration()) || Boolean(activeFrontier());
  const activeUnitId = () => (practice.state.stage.kind === "unit" ? practice.state.stage.unitId : null);
  const sessionKey = () => practice.stageKey();
  const unitSession = () => (isExplore() ? undefined : practice.state.sessions[sessionKey()]);

  const rep = () => (isNonUnit() ? null : (unitSession()?.rep ?? null));
  const beats = () => (isExplore() ? practice.state.explore.beats : (unitSession()?.beats ?? []));
  const postBeats = () => (isNonUnit() ? [] : (unitSession()?.postBeats ?? []));
  const draft = () => (isExplore() ? practice.state.explore.draft : (unitSession()?.draft ?? ""));
  const postInput = () => (isNonUnit() ? "" : (unitSession()?.postInput ?? ""));
  const citations = () => (isExplore() ? practice.state.explore.citations : (unitSession()?.citations ?? []));
  const passedVerdict = () => (isNonUnit() ? null : (unitSession()?.passedVerdict ?? null));
  const overridden = () => (isNonUnit() ? false : Boolean(unitSession()?.overridden));
  const railItems = createMemo(() => practice.dueQueue().slice(0, 6));
  const exploreAddedIds = createMemo(() => {
    const ids = new Set<string>();
    if (!isExploreMode() && !activeFrontier()) return ids;
    for (const b of beats()) {
      if (!b.added) continue;
      for (const u of b.added) {
        if (!practice.state.removedUnits[u.unit_id]) ids.add(u.unit_id);
      }
    }
    return ids;
  });
  const exploreAddedCount = createMemo(() => exploreAddedIds().size + manualAddedCount());
  const dueFromExplore = createMemo(() => {
    const ids = exploreAddedIds();
    const due = practice.dueQueue();
    if (ids.size === 0) return [];
    return due.filter((u) => ids.has(u.unit_id));
  });
  const firstDueForBatch = () => dueFromExplore()[0] ?? practice.dueQueue()[0] ?? null;

  // Mutators targeting the current stage (or an explicitly captured ownerKey for async requests).
  const setDraftFor = (key: string, value: string) => {
    if (key === "__explore__") practice.updateExplore((d) => { d.draft = value; });
    else practice.updateUnitSession(key, (d) => { d.draft = value; });
  };
  const setPostInputFor = (key: string, value: string) => {
    if (key === "__explore__") return;
    practice.updateUnitSession(key, (d) => { d.postInput = value; });
  };
  const updateCitationsFor = (key: string, fn: (list: Citation[]) => void) => {
    if (key === "__explore__") practice.updateExplore((d) => fn(d.citations));
    else practice.updateUnitSession(key, (d) => fn(d.citations));
  };

  // Request & active-effort timer ownership (measures typing/sketching effort, not reading or coach waits).
  const IDLE_CUTOFF_MS = 15_000;
  let activeMs = 0;
  let lastActivityAt = 0;
  let loadSeq = 0;
  let loadAbort: AbortController | null = null;
  let activeAbort: AbortController | null = null;
  let postAbort: AbortController | null = null;
  let advanceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const recordActivity = () => {
    if (busy() || passedVerdict()?.ok) return;
    const now = Date.now();
    if (lastActivityAt > 0) {
      const delta = now - lastActivityAt;
      if (delta > 0 && delta <= IDLE_CUTOFF_MS) activeMs += delta;
      else if (delta > IDLE_CUTOFF_MS) activeMs += 1500;
    } else {
      activeMs += 1000;
    }
    lastActivityAt = now;
  };

  const pauseActivity = () => {
    lastActivityAt = 0;
  };

  const currentActiveLatencyMs = (): number | null => {
    if (activeMs <= 0) return null;
    return Math.max(500, Math.round(activeMs));
  };

  const ensureAttemptId = (ownerKey: string): string => {
    const existing = practice.state.sessions[ownerKey]?.attemptId;
    if (existing) return existing;
    const id = uuidv7();
    practice.updateUnitSession(ownerKey, (d) => {
      d.attemptId = id;
    });
    return id;
  };

  // DOM refs & canvas strokes
  let stageEl!: HTMLDivElement;
  let textarea!: HTMLTextAreaElement;
  let editTextarea!: HTMLTextAreaElement;
  let questionInputEl: HTMLTextAreaElement | undefined;
  let postInputEl!: HTMLInputElement;
  let citeTextarea!: HTMLTextAreaElement;
  let padEl!: HTMLDivElement;
  let canvas: HTMLCanvasElement | undefined;
  let canvasResizeObs: ResizeObserver | null = null;
  let strokes: { x: number; y: number }[][] = [];
  let curStroke: { x: number; y: number }[] | null = null;
  let drawing = false;

  const autoGrow = () => {
    if (!textarea) return;
    const minH = beats().length > 0 ? 36 : isExploreMode() ? 72 : 120;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(360, Math.max(minH, textarea.scrollHeight))}px`;
  };

  const autoGrowQuestion = () => {
    if (!questionInputEl) return;
    questionInputEl.style.height = "auto";
    questionInputEl.style.height = `${Math.min(160, Math.max(24, questionInputEl.scrollHeight))}px`;
  };

  const scrollPadIntoView = () => {
    requestAnimationFrame(() => {
      padEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      textarea?.focus();
    });
  };

  const redraw = () => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = getComputedStyle(canvas).color || "#e5e5e5";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2;
    for (const pts of strokes) {
      if (pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.stroke();
    }
  };

  const resizeCanvas = () => {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    const nextW = Math.round(r.width * dpr);
    const nextH = Math.round(r.height * dpr);
    if (canvas.width === nextW && canvas.height === nextH) return;
    canvas.width = nextW;
    canvas.height = nextH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  };

  const bindCanvas = (el: HTMLCanvasElement | undefined) => {
    canvasResizeObs?.disconnect();
    canvasResizeObs = null;
    canvas = el;
    if (el && typeof ResizeObserver !== "undefined") {
      canvasResizeObs = new ResizeObserver(() => resizeCanvas());
      canvasResizeObs.observe(el);
      requestAnimationFrame(resizeCanvas);
    }
  };

  const clearSketch = () => {
    strokes = [];
    setHasInk(false);
    redraw();
  };

  const exportSketch = (): string | null => {
    if (!sketchOpen() || !hasInk() || !canvas) return null;
    const tmp = document.createElement("canvas");
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const ctx = tmp.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--v2-surface").trim() || "#14161a";
    ctx.fillRect(0, 0, tmp.width, tmp.height);
    ctx.drawImage(canvas, 0, 0);
    return tmp.toDataURL("image/png");
  };

  const clearAdvanceTimer = () => {
    if (advanceTimer) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
    setExiting(false);
  };

  const cancelPending = () => {
    // Only abort — let `submitBeat`'s `finally` release `busy` cleanly when identity matches.
    activeAbort?.abort();
    requestAnimationFrame(() => textarea?.focus());
  };

  const cancelPostPending = () => {
    // Only abort — never null `postAbort` here so `finally` always releases `postBusy`.
    postAbort?.abort();
  };

  const resetTransient = () => {
    loadAbort?.abort();
    loadAbort = null;
    loadSeq++;
    activeAbort?.abort();
    postAbort?.abort();
    clearAdvanceTimer();
    setBusy(false);
    setPostBusy(false);
    setEditingBeatIdx(null);
    setEditDraft("");
    setQuestionReply("");
    setCitePill(null);
    setCiteEditor(null);
    setCiteComment("");
    setPinningMap(false);
    setPinnedMap(false);
    setBumpOpen(false);
    setManualAddedCount(0);
    setWrapDismissed(false);
    setError(null);
    clearSketch();
  };

  const transitionToNext = () => {
    if (exiting()) return;
    const curId = rep()?.unit_id ?? activeUnitId();
    clearAdvanceTimer();
    setExiting(true);
    advanceTimer = setTimeout(() => {
      advanceTimer = null;
      if (disposed) return;
      setExiting(false);
      practice.advanceFromUnit(curId);
    }, 180);
  };

  const loadUnit = async (unitId: string) => {
    // Always invalidate any in-flight unit fetch BEFORE checking cache (fixes slow-A -> cached-B race).
    resetTransient();
    const seq = loadSeq;
    const existing = practice.state.sessions[unitId];
    activeMs = existing?.activeMs ?? 0;
    lastActivityAt = 0;
    if (existing?.rep && sessionHasWork(existing)) {
      practice.rememberPrompt(unitId, existing.rep.prompt);
      setLoading(false);
      if (!existing.passedVerdict?.ok) {
        requestAnimationFrame(() => {
          autoGrow();
          textarea?.focus();
        });
      }
      return;
    }

    const ctrl = new AbortController();
    loadAbort = ctrl;
    setLoading(true);
    try {
      const res = await fetchNextDrill({ unitId }, ctrl.signal);
      if (disposed || seq !== loadSeq || ctrl.signal.aborted || practice.stageKey() !== unitId) return;
      if (res.rep) {
        practice.rememberPrompt(unitId, res.rep.prompt);
        practice.updateUnitSession(unitId, (d) => {
          d.scheduler = res.scheduler;
          d.rep = res.rep;
        });
      }
      activeMs = practice.state.sessions[unitId]?.activeMs ?? 0;
      lastActivityAt = 0;
      requestAnimationFrame(() => {
        autoGrow();
        textarea?.focus();
      });
    } catch (e) {
      if (disposed || seq !== loadSeq || ctrl.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Could not load prompt.");
    } finally {
      if (loadAbort === ctrl) loadAbort = null;
      if (!disposed && seq === loadSeq) setLoading(false);
    }
  };

  // Stage transition effect: tracks ONLY the stable discriminated stageKey + explicit reloadNonce.
  // Never fires on same-ID frontier refreshes or queue metric updates.
  createEffect(
    () => [practice.stageKey(), practice.reloadNonce()] as const,
    ([key]) => {
      if (key === "__explore__" || key.startsWith("briefing:") || key.startsWith("explore:")) {
        resetTransient();
        setLoading(false);
        activeMs = 0;
        lastActivityAt = 0;
        requestAnimationFrame(() => {
          autoGrow();
          textarea?.focus();
        });
        return;
      }
      void loadUnit(key);
    },
  );

  // Re-sync canvas DPR whenever Sketch opens or Map closes back to DrillView.
  createEffect(
    () => [sketchOpen(), practice.state.mapOpen, loading(), Boolean(passedVerdict()?.ok)] as const,
    ([open, mapOpen]) => {
      if (open && !mapOpen) requestAnimationFrame(resizeCanvas);
    },
  );

  // Selection-based citation machinery
  const findCitable = (node: Node | null): Element | null => {
    let cur: Node | null = node;
    while (cur && cur !== stageEl) {
      if (cur.nodeType === 1 && (cur as Element).getAttribute("data-citable") === "true") {
        return cur as Element;
      }
      cur = cur.parentNode;
    }
    return null;
  };

  const clearSelectedMath = () => {
    if (!stageEl) return;
    stageEl.querySelectorAll(".myl-math.is-selected").forEach((el) => el.classList.remove("is-selected"));
  };

  const syncSelectedMath = () => {
    if (!stageEl || practice.state.mapOpen) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      clearSelectedMath();
      return;
    }
    const range = sel.getRangeAt(0);
    for (const el of stageEl.querySelectorAll(".myl-math")) {
      const startIn =
        el.contains(range.startContainer) &&
        !(range.startContainer === el && range.startOffset === el.childNodes.length);
      const endIn =
        el.contains(range.endContainer) &&
        !(range.endContainer === el && range.endOffset === 0);
      let hit = startIn || endIn;
      if (!hit && range.intersectsNode(el)) {
        try {
          hit = range.comparePoint(el, 0) === 0 && range.comparePoint(el, el.childNodes.length) === 0;
        } catch {
          hit = false;
        }
      }
      el.classList.toggle("is-selected", hit);
    }
  };

  const updateSelectionPill = () => {
    if (practice.state.mapOpen) return;
    syncSelectedMath();
    if (citeEditor() || !stageEl) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setCitePill(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!findCitable(range.startContainer) || !findCitable(range.endContainer)) {
      setCitePill(null);
      return;
    }
    const text = extractSelectionText(range);
    if (!text) {
      setCitePill(null);
      return;
    }
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 4);
    const rect = rects.at(-1) ?? range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setCitePill(null);
      return;
    }
    const left = Math.min(window.innerWidth - 116, Math.max(116, rect.left + rect.width / 2));
    const below = rect.bottom + 10;
    const top = below > window.innerHeight - 48 ? Math.max(12, rect.top - 38) : below;
    setPinnedMap(false);
    setCitePill({ text, top, left });
  };

  const addConfusedCite = () => {
    const pill = citePill();
    if (!pill) return;
    const key = sessionKey();
    updateCitationsFor(key, (list) => {
      list.push({ id: uuidv7(), kind: "confused", text: pill.text, comment: "" });
    });
    setCitePill(null);
    setCiteEditor(null);
    clearSelectedMath();
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => {
      if (passedVerdict()?.ok) postInputEl?.focus();
      else textarea?.focus();
    });
  };

  const pinSelectionToMap = async () => {
    const pill = citePill();
    if (!pill || pinningMap() || pinnedMap()) return;
    setPinningMap(true);
    try {
      const topic = activeExploration()?.title ?? activeFrontier()?.title ?? null;
      await createQuickUnit({ text: pill.text, topic, told: true });
      if (disposed) return;
      setManualAddedCount((n) => n + 1);
      setPinnedMap(true);
      void practice.refreshQueue({ preserveOrder: true });
      setTimeout(() => {
        if (disposed) return;
        setCitePill(null);
        setPinnedMap(false);
        clearSelectedMath();
        window.getSelection()?.removeAllRanges();
      }, 750);
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : "Could not add to map.");
    } finally {
      if (!disposed) setPinningMap(false);
    }
  };

  const openNewCiteEditor = () => {
    const pill = citePill();
    if (!pill) return;
    const popW = Math.min(380, window.innerWidth - 32);
    const left = Math.min(window.innerWidth - popW - 16, Math.max(16, pill.left - popW / 2));
    const top = pill.top + 175 > window.innerHeight ? Math.max(16, pill.top - 178) : pill.top + 4;
    setCiteComment("");
    setCitePill(null);
    setCiteEditor({ mode: "new", text: pill.text, top, left });
    requestAnimationFrame(() => citeTextarea?.focus());
  };

  const openEditCiteEditor = (c: Citation, anchorEl: HTMLElement) => {
    const r = anchorEl.getBoundingClientRect();
    const popW = Math.min(380, window.innerWidth - 32);
    const left = Math.min(window.innerWidth - popW - 16, Math.max(16, r.left));
    const above = r.top - 174;
    const top = above >= 16 ? above : Math.min(window.innerHeight - 176, r.bottom + 8);
    setCitePill(null);
    setCiteComment(c.comment);
    setCiteEditor({ mode: "edit", id: c.id, text: c.text, top, left });
    requestAnimationFrame(() => {
      if (!citeTextarea) return;
      citeTextarea.focus();
      const len = citeTextarea.value.length;
      citeTextarea.setSelectionRange(len, len);
    });
  };

  const saveCitation = () => {
    const ed = citeEditor();
    if (!ed) return;
    const comment = citeComment().trim();
    const key = sessionKey();
    if (ed.mode === "new") {
      updateCitationsFor(key, (list) => {
        list.push({ id: uuidv7(), text: ed.text, comment });
      });
    } else {
      updateCitationsFor(key, (list) => {
        const item = list.find((x) => x.id === ed.id);
        if (item) item.comment = comment;
      });
    }
    setCiteEditor(null);
    setCiteComment("");
    clearSelectedMath();
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => {
      if (passedVerdict()?.ok) postInputEl?.focus();
      else textarea?.focus();
    });
  };

  const cancelCitation = () => {
    setCiteEditor(null);
    setCiteComment("");
    clearSelectedMath();
  };

  const removeCitation = (id: string) => {
    updateCitationsFor(sessionKey(), (list) => {
      const idx = list.findIndex((x) => x.id === id);
      if (idx >= 0) list.splice(idx, 1);
    });
    const ed = citeEditor();
    if (ed?.mode === "edit" && ed.id === id) setCiteEditor(null);
  };

  onSettled(() => {
    const onResize = () => {
      if (sketchOpen()) resizeCanvas();
      setCitePill(null);
    };
    const onScroll = () => {
      if (citePill()) setCitePill(null);
    };
    const onMouseUp = () => {
      requestAnimationFrame(updateSelectionPill);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.shiftKey || e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
        requestAnimationFrame(updateSelectionPill);
      }
    };
    const onSelectionChange = () => {
      if (practice.state.mapOpen) return;
      syncSelectedMath();
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setCitePill(null);
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest(".v2-cite-pill, .v2-cite-pop")) return;
      if (citePill()) setCitePill(null);
      if (citeEditor()) setCiteEditor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (practice.state.mapOpen) return;
      if (citeEditor()) {
        if (e.key === "Escape") {
          e.preventDefault();
          cancelCitation();
        }
        return;
      }
      if (e.key === "Escape" && editingBeatIdx() !== null) {
        e.preventDefault();
        setEditingBeatIdx(null);
        setEditDraft("");
        return;
      }
      if (e.key === "Escape" && busy()) {
        e.preventDefault();
        cancelPending();
      } else if (e.key === "Escape" && postBusy()) {
        e.preventDefault();
        cancelPostPending();
      } else if (passedVerdict()?.ok && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (postInput().trim().length > 0 || citations().length > 0) void sendPostFollowUp();
        else transitionToNext();
      }
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      disposed = true;
      loadAbort?.abort();
      activeAbort?.abort();
      postAbort?.abort();
      clearAdvanceTimer();
      canvasResizeObs?.disconnect();
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  });

  const canSubmit = () => {
    if (busy()) return false;
    if (!isNonUnit() && passedVerdict()?.ok) return false;
    const hasQuestionAnswer = Boolean(activeExploreQuestion() && questionReply().trim().length > 0);
    return draft().trim().length > 0 || hasQuestionAnswer || citations().length > 0 || (sketchOpen() && hasInk());
  };

  const triggerComplete = (
    ownerKey: string,
    res: CheckDrillResponse,
    finalUser: string,
    finalCitations: Citation[],
    finalSketch: string | null,
    replaceIdx?: number,
  ) => {
    const passedBeat: Beat = {
      user: finalUser,
      ...(finalCitations.length > 0 ? { citations: finalCitations } : {}),
      sketch: finalSketch,
      coach: res.message,
      ...(res.annotations && res.annotations.length > 0 ? { annotations: res.annotations } : {}),
      ...(res.added_units && res.added_units.length > 0 ? { added: res.added_units } : {}),
    };
    practice.updateUnitSession(ownerKey, (d) => {
      if (typeof replaceIdx === "number" && replaceIdx >= 0 && replaceIdx < d.beats.length) {
        d.beats[replaceIdx] = passedBeat;
        // Drop any trailing failed beats after a retried pass so the pass is cleanly last
        if (replaceIdx < d.beats.length - 1) d.beats.splice(replaceIdx + 1);
      } else {
        d.beats.push(passedBeat);
      }
      d.draft = "";
      d.citations = [];
      d.passedVerdict = res;
      d.overridden = false;
    });
    clearSketch();
    practice.markUnitCompleted(ownerKey);
  };

  const updateBeatsFor = (key: string, fn: (list: Beat[]) => void) => {
    if (key === "__explore__") practice.updateExplore((d) => fn(d.beats));
    else practice.updateUnitSession(key, (d) => fn(d.beats));
  };

  const executeBeatRequest = async (opts: {
    modeExplore: boolean;
    explorationId?: string | null;
    frontier: ReturnType<typeof activeFrontier>;
    unitRep: ReturnType<typeof rep>;
    attemptId?: string;
    latencyMs: number | null;
    priorBeats: Beat[];
    payloadText: string;
    sketch: string | null;
    testMe?: boolean;
    signal: AbortSignal;
    onDelta?: (partialText: string) => void;
  }): Promise<
    | {
        kind: "explore";
        message: string;
        question?: string;
        added: AddedUnit[];
        frontier?: Frontier;
        exploration?: { id: string; title: string };
        demonstratedCruxes?: number[];
        failed: boolean;
      }
    | { kind: "drill"; res: CheckDrillResponse }
    | null
  > => {
    const cleanPrior = opts.priorBeats.filter((b) => !b.pending && !isFailedBeat(b));

    if (opts.modeExplore) {
      const turns: { role: "user" | "assistant"; text: string }[] = [];
      for (const b of cleanPrior) {
        const u = beatUserPayload(b);
        if (u) turns.push({ role: "user", text: u });
        const coachFull = b.question ? `${b.coach}\n\n${b.question}` : b.coach;
        if (coachFull) turns.push({ role: "assistant", text: coachFull });
      }
      const initial = cleanPrior.length === 0 ? opts.payloadText : beatUserPayload(cleanPrior[0]!);
      const priorAfterFirst = cleanPrior.length === 0 ? [] : turns.slice(1);
      const res = await exploreDrill(
        {
          exploration_id: opts.explorationId ?? null,
          initial,
          sketch_data_url: opts.sketch,
          turns: priorAfterFirst,
          ...(cleanPrior.length > 0 ? { reply: opts.payloadText } : {}),
        },
        opts.signal,
        opts.onDelta,
      );
      return {
        kind: "explore",
        message: res.message,
        ...(res.question ? { question: res.question } : {}),
        added: res.added_units,
        frontier: res.frontier,
        exploration: res.exploration,
        failed: Boolean(res.failed),
      };
    }

    if (opts.frontier) {
      const priorTurns: { role: "user" | "assistant"; text: string }[] = [];
      for (const b of cleanPrior) {
        const u = beatUserPayload(b);
        if (u) priorTurns.push({ role: "user", text: u });
        if (b.coach) priorTurns.push({ role: "assistant", text: b.coach });
      }
      const res = await respondFrontier(
        opts.frontier.id,
        {
          turns: priorTurns,
          reply: opts.payloadText,
          ...(opts.testMe ? { test_me: true } : {}),
          sketch_data_url: opts.sketch,
        },
        opts.signal,
        opts.onDelta,
      );
      return {
        kind: "explore",
        message: res.message,
        added: res.added_units,
        demonstratedCruxes: res.demonstrated_cruxes,
        failed: Boolean(res.failed),
      };
    }

    const r = opts.unitRep;
    if (!r) return null;

    if (cleanPrior.length === 0) {
      const res = await checkDrill(
        {
          ...(opts.attemptId ? { attempt_id: opts.attemptId } : {}),
          unit_id: r.unit_id,
          depth: r.depth,
          prompt: r.prompt,
          attempt: opts.payloadText,
          sketch_data_url: opts.sketch,
          latency_ms: opts.latencyMs,
          hints_used: 0,
        },
        opts.signal,
        opts.onDelta,
      );
      return { kind: "drill", res };
    }

    const first = cleanPrior[0]!;
    const middleTurns: { role: "user" | "assistant"; text: string }[] = [];
    for (const b of cleanPrior.slice(1)) {
      const u = beatUserPayload(b);
      if (u) middleTurns.push({ role: "user", text: u });
      if (b.coach) middleTurns.push({ role: "assistant", text: b.coach });
    }
    const res = await askDrillFollowUp(
      {
        ...(opts.attemptId ? { attempt_id: opts.attemptId } : {}),
        unit_id: r.unit_id,
        depth: r.depth,
        prompt: r.prompt,
        attempt: beatUserPayload(first),
        feedback: first.coach,
        turns: middleTurns,
        question: opts.payloadText,
        sketch_data_url: opts.sketch,
        latency_ms: opts.latencyMs,
        hints_used: cleanPrior.length,
      },
      opts.signal,
      opts.onDelta,
    );
    return { kind: "drill", res };
  };

  const submitBeat = async (overrideText?: string) => {
    const hasOverride = typeof overrideText === "string" && overrideText.trim().length > 0;
    if (!hasOverride && !canSubmit()) return;
    if (hasOverride && (busy() || (!isNonUnit() && passedVerdict()?.ok))) return;
    const ownerKey = sessionKey();
    const isFreshExplore = isExplore();
    const savedExp = activeExploration();
    const modeExplore = isExploreMode();
    const frontier = activeFrontier();
    const unitRep = rep();
    const prevDraft = draft().trim();
    const text = hasOverride ? overrideText.trim() : prevDraft;
    const activeQ = activeExploreQuestion();
    const qAns = hasOverride ? "" : questionReply().trim();
    const rawCitations = snapshot(citations());
    const pendingCitations: Citation[] =
      activeQ && qAns
        ? [{ id: uuidv7(), text: activeQ, comment: qAns }, ...rawCitations]
        : rawCitations;
    const payloadText = formatCitedMessage(pendingCitations, text);
    const sketch = exportSketch();
    const priorBeats = snapshot(beats());
    const latencyMs = !modeExplore && !frontier ? currentActiveLatencyMs() : null;
    const attemptId = !modeExplore && !frontier && unitRep ? ensureAttemptId(ownerKey) : undefined;
    pauseActivity();

    const ctrl = new AbortController();
    activeAbort = ctrl;
    setCitePill(null);
    setCiteEditor(null);
    setQuestionReply("");
    setBusy(true);
    setError(null);

    const pendingId = uuidv7();
    const pendingBeat: Beat = {
      user: text,
      ...(pendingCitations.length > 0 ? { citations: pendingCitations } : {}),
      sketch,
      coach: "",
      pending: true,
      pendingId,
    };
    if (isFreshExplore) {
      practice.updateExplore((d) => {
        d.beats.push(pendingBeat);
        d.draft = "";
        d.citations = [];
      });
    } else {
      practice.updateUnitSession(ownerKey, (d) => {
        if (latencyMs !== null) d.activeMs = latencyMs;
        d.beats.push(pendingBeat);
        d.draft = "";
        d.citations = [];
      });
    }
    clearSketch();
    requestAnimationFrame(() => {
      autoGrow();
      scrollPadIntoView();
    });

    const onDelta = (partial: string) => {
      if (disposed || ctrl.signal.aborted) return;
      updateBeatsFor(ownerKey, (list) => {
        const target = list.find((b) => b.pending && b.pendingId === pendingId);
        if (target) target.coach = partial;
      });
    };

    try {
      const out = await executeBeatRequest({
        modeExplore,
        explorationId: savedExp?.id ?? null,
        frontier,
        unitRep,
        attemptId,
        latencyMs,
        priorBeats,
        payloadText,
        sketch,
        signal: ctrl.signal,
        onDelta,
      });
      if (!out || disposed || ctrl.signal.aborted) {
        updateBeatsFor(ownerKey, (list) => {
          const idx = list.findIndex((b) => b.pending && b.pendingId === pendingId);
          if (idx >= 0) list.splice(idx, 1);
        });
        if (!disposed) {
          setDraftFor(ownerKey, hasOverride ? prevDraft : text);
          if (qAns) setQuestionReply(qAns);
          if (rawCitations.length > 0) {
            updateCitationsFor(ownerKey, (list) => {
              if (list.length === 0) list.push(...rawCitations);
            });
          }
        }
        return;
      }

      if (out.kind === "explore" && out.frontier) {
        practice.resetExplore();
        practice.addFrontier(out.frontier);
        return;
      }

      if (out.kind === "drill" && out.res.ok) {
        const curBeats = snapshot(practice.state.sessions[ownerKey]?.beats ?? []);
        const idx = curBeats.findIndex((b) => b.pending && b.pendingId === pendingId);
        triggerComplete(ownerKey, out.res, text, pendingCitations, sketch, idx >= 0 ? idx : undefined);
        return;
      }

      const message = out.kind === "drill" ? out.res.message : out.message;
      const question = out.kind === "explore" ? out.question : undefined;
      const annotations = out.kind === "drill" ? out.res.annotations : undefined;
      const added = out.kind === "drill" ? out.res.added_units : out.added;
      const failed = out.kind === "drill" ? Boolean(out.res.failed) : out.failed;

      const settled: Beat = {
        user: text,
        ...(pendingCitations.length > 0 ? { citations: pendingCitations } : {}),
        sketch,
        coach: message,
        ...(question ? { question } : {}),
        ...(annotations && annotations.length > 0 ? { annotations } : {}),
        ...(added && added.length > 0 ? { added } : {}),
        ...(failed ? { failed: true } : {}),
      };
      if (out.kind === "explore" && out.exploration && isFreshExplore && !failed) {
        practice.promoteExploreToSaved(out.exploration, settled);
      } else {
        updateBeatsFor(ownerKey, (list) => {
          const idx = list.findIndex((b) => b.pending && b.pendingId === pendingId);
          if (idx >= 0) list[idx] = settled;
          else list.push(settled);
        });
      }
      if (out.kind === "explore" && frontier && out.demonstratedCruxes) {
        practice.updateFrontierDemonstrated(frontier.id, out.demonstratedCruxes);
      }
      if (added && added.length > 0) void practice.refreshQueue({ preserveOrder: true });
      requestAnimationFrame(() => {
        autoGrow();
        scrollPadIntoView();
      });
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      if (aborted) {
        updateBeatsFor(ownerKey, (list) => {
          const idx = list.findIndex((b) => b.pending && b.pendingId === pendingId);
          if (idx >= 0) list.splice(idx, 1);
        });
        if (!disposed) {
          setDraftFor(ownerKey, hasOverride ? prevDraft : text);
          if (qAns) setQuestionReply(qAns);
          if (rawCitations.length > 0) {
            updateCitationsFor(ownerKey, (list) => {
              if (list.length === 0) list.push(...rawCitations);
            });
          }
        }
        return;
      }
      // Park the submission as a retryable failed beat so the learner never loses or re-types their work.
      const failedBeat: Beat = {
        user: text,
        ...(pendingCitations.length > 0 ? { citations: pendingCitations } : {}),
        sketch,
        coach: e instanceof Error ? e.message : "Could not check that reply just now.",
        failed: true,
      };
      updateBeatsFor(ownerKey, (list) => {
        const idx = list.findIndex((b) => b.pending && b.pendingId === pendingId);
        if (idx >= 0) list[idx] = failedBeat;
        else list.push(failedBeat);
      });
      requestAnimationFrame(() => {
        autoGrow();
        scrollPadIntoView();
      });
    } finally {
      if (activeAbort === ctrl) {
        activeAbort = null;
        if (!disposed) setBusy(false);
      }
    }
  };

  const retryBeat = async (beatIdx: number) => {
    if (busy()) return;
    const ownerKey = sessionKey();
    const modeExplore = isExploreMode();
    const savedExp = activeExploration();
    const frontier = activeFrontier();
    const unitRep = rep();
    const allBeats = snapshot(beats());
    const target = allBeats[beatIdx];
    if (!target || target.pending) return;

    const priorBeats = allBeats.slice(0, beatIdx);
    const pendingCitations = target.citations ?? [];
    const testMe = Boolean(frontier && target.user === "Test me" && pendingCitations.length === 0 && !target.sketch);
    const payloadText = testMe ? "Test me on the core ideas." : formatCitedMessage(pendingCitations, target.user);
    const prevMsg = target.coach || "Could not check that reply just now.";
    const latencyMs = !modeExplore && !frontier ? currentActiveLatencyMs() : null;
    const attemptId = !modeExplore && !frontier && unitRep ? ensureAttemptId(ownerKey) : undefined;
    pauseActivity();

    const pendingId = uuidv7();
    const ctrl = new AbortController();
    activeAbort = ctrl;
    setBusy(true);
    setError(null);

    updateBeatsFor(ownerKey, (list) => {
      if (list[beatIdx]) {
        list[beatIdx] = { ...target, pending: true, pendingId, failed: false, coach: "" };
      }
    });

    const onDelta = (partial: string) => {
      if (disposed || ctrl.signal.aborted) return;
      updateBeatsFor(ownerKey, (list) => {
        const item = list[beatIdx];
        if (item?.pending && item.pendingId === pendingId) item.coach = partial;
      });
    };

    try {
      const out = await executeBeatRequest({
        modeExplore,
        explorationId: savedExp?.id ?? null,
        frontier,
        unitRep,
        attemptId,
        latencyMs,
        priorBeats,
        payloadText,
        sketch: target.sketch ?? null,
        testMe,
        signal: ctrl.signal,
        onDelta,
      });
      if (!out || disposed || ctrl.signal.aborted) {
        updateBeatsFor(ownerKey, (list) => {
          if (list[beatIdx]?.pending) list[beatIdx] = { ...target, pending: false, failed: true, coach: prevMsg };
        });
        return;
      }

      if (out.kind === "explore" && out.frontier) {
        practice.resetExplore();
        practice.addFrontier(out.frontier);
        return;
      }

      if (out.kind === "drill" && out.res.ok) {
        triggerComplete(ownerKey, out.res, target.user, pendingCitations, target.sketch ?? null, beatIdx);
        return;
      }

      const message = out.kind === "drill" ? out.res.message : out.message;
      const question = out.kind === "explore" ? out.question : undefined;
      const annotations = out.kind === "drill" ? out.res.annotations : undefined;
      const added = out.kind === "drill" ? out.res.added_units : out.added;
      const failed = out.kind === "drill" ? Boolean(out.res.failed) : out.failed;

      updateBeatsFor(ownerKey, (list) => {
        if (list[beatIdx]) {
          list[beatIdx] = {
            user: target.user,
            ...(pendingCitations.length > 0 ? { citations: pendingCitations } : {}),
            ...(target.sketch ? { sketch: target.sketch } : {}),
            coach: message,
            ...(question ? { question } : {}),
            ...(annotations && annotations.length > 0 ? { annotations } : {}),
            ...(added && added.length > 0 ? { added } : {}),
            ...(failed ? { failed: true } : {}),
          };
        }
      });
      if (out.kind === "explore" && frontier && out.demonstratedCruxes) {
        practice.updateFrontierDemonstrated(frontier.id, out.demonstratedCruxes);
      }
      if (added && added.length > 0) void practice.refreshQueue({ preserveOrder: true });
      requestAnimationFrame(() => {
        autoGrow();
        scrollPadIntoView();
      });
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      updateBeatsFor(ownerKey, (list) => {
        if (list[beatIdx]?.pending) {
          list[beatIdx] = {
            ...target,
            pending: false,
            failed: true,
            coach: aborted ? prevMsg : e instanceof Error ? e.message : "Could not check that reply just now.",
          };
        }
      });
    } finally {
      if (activeAbort === ctrl) {
        activeAbort = null;
        if (!disposed) setBusy(false);
      }
    }
  };

  const autoGrowEdit = () => {
    if (!editTextarea) return;
    editTextarea.style.height = "auto";
    editTextarea.style.height = `${Math.min(420, Math.max(88, editTextarea.scrollHeight))}px`;
  };

  /** Replaces textarea value via undoable browser edit command so ⌘Z restores the raw draft. */
  const replaceTextareaUndoably = (el: HTMLTextAreaElement | undefined, next: string, sync: (val: string) => void) => {
    if (el) {
      el.focus();
      el.select();
      const ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, next);
      if (!ok) {
        el.value = next;
        el.setSelectionRange(next.length, next.length);
      }
    }
    sync(next);
  };

  const tidyPadText = async (mode: "main" | "edit") => {
    if (tidying() || busy()) return;
    const ownerKey = sessionKey();
    const raw = mode === "edit" ? editDraft() : draft();
    if (!raw.trim()) return;
    setTidying(true);
    setError(null);
    try {
      const res = await tidyDraft(raw);
      if (disposed) return;
      if (mode === "edit") {
        if (editingBeatIdx() === null || editDraft() !== raw) return;
        if (res.changed) {
          replaceTextareaUndoably(editTextarea, res.text, (v) => {
            setEditDraft(v);
            autoGrowEdit();
          });
        }
      } else {
        if (sessionKey() !== ownerKey || draft() !== raw) return;
        if (res.changed) {
          replaceTextareaUndoably(textarea, res.text, (v) => {
            setDraftFor(ownerKey, v);
            autoGrow();
          });
        }
      }
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : "Could not tidy draft.");
    } finally {
      if (!disposed) setTidying(false);
    }
  };

  let editBackdrop: HTMLDivElement | undefined;

  const syncEditBackdropScroll = () => {
    if (editBackdrop && editTextarea) {
      editBackdrop.scrollTop = editTextarea.scrollTop;
    }
  };

  const focusEditAnnotation = (quote: string) => {
    if (!editTextarea) return;
    const hit = locateAnnotation(editTextarea.value, quote);
    editTextarea.focus();
    if (hit) {
      editTextarea.setSelectionRange(hit.start, hit.end);
      syncEditBackdropScroll();
    }
  };

  const startEditingBeat = (beatIdx: number) => {
    if (busy() || isNonUnit() || passedVerdict()?.ok) return;
    const target = snapshot(beats())[beatIdx];
    if (!target || target.pending || isFailedBeat(target) || !target.user.trim()) return;
    setCitePill(null);
    setCiteEditor(null);
    setEditDraft(target.user);
    setEditingBeatIdx(beatIdx);
    const firstAction =
      target.annotations?.find((a) => a.kind === "slip") ??
      target.annotations?.find((a) => a.kind === "question");
    const initialHit = firstAction ? locateAnnotation(target.user, firstAction.quote) : null;
    requestAnimationFrame(() => {
      autoGrowEdit();
      if (editTextarea) {
        editTextarea.focus();
        if (initialHit) {
          editTextarea.setSelectionRange(initialHit.start, initialHit.end);
        } else {
          const len = editTextarea.value.length;
          editTextarea.setSelectionRange(len, len);
        }
        syncEditBackdropScroll();
      }
    });
  };

  const cancelEditingBeat = () => {
    setEditingBeatIdx(null);
    setEditDraft("");
  };

  const submitEditedBeat = async (beatIdx: number) => {
    if (busy()) return;
    const r = rep();
    const ownerKey = sessionKey();
    const edited = editDraft().trim();
    if (!r || !edited) return;

    const allBeats = snapshot(beats());
    const target = allBeats[beatIdx];
    if (!target) return;

    const cleanAll = allBeats.filter((b) => !b.pending && !isFailedBeat(b));
    const first = cleanAll[0] ?? target;
    const middleTurns: { role: "user" | "assistant"; text: string }[] = [];
    for (const b of cleanAll.slice(1)) {
      const u = beatUserPayload(b);
      if (u) middleTurns.push({ role: "user", text: u });
      if (b.coach) middleTurns.push({ role: "assistant", text: b.coach });
    }

    const latencyMs = currentActiveLatencyMs();
    const attemptId = ensureAttemptId(ownerKey);
    pauseActivity();

    const pendingId = uuidv7();
    const ctrl = new AbortController();
    activeAbort = ctrl;
    setEditingBeatIdx(null);
    setEditDraft("");
    setBusy(true);
    setError(null);

    practice.updateUnitSession(ownerKey, (d) => {
      if (latencyMs !== null) d.activeMs = latencyMs;
      if (d.beats[beatIdx]) {
        d.beats[beatIdx] = {
          user: edited,
          ...(target.citations && target.citations.length > 0 ? { citations: target.citations } : {}),
          ...(target.sketch ? { sketch: target.sketch } : {}),
          coach: "",
          pending: true,
          pendingId,
        };
      }
    });

    try {
      const res = await askDrillFollowUp(
        {
          attempt_id: attemptId,
          unit_id: r.unit_id,
          depth: r.depth,
          prompt: r.prompt,
          attempt: beatUserPayload(first),
          feedback: first.coach,
          turns: middleTurns,
          question: edited,
          revised_attempt: true,
          sketch_data_url: target.sketch ?? null,
          latency_ms: latencyMs,
          hints_used: Math.max(1, cleanAll.length),
        },
        ctrl.signal,
        (partial) => {
          if (disposed || ctrl.signal.aborted) return;
          practice.updateUnitSession(ownerKey, (d) => {
            const item = d.beats[beatIdx];
            if (item?.pending && item.pendingId === pendingId) item.coach = partial;
          });
        },
      );

      if (disposed || ctrl.signal.aborted) {
        practice.updateUnitSession(ownerKey, (d) => {
          if (d.beats[beatIdx]?.pending) d.beats[beatIdx] = target;
        });
        if (!disposed) {
          setEditDraft(edited);
          setEditingBeatIdx(beatIdx);
        }
        return;
      }

      if (res.ok) {
        triggerComplete(ownerKey, res, edited, target.citations ?? [], target.sketch ?? null, beatIdx);
        return;
      }

      practice.updateUnitSession(ownerKey, (d) => {
        if (d.beats[beatIdx]) {
          d.beats[beatIdx] = {
            user: edited,
            ...(target.citations && target.citations.length > 0 ? { citations: target.citations } : {}),
            ...(target.sketch ? { sketch: target.sketch } : {}),
            coach: res.message,
            ...(res.annotations && res.annotations.length > 0 ? { annotations: res.annotations } : {}),
            ...(res.added_units && res.added_units.length > 0 ? { added: res.added_units } : {}),
            ...(res.failed ? { failed: true } : {}),
          };
        }
      });
      if (res.added_units && res.added_units.length > 0) void practice.refreshQueue({ preserveOrder: true });
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      practice.updateUnitSession(ownerKey, (d) => {
        if (d.beats[beatIdx]?.pending) {
          if (aborted) {
            d.beats[beatIdx] = target;
          } else {
            d.beats[beatIdx] = {
              user: edited,
              ...(target.citations && target.citations.length > 0 ? { citations: target.citations } : {}),
              ...(target.sketch ? { sketch: target.sketch } : {}),
              coach: e instanceof Error ? e.message : "Could not check that reply just now.",
              failed: true,
            };
          }
        }
      });
      if (aborted && !disposed) {
        setEditDraft(edited);
        setEditingBeatIdx(beatIdx);
      }
    } finally {
      if (activeAbort === ctrl) {
        activeAbort = null;
        if (!disposed) setBusy(false);
      }
    }
  };

  const startTestMe = async () => {
    const frontier = activeFrontier();
    if (!frontier || busy()) return;
    const ownerKey = sessionKey();
    const priorBeats = snapshot(beats()).filter((b) => !b.pending && !isFailedBeat(b));
    const priorTurns: { role: "user" | "assistant"; text: string }[] = [];
    for (const b of priorBeats) {
      const u = beatUserPayload(b);
      if (u) priorTurns.push({ role: "user", text: u });
      if (b.coach) priorTurns.push({ role: "assistant", text: b.coach });
    }
    const pendingId = uuidv7();
    const ctrl = new AbortController();
    activeAbort = ctrl;
    setCitePill(null);
    setCiteEditor(null);
    setBusy(true);
    setError(null);

    practice.updateUnitSession(ownerKey, (d) => {
      d.beats.push({ user: "Test me", coach: "", pending: true, pendingId });
    });
    requestAnimationFrame(() => scrollPadIntoView());

    try {
      const res = await respondFrontier(
        frontier.id,
        { turns: priorTurns, reply: "Test me on the core ideas.", test_me: true },
        ctrl.signal,
        (partial) => {
          if (disposed || ctrl.signal.aborted) return;
          practice.updateUnitSession(ownerKey, (d) => {
            const b = d.beats.find((x) => x.pending && x.pendingId === pendingId);
            if (b) b.coach = partial;
          });
        },
      );
      if (disposed || ctrl.signal.aborted) {
        practice.updateUnitSession(ownerKey, (d) => {
          const idx = d.beats.findIndex((x) => x.pending && x.pendingId === pendingId);
          if (idx >= 0) d.beats.splice(idx, 1);
        });
        return;
      }
      practice.updateUnitSession(ownerKey, (d) => {
        const idx = d.beats.findIndex((x) => x.pending && x.pendingId === pendingId);
        const settled: Beat = {
          user: "Test me",
          coach: res.message,
          added: res.added_units,
          ...(res.failed ? { failed: true } : {}),
        };
        if (idx >= 0) d.beats[idx] = settled;
        else d.beats.push(settled);
      });
      if (res.demonstrated_cruxes) {
        practice.updateFrontierDemonstrated(frontier.id, res.demonstrated_cruxes);
      }
      if (res.added_units.length > 0) void practice.refreshQueue({ preserveOrder: true });
      requestAnimationFrame(() => {
        autoGrow();
        scrollPadIntoView();
      });
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      practice.updateUnitSession(ownerKey, (d) => {
        const idx = d.beats.findIndex((x) => x.pending && x.pendingId === pendingId);
        if (aborted) {
          if (idx >= 0) d.beats.splice(idx, 1);
        } else {
          const failedBeat: Beat = {
            user: "Test me",
            coach: e instanceof Error ? e.message : "Could not start test right now.",
            failed: true,
          };
          if (idx >= 0) d.beats[idx] = failedBeat;
          else d.beats.push(failedBeat);
        }
      });
    } finally {
      if (activeAbort === ctrl) {
        activeAbort = null;
        if (!disposed) setBusy(false);
      }
    }
  };

  const sendPostFollowUp = async (retryIdx?: number) => {
    const r = rep();
    const ownerKey = sessionKey();
    if (!r || postBusy()) return;

    const allPost = snapshot(postBeats());
    const retryTarget = typeof retryIdx === "number" ? allPost[retryIdx] : undefined;
    const q = retryTarget ? retryTarget.user : postInput().trim();
    const pendingCitations = retryTarget ? (retryTarget.citations ?? []) : snapshot(citations());
    const payloadText = formatCitedMessage(pendingCitations, q);
    if (!payloadText) return;

    const priorPost = typeof retryIdx === "number" ? allPost.slice(0, retryIdx) : allPost;
    const priorTurns: { role: "user" | "assistant"; text: string }[] = [];
    for (const b of [...snapshot(beats()), ...priorPost]) {
      if (b.pending || isFailedBeat(b)) continue;
      const u = beatUserPayload(b);
      if (u) priorTurns.push({ role: "user", text: u });
      const coachFull = b.question ? `${b.coach}\n\n${b.question}` : b.coach;
      if (coachFull) priorTurns.push({ role: "assistant", text: coachFull });
    }

    const pendingId = uuidv7();
    const ctrl = new AbortController();
    postAbort = ctrl;
    setCitePill(null);
    setCiteEditor(null);
    setPostBusy(true);
    setError(null);

    practice.updateUnitSession(ownerKey, (d) => {
      const pendingBeat: Beat = {
        user: q,
        ...(pendingCitations.length > 0 ? { citations: pendingCitations } : {}),
        coach: "",
        pending: true,
        pendingId,
      };
      if (typeof retryIdx === "number" && retryIdx >= 0 && retryIdx < d.postBeats.length) {
        d.postBeats[retryIdx] = pendingBeat;
      } else {
        d.postInput = "";
        d.citations = [];
        d.postBeats.push(pendingBeat);
      }
    });
    requestAnimationFrame(() => postInputEl?.scrollIntoView({ block: "nearest", behavior: "smooth" }));

    const cleanPriorPost = priorPost.filter((b) => !b.pending && !isFailedBeat(b));

    const vNow = passedVerdict();
    try {
      const res = await exploreDrill(
        {
          initial: `Completed practice on: ${r.prompt} (Unit: ${r.text})`,
          turns: priorTurns,
          reply: payloadText,
          promote_on_unit: true,
          origin_prompt: r.prompt,
          prior_post_turns: cleanPriorPost.map((b) => ({
            user: beatUserPayload(b),
            coach: b.coach,
            ...(b.question ? { question: b.question } : {}),
            ...(b.added && b.added.length > 0 ? { added: b.added } : {}),
          })),
          rep_context: {
            unit_id: r.unit_id,
            depth: r.depth,
            prompt: r.prompt,
            probe_id: vNow?.probe_id ?? null,
            grade: vNow?.grade ?? "good",
          },
        },
        ctrl.signal,
        (partial) => {
          if (disposed || ctrl.signal.aborted) return;
          practice.updateUnitSession(ownerKey, (d) => {
            const b = d.postBeats.find((x) => x.pending && x.pendingId === pendingId);
            if (b) b.coach = partial;
          });
        },
      );
      if (disposed || ctrl.signal.aborted) return;
      const fix = res.rep_fix_applied;
      const coachMessage =
        fix && fix.changes.length > 0
          ? `${res.message}\n\n**Applied:** ${fix.changes.join(" · ")}`
          : res.message;
      const resolved: Beat = {
        user: q,
        ...(pendingCitations.length > 0 ? { citations: pendingCitations } : {}),
        coach: coachMessage,
        ...(res.question ? { question: res.question } : {}),
        ...(res.added_units.length > 0 ? { added: res.added_units } : {}),
        ...(res.failed ? { failed: true } : {}),
      };
      if (fix) {
        practice.updateUnitSession(ownerKey, (d) => {
          if (d.passedVerdict) {
            if (fix.grade) d.passedVerdict.grade = fix.grade;
            if (fix.next_in_ms !== undefined && fix.next_in_ms !== null) {
              d.passedVerdict.next_in_ms = fix.next_in_ms;
            }
          }
          if (fix.reworded_unit && d.rep) {
            d.rep.text = fix.reworded_unit;
          }
        });
      }
      if (res.exploration && !res.failed && res.added_units.length > 0) {
        // Auto-promote into a full saved Exploration the moment a follow-up adds a unit to the map.
        const promotedBeats: Beat[] = [...cleanPriorPost, resolved];
        if (promotedBeats[0]) {
          const first = promotedBeats[0];
          const originCite: Citation = { id: `origin:${r.unit_id}`, text: r.prompt, comment: "" };
          const hasOrigin = (first.citations ?? []).some((c) => c.text.trim() === r.prompt.trim());
          if (!hasOrigin) {
            promotedBeats[0] = { ...first, citations: [originCite, ...(first.citations ?? [])] };
          }
        }
        practice.promotePostFollowUpToExploration(ownerKey, res.exploration, promotedBeats);
        void practice.refreshQueue({ preserveOrder: true });
        requestAnimationFrame(() => {
          autoGrow();
          scrollPadIntoView();
          textarea?.focus();
        });
        return;
      }
      practice.updateUnitSession(ownerKey, (d) => {
        const idx = d.postBeats.findIndex((b) => b.pending && b.pendingId === pendingId);
        if (idx >= 0) d.postBeats[idx] = resolved;
        else d.postBeats.push(resolved);
      });
      if (res.added_units.length > 0 || (fix && fix.changes.length > 0)) {
        void practice.refreshQueue({ preserveOrder: true });
      }
      if (practice.stageKey() === ownerKey) {
        requestAnimationFrame(() => {
          postInputEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
          postInputEl?.focus();
        });
      }
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
      practice.updateUnitSession(ownerKey, (d) => {
        const idx = d.postBeats.findIndex((b) => b.pending && b.pendingId === pendingId);
        if (aborted && typeof retryIdx !== "number") {
          if (idx >= 0) d.postBeats.splice(idx, 1);
          if (!d.postInput) d.postInput = q;
          if (d.citations.length === 0 && pendingCitations.length > 0) d.citations.push(...pendingCitations);
        } else if (idx >= 0) {
          d.postBeats[idx] = {
            user: q,
            ...(pendingCitations.length > 0 ? { citations: pendingCitations } : {}),
            coach: aborted ? (retryTarget?.coach || "Could not answer follow-up.") : e instanceof Error ? e.message : "Could not answer follow-up.",
            failed: true,
          };
        }
      });
      if (!disposed && practice.stageKey() === ownerKey) {
        requestAnimationFrame(() => postInputEl?.focus());
      }
    } finally {
      if (postAbort === ctrl) {
        postAbort = null;
        if (!disposed) setPostBusy(false);
      }
    }
  };

  const submitPostFollowUp = (ev: SubmitEvent) => {
    ev.preventDefault();
    void sendPostFollowUp();
  };

  const openPostAsExploration = async () => {
    const r = rep();
    const ownerKey = sessionKey();
    if (!r || postBusy()) return;
    const clean = snapshot(postBeats()).filter((b) => !b.pending && !isFailedBeat(b));
    if (clean.length === 0) return;
    const promotedBeats: Beat[] = [...clean];
    const originCite: Citation = { id: `origin:${r.unit_id}`, text: r.prompt, comment: "" };
    if (promotedBeats[0] && !(promotedBeats[0].citations ?? []).some((c) => c.text.trim() === r.prompt.trim())) {
      promotedBeats[0] = { ...promotedBeats[0], citations: [originCite, ...(promotedBeats[0].citations ?? [])] };
    }
    try {
      const saved = await saveExploration({
        turns: promotedBeats.map((b) => ({
          user: beatUserPayload(b),
          coach: b.coach,
          ...(b.question ? { question: b.question } : {}),
          ...(b.added && b.added.length > 0 ? { added: b.added } : {}),
        })),
      });
      if (disposed) return;
      practice.promotePostFollowUpToExploration(ownerKey, saved.exploration, promotedBeats);
      requestAnimationFrame(() => {
        autoGrow();
        scrollPadIntoView();
        textarea?.focus();
      });
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : "Could not open as exploration.");
    }
  };

  const handleUndoAddedUnit = async (u: AddedUnit) => {
    if (practice.state.removedUnits[u.unit_id] || removingId() === u.unit_id) return;
    setRemovingId(u.unit_id);
    try {
      await practice.undoAddedUnit(u.unit_id);
    } finally {
      if (!disposed) setRemovingId(null);
    }
  };

  const bumpInterval = async (grade: Grade) => {
    const r = rep();
    const v = passedVerdict();
    const ownerKey = sessionKey();
    if (!r || !v?.probe_id || overriding()) return;
    setOverriding(true);
    setError(null);
    const noteByGrade: Record<Grade, string> = {
      again: "Learner bumped interval to soon",
      hard: "Learner bumped interval shorter",
      good: "Learner bumped interval to normal",
      easy: "Learner bumped interval much later",
    };
    try {
      const res = await overrideDrillGrade({
        unit_id: r.unit_id,
        probe_id: v.probe_id,
        grade,
        note: noteByGrade[grade],
      });
      if (disposed) return;
      practice.updateUnitSession(ownerKey, (d) => {
        if (d.passedVerdict) {
          d.passedVerdict.grade = res.grade ?? grade;
          d.passedVerdict.next_in_ms = res.next_in_ms;
        }
        d.overridden = true;
      });
      setBumpOpen(false);
      void practice.refreshQueue({ preserveOrder: true });
    } catch (e) {
      if (!disposed) {
        setError(e instanceof Error ? e.message : "Could not update schedule right now.");
      }
    } finally {
      if (!disposed) setOverriding(false);
    }
  };

  const latencyTrace = () => {
    const v = passedVerdict();
    if (!v || !v.ok || v.latency_ms === null) return "";
    const delta = v.prev_latency_ms !== null ? v.prev_latency_ms - v.latency_ms : null;
    const faster = delta !== null && delta >= 2000 ? ` (${fmtDur(delta)} faster)` : "";
    return `${fmtDur(v.latency_ms)}${faster}`;
  };

  const intervalLabel = () => {
    const v = passedVerdict();
    if (!v || !v.ok) return "";
    if (v.grade === "again") {
      return v.next_in_ms !== null && v.next_in_ms > 0 ? `back soon (~${fmtDur(v.next_in_ms)})` : "back soon";
    }
    if (v.next_in_ms !== null && v.next_in_ms > 0) return `next ~${fmtDur(v.next_in_ms)}`;
    return overridden() ? "scheduled" : "";
  };

  const posOf = (e: PointerEvent) => {
    if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const activeExploreQuestion = () => {
    if (!isExploreMode() || busy() || passedVerdict()?.ok || editingBeatIdx() !== null) return null;
    const list = beats();
    const last = list[list.length - 1];
    if (!last || last.pending || isFailedBeat(last) || !last.question?.trim()) return null;
    return last.question.trim();
  };

  const tellMeDirectly = () => {
    if (busy()) return;
    const msg = "Walk me through this directly.";
    // If the learner is already drafting a follow-up in the main pad, queue this under the question
    // so it batches cleanly with their follow-up; otherwise send immediately in 1 click.
    if (draft().trim().length > 0) {
      setQuestionReply(msg);
      requestAnimationFrame(autoGrowQuestion);
      return;
    }
    setQuestionReply(msg);
    void submitBeat();
  };

  const ComposerCitationChips = () => (
    <Show when={citations().length > 0}>
      <div class="v2-cite-chips">
        <For each={citations()} keyed={(c) => c.id}>
          {(c) => (
            <span
              class={{ "v2-cite-chip": true, "is-confused": c().kind === "confused" }}
              data-tip={c().kind === "confused" ? `I don't understand: ${c().text}` : c().text}
            >
              <button
                type="button"
                class="v2-cite-chip-main"
                onClick={(e) => openEditCiteEditor(c(), e.currentTarget)}
              >
                <Show when={c().kind === "confused"} fallback={<QuoteIcon />}>
                  <span class="v2-cite-qmark" aria-hidden="true">???</span>
                </Show>
                <span class="v2-cite-chip-label">{inline(citationLabel(c()))}</span>
                <svg class="v2-cite-chip-edit" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M11.5 2.5l2 2L5.5 12.5H3.5v-2l8-8z" />
                </svg>
              </button>
              <button
                type="button"
                class="v2-cite-chip-remove"
                aria-label="Remove citation"
                onClick={() => removeCitation(c().id)}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                  <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                </svg>
              </button>
            </span>
          )}
        </For>
      </div>
    </Show>
  );

  return (
    <div ref={stageEl} class={{ "v2-drill-stage": true, "is-exiting": exiting() }}>
      <div class="v2-drill-head">
        <div class="v2-pips" aria-label="Up next">
          <For each={railItems()}>
            {(item) => {
              const isCurrent = () => activeUnitId() === item.unit_id;
              const isDone = () => practice.state.justCompletedId === item.unit_id;
              const isPop = () => practice.state.celebratingId === item.unit_id;
              return (
                <button
                  type="button"
                  class={{
                    "v2-pip": true,
                    "is-lit": isDone(),
                    "is-current": isCurrent() && !isPop(),
                    "is-pop": isPop(),
                  }}
                  data-tip={item.text}
                  data-tip-side="bottom"
                  aria-label={item.text}
                  onClick={() => practice.selectUnit(item.unit_id)}
                />
              );
            }}
          </For>
          <button
            type="button"
            class={{ "v2-pip-plus": true, "is-active": isExplore() }}
            data-tip="New exploration"
            data-tip-side="bottom"
            aria-label="New exploration"
            aria-pressed={isExplore() ? "true" : "false"}
            onClick={() => {
              if (isExplore()) {
                resetTransient();
                practice.resetExplore();
                requestAnimationFrame(() => {
                  autoGrow();
                  textarea?.focus();
                });
              } else {
                practice.selectExplore();
              }
            }}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M6 2v8M2 6h8" />
            </svg>
          </button>
        </div>

        <Switch>
          <Match when={activeFrontier()}>
            <span class="v2-meta-whisper">
              briefing
              <Show when={exploreAddedCount() > 0}>
                {" · "}
                {exploreAddedCount()} on map
              </Show>
            </span>
          </Match>
          <Match when={activeExploration() || (isExplore() && exploreAddedCount() > 0)}>
            <span class="v2-meta-whisper">
              exploration
              <Show when={exploreAddedCount() > 0}>
                {" · "}
                {exploreAddedCount()} on map
              </Show>
            </span>
          </Match>
          <Match when={rep()}>
            {(r) => (
              <span class="v2-meta-whisper">
                {r().kind} · {r().depth}
                <Show when={r().reviews > 0}> · P {Math.round(r().p_imm * 100)}%</Show>
              </span>
            )}
          </Match>
        </Switch>
      </div>

      <Show when={!loading()} fallback={<div class="v2-loading-dots"><span /><span /><span /></div>}>
        <div class="v2-prompt-wrap">
          <Switch fallback={<h1 class="v2-prompt v2-prompt--open">What do you want to work through?</h1>}>
            <Match when={activeExploration()}>
              {(e) => (
                <h1 class="v2-prompt" data-citable="true">
                  {inline(e().title)}
                </h1>
              )}
            </Match>
            <Match when={activeFrontier()}>
              {(f) => (
                <div class="v2-briefing-head">
                  <h1 class="v2-prompt" data-citable="true">
                    {inline(f().title)}
                  </h1>
                  <Show when={f().skipped_known.length > 0}>
                    <div class="v2-briefing-skipped">
                      Skipping known: {f().skipped_known.join(" · ")}
                    </div>
                  </Show>
                  <div class="v2-briefing-body" data-citable="true">
                    <Body text={f().body} />
                  </div>
                  <div class="v2-briefing-bar">
                    <span class="v2-briefing-hint">Highlight any phrase or formula to cite &amp; unpack</span>
                    <Show when={f().cruxes.length > 0}>
                      <button
                        type="button"
                        class="v2-pill-btn"
                        disabled={busy()}
                        onClick={() => void startTestMe()}
                      >
                        Test me
                        <Show when={(f().demonstrated_cruxes?.length ?? 0) > 0}>
                          {" · "}
                          {f().demonstrated_cruxes!.length}/{f().cruxes.length}
                        </Show>
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </Match>
            <Match when={rep()}>
              {(r) => (
                <h1 class="v2-prompt" data-citable="true">
                  {inline(r().prompt)}
                </h1>
              )}
            </Match>
          </Switch>
        </div>

        {/* Progressive Solveit-style committed beats */}
        <Show when={beats().length > 0}>
          <div class="v2-beats">
            <For each={beats()}>
              {(beat, idx) => {
                const isFinalPass = () => Boolean(passedVerdict()?.ok) && idx() === beats().length - 1;
                const failed = () => isFailedBeat(beat);
                const isEditing = () => editingBeatIdx() === idx();
                const canEdit = () =>
                  !isNonUnit() &&
                  !passedVerdict()?.ok &&
                  !beat.pending &&
                  !failed() &&
                  beat.user.trim().length > 0;
                const annoSummary = createMemo(() => {
                  if (!beat.user || !beat.annotations || beat.annotations.length === 0) {
                    return { matchedCount: 0, hasActionPin: false };
                  }
                  const { matchedCount } = buildAnnotatedLines(beat.user, beat.annotations);
                  const hasActionPin = beat.annotations.some((a) => a.kind === "slip" || a.kind === "question");
                  return { matchedCount, hasActionPin };
                });
                const hideRedundantCoach = () =>
                  !isFinalPass() &&
                  !beat.pending &&
                  !failed() &&
                  annoSummary().matchedCount > 0 &&
                  (!beat.added || beat.added.length === 0) &&
                  isCoachMessageRedundant(beat.coach, beat.annotations ?? []);

                return (
                  <div class={{ "v2-beat": true, "is-passed": isFinalPass(), "is-editing": isEditing() }}>
                    <Show
                      when={!isEditing()}
                      fallback={
                        <div class="v2-inline-edit v2-textured">
                          <div class="v2-edit-area">
                            <Show when={beat.annotations && beat.annotations.some((a) => a.kind !== "move")}>
                              <div ref={editBackdrop} class="v2-edit-backdrop" aria-hidden="true">
                                <For each={buildEditHighlightSegments(editDraft(), beat.annotations ?? [])}>
                                  {(seg) =>
                                    seg.kind ? (
                                      <mark class={{ "v2-edit-mark": true, [`is-${seg.kind}`]: true }}>{seg.text}</mark>
                                    ) : (
                                      seg.text
                                    )
                                  }
                                </For>
                                {editDraft().endsWith("\n") ? " " : ""}
                              </div>
                            </Show>
                            <textarea
                              ref={editTextarea}
                              class="v2-pad-input v2-inline-edit-input"
                              spellcheck="false"
                              autocorrect="off"
                              autocapitalize="off"
                              value={editDraft()}
                              onScroll={syncEditBackdropScroll}
                              onInput={(e) => {
                                recordActivity();
                                setEditDraft(e.currentTarget.value);
                                autoGrowEdit();
                                syncEditBackdropScroll();
                              }}
                              onKeyDown={(e) => {
                                if (
                                  handlePadIndentKey(e, (next) => {
                                    recordActivity();
                                    setEditDraft(next);
                                    autoGrowEdit();
                                    syncEditBackdropScroll();
                                  })
                                ) {
                                  return;
                                }
                                if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
                                  e.preventDefault();
                                  void tidyPadText("edit");
                                  return;
                                }
                                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                  e.preventDefault();
                                  void submitEditedBeat(idx());
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelEditingBeat();
                                }
                              }}
                            />
                          </div>
                          <Show when={beat.annotations && beat.annotations.some((a) => a.kind !== "move")}>
                            <div class="v2-edit-pins">
                              <For each={(beat.annotations ?? []).filter((a) => a.kind !== "move")}>
                                {(pin) => {
                                  const resolved = () => isAnnotationEdited(editDraft(), pin.quote);
                                  return (
                                    <div class={{ "v2-edit-pin": true, "is-resolved": resolved() }}>
                                      <button
                                        type="button"
                                        class={{ "v2-edit-pin-quote": true, [`is-${pin.kind}`]: true }}
                                        disabled={resolved()}
                                        data-tip={resolved() ? "Edited" : "Jump to this span"}
                                        onClick={() => focusEditAnnotation(pin.quote)}
                                      >
                                        {pin.quote}
                                      </button>
                                      <span class="v2-edit-pin-note">{inline(pin.note)}</span>
                                      <Show when={resolved()}>
                                        <span class="v2-edit-pin-state">Edited</span>
                                      </Show>
                                    </div>
                                  );
                                }}
                              </For>
                            </div>
                          </Show>
                          <div class="v2-inline-edit-foot">
                            <button type="button" class="v2-ghost-btn" onClick={cancelEditingBeat}>
                              Cancel
                            </button>
                            <Show when={editDraft().trim().length >= 12}>
                              <button
                                type="button"
                                class="v2-btn-secondary"
                                disabled={tidying() || busy()}
                                data-tip="Format & typo tidy (⌘⇧F) · ⌘Z undoes"
                                onClick={() => void tidyPadText("edit")}
                              >
                                <Show
                                  when={tidying()}
                                  fallback={
                                    <>
                                      Tidy <span class="v2-kbd">⌘⇧F</span>
                                    </>
                                  }
                                >
                                  <span class="v2-spinner" aria-hidden="true" />
                                  <span>Tidying</span>
                                </Show>
                              </button>
                            </Show>
                            <button
                              type="button"
                              class="v2-btn-primary"
                              disabled={!editDraft().trim() || busy()}
                              onClick={() => void submitEditedBeat(idx())}
                            >
                              Re-check <span class="v2-kbd">⌘↵</span>
                            </button>
                          </div>
                        </div>
                      }
                    >
                      <Show when={beat.user || beat.sketch || (beat.citations && beat.citations.length > 0)}>
                        <div class={{ "v2-beat-user": true, "has-pins": annoSummary().matchedCount > 0 }} data-citable="true">
                          <Show when={canEdit()}>
                            <button
                              type="button"
                              class={{ "v2-beat-edit-btn": true, "is-suggested": annoSummary().hasActionPin }}
                              data-tip="Edit derivation in place"
                              onClick={() => startEditingBeat(idx())}
                            >
                              Edit
                            </button>
                          </Show>
                          <BeatCitations items={beat.citations} />
                          <Show when={beat.user}>
                            <Show
                              when={annoSummary().matchedCount > 0}
                              fallback={
                                <pre
                                  class="v2-beat-code"
                                  onDblClick={() => {
                                    if (canEdit()) startEditingBeat(idx());
                                  }}
                                >
                                  {mathOnly(beat.user)}
                                </pre>
                              }
                            >
                              <AnnotatedUserWork
                                text={beat.user}
                                annotations={beat.annotations!}
                                canEdit={canEdit()}
                                onEdit={() => startEditingBeat(idx())}
                              />
                            </Show>
                          </Show>
                          <Show when={beat.sketch}>
                            {(img) => <img class="v2-beat-sketch" src={img()} alt="Sketch" />}
                          </Show>
                        </div>
                      </Show>
                    </Show>

                    <Show when={!isEditing() && !hideRedundantCoach()}>
                      <div
                        class={{
                          "v2-beat-coach": true,
                          "is-pass": isFinalPass(),
                          "is-pending": Boolean(beat.pending),
                          "is-failed": failed(),
                        }}
                      >
                        <Switch
                          fallback={
                            <div class="v2-verdict-body" data-citable="true">
                              <Body text={beat.coach} />
                            </div>
                          }
                        >
                          <Match when={beat.pending}>
                            <Show when={beat.coach.trim().length > 0}>
                              <div class="v2-verdict-body" data-citable="true">
                                <Body text={beat.coach} />
                              </div>
                            </Show>
                            <div class={{ "v2-beat-pending": true, "v2-beat-streaming": beat.coach.trim().length > 0 }}>
                              <span class="v2-spinner" aria-hidden="true" />
                              <span>
                                {beat.coach.trim().length > 0
                                  ? "Writing"
                                  : isNonUnit()
                                    ? "Thinking"
                                    : "Checking"}
                              </span>
                              <button type="button" class="v2-pending-cancel" onClick={cancelPending}>
                                Cancel
                              </button>
                            </div>
                          </Match>
                          <Match when={failed()}>
                            <div class="v2-beat-failed">
                              <span class="v2-beat-failed-msg">{failedBeatMessage(beat)}</span>
                              <button
                                type="button"
                                class="v2-retry-btn"
                                disabled={busy()}
                                onClick={() => void retryBeat(idx())}
                              >
                                <RetryIcon />
                                Retry
                              </button>
                            </div>
                          </Match>
                        </Switch>

                        <Show
                          when={
                            beat.question &&
                            !beat.pending &&
                            !failed() &&
                            !(isExploreMode() && idx() === beats().length - 1 && activeExploreQuestion())
                          }
                        >
                          <div class="v2-beat-question-past" data-citable="true">
                            <Body text={beat.question!} />
                          </div>
                        </Show>

                        <AddedUnitsList items={beat.added} removingId={removingId()} onUndo={(u) => void handleUndoAddedUnit(u)} />

                        <Show when={isFinalPass()}>
                          <div class="v2-verdict-foot">
                            <span class="v2-verdict-trace">
                              <Show when={latencyTrace()}>
                                <span>{latencyTrace()}</span>
                                <Show when={intervalLabel()}>
                                  <span aria-hidden="true"> · </span>
                                </Show>
                              </Show>
                              <Show when={intervalLabel()}>
                                <Show
                                  when={passedVerdict()?.probe_id}
                                  fallback={<span>{intervalLabel()}</span>}
                                >
                                  <button
                                    type="button"
                                    class={{ "v2-interval-btn": true, "is-open": bumpOpen() }}
                                    disabled={overriding()}
                                    data-tip="Adjust when this comes back"
                                    aria-expanded={bumpOpen() ? "true" : "false"}
                                    onClick={() => setBumpOpen((v) => !v)}
                                  >
                                    <span>{overriding() ? "updating…" : intervalLabel()}</span>
                                    <span class="v2-interval-caret" aria-hidden="true">▾</span>
                                  </button>
                                </Show>
                              </Show>
                            </span>
                            <div class="v2-pass-actions">
                              <button type="button" class="v2-btn-primary is-passed" onClick={transitionToNext}>
                                <svg class="v2-check-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                  <path d="M3.2 8.4l3.2 3.2 6.4-7" />
                                </svg>
                                Next <span class="v2-kbd">⌘↵</span>
                              </button>
                            </div>
                          </div>
                          <Show when={bumpOpen() && passedVerdict()?.probe_id}>
                            <div class="v2-bump-row" role="group" aria-label="Adjust next review time">
                              <span class="v2-bump-label">Bring back:</span>
                              {(
                                [
                                  ["again", "Soon"],
                                  ["hard", "Shorter"],
                                  ["good", "Normal"],
                                  ["easy", "Much later"],
                                ] as const
                              ).map(([g, label]) => (
                                <button
                                  type="button"
                                  class={{
                                    "v2-bump-chip": true,
                                    "is-active": passedVerdict()?.grade === g,
                                  }}
                                  disabled={overriding()}
                                  onClick={() => void bumpInterval(g)}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </Show>
                        </Show>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        {/* Quiet post-pass curiosity follow-up */}
        <Show when={passedVerdict()?.ok}>
          <Show when={postBeats().length > 0}>
            <div class="v2-beats v2-post-beats">
              <For each={postBeats()}>
                {(beat, idx) => {
                  const failed = () => isFailedBeat(beat);
                  return (
                    <div class="v2-beat">
                      <div class="v2-beat-user" data-citable="true">
                        <BeatCitations items={beat.citations} />
                        <Show when={beat.user}>
                          <pre class="v2-beat-code">{mathOnly(beat.user)}</pre>
                        </Show>
                      </div>
                      <div
                        class={{
                          "v2-beat-coach": true,
                          "is-pending": Boolean(beat.pending),
                          "is-failed": failed(),
                        }}
                      >
                        <Switch
                          fallback={
                            <div class="v2-verdict-body" data-citable="true">
                              <Body text={beat.coach} />
                            </div>
                          }
                        >
                          <Match when={beat.pending}>
                            <Show when={beat.coach.trim().length > 0}>
                              <div class="v2-verdict-body" data-citable="true">
                                <Body text={beat.coach} />
                              </div>
                            </Show>
                            <div class={{ "v2-beat-pending": true, "v2-beat-streaming": beat.coach.trim().length > 0 }}>
                              <span class="v2-spinner" aria-hidden="true" />
                              <span>{beat.coach.trim().length > 0 ? "Writing" : "Thinking"}</span>
                              <button type="button" class="v2-pending-cancel" onClick={cancelPostPending}>
                                Cancel
                              </button>
                            </div>
                          </Match>
                          <Match when={failed()}>
                            <div class="v2-beat-failed">
                              <span class="v2-beat-failed-msg">{beat.coach}</span>
                              <button
                                type="button"
                                class="v2-retry-btn"
                                disabled={postBusy()}
                                onClick={() => void sendPostFollowUp(idx())}
                              >
                                <RetryIcon />
                                Retry
                              </button>
                            </div>
                          </Match>
                        </Switch>
                        <Show when={beat.question && !beat.pending && !failed()}>
                          <div class="v2-beat-question-past" data-citable="true">
                            <Body text={beat.question!} />
                          </div>
                        </Show>
                        <AddedUnitsList items={beat.added} removingId={removingId()} onUndo={(u) => void handleUndoAddedUnit(u)} />
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>

          <div class="v2-post-follow-wrap">
            <ComposerCitationChips />
            <form
              class={{
                "v2-post-follow": true,
                "has-text": postInput().trim().length > 0 || citations().length > 0,
              }}
              onSubmit={submitPostFollowUp}
            >
              <input
                ref={postInputEl}
                type="text"
                class="v2-post-input"
                placeholder="Ask a follow-up…"
                spellcheck="false"
                value={postInput()}
                disabled={postBusy()}
                onInput={(e) => setPostInputFor(sessionKey(), e.currentTarget.value)}
              />
              <Show when={!postBusy() && (postInput().trim().length > 0 || citations().length > 0)}>
                <button type="submit" class="v2-post-send" aria-label="Send follow-up">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M8 12.5V3.5M4 7.5L8 3.5l4 4" />
                  </svg>
                </button>
              </Show>
              <Show when={!postBusy() && postBeats().some((b) => !b.pending && !isFailedBeat(b)) && !postInput().trim()}>
                <button
                  type="button"
                  class="v2-post-promote"
                  data-tip="Continue as a full exploration"
                  onClick={() => void openPostAsExploration()}
                >
                  Open as exploration ↗
                </button>
              </Show>
            </form>
          </div>
        </Show>

        {/* Warm overload nudge once an exploration has accumulated a batch of new units */}
        <Show when={isExploreMode() && exploreAddedCount() >= EXPLORE_WRAP_THRESHOLD && !wrapDismissed() && firstDueForBatch()}>
          {(target) => {
            const batchCount = () => dueFromExplore().length || exploreAddedCount();
            return (
              <div class="v2-wrap-nudge" role="status">
                <div class="v2-wrap-nudge-copy">
                  <span class="v2-wrap-nudge-title">
                    {exploreAddedCount()} new units on your map — drill this batch before adding more.
                  </span>
                  <span class="v2-wrap-nudge-sub">
                    This thread stays saved in the sidebar so you can always come right back to it.
                  </span>
                </div>
                <div class="v2-wrap-nudge-actions">
                  <button
                    type="button"
                    class="v2-wrap-nudge-btn is-primary"
                    onClick={() => practice.selectUnit(target().unit_id)}
                  >
                    Drill these {batchCount()}
                  </button>
                  <button
                    type="button"
                    class="v2-wrap-nudge-dismiss"
                    aria-label="Keep exploring for now"
                    data-tip="Keep exploring for now"
                    onClick={() => setWrapDismissed(true)}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          }}
        </Show>

        {/* Explicit active question card in Explore mode: quiet header + inline batchable answer strip */}
        <Show when={activeExploreQuestion()}>
          {(q) => (
            <div class={{ "v2-explore-q": true, "has-answer": questionReply().trim().length > 0 }}>
              <div class="v2-explore-q-head">
                <span class="v2-explore-q-label">Question</span>
                <div class="v2-explore-q-actions">
                  <Show
                    when={questionReply().trim().length > 0}
                    fallback={
                      <button
                        type="button"
                        class="v2-explore-q-tell"
                        disabled={busy()}
                        data-tip={draft().trim() ? "Queue 'Tell me' with your follow-up" : "Walk me through this directly"}
                        onClick={tellMeDirectly}
                      >
                        Tell me
                      </button>
                    }
                  >
                    <span class="v2-explore-q-queued" data-tip="Sent as an annotation with your reply (⌘↵)">
                      Batched
                    </span>
                    <button
                      type="button"
                      class="v2-explore-q-clear"
                      aria-label="Clear answer"
                      data-tip="Clear answer"
                      onClick={() => {
                        setQuestionReply("");
                        requestAnimationFrame(() => {
                          autoGrowQuestion();
                          questionInputEl?.focus();
                        });
                      }}
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                      </svg>
                    </button>
                  </Show>
                </div>
              </div>
              <div class="v2-explore-q-body" data-citable="true">
                <Body text={q()} />
              </div>
              <div class="v2-explore-q-bar">
                <textarea
                  ref={questionInputEl}
                  rows={1}
                  class="v2-explore-q-input"
                  placeholder="Answer this, or leave blank to skip…"
                  spellcheck="false"
                  autocorrect="off"
                  autocapitalize="off"
                  value={questionReply()}
                  disabled={busy()}
                  onInput={(e) => {
                    setQuestionReply(e.currentTarget.value);
                    autoGrowQuestion();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void submitBeat();
                    } else if (e.key === "Escape" && questionReply().length > 0) {
                      e.preventDefault();
                      setQuestionReply("");
                      requestAnimationFrame(autoGrowQuestion);
                    }
                  }}
                />
              </div>
            </div>
          )}
        </Show>

        {/* The ONE active pad at the bottom (hidden once rep passes or while editing a derivation in place) */}
        <Show when={!passedVerdict()?.ok && editingBeatIdx() === null}>
          <div
            ref={padEl}
            class={{
              "v2-pad": true,
              "v2-textured": true,
              "is-compact": beats().length > 0,
              "is-explore": isExploreMode() || Boolean(activeFrontier()),
              "is-checking": busy(),
            }}
          >
            <ComposerCitationChips />
            <div class={{ "v2-pad-body": true, "with-sketch": sketchOpen() }}>
              <textarea
                ref={textarea}
                class="v2-pad-input"
                placeholder={
                  activeExploreQuestion()
                    ? "Ask a follow-up…"
                    : beats().length > 0
                      ? "Continue, or ask…"
                      : isExploreMode()
                        ? "Drop a question, derivation, paper, file path, or topic to work through…"
                        : activeFrontier()
                          ? "Cite a line above, ask a question, or explain it back…"
                          : "Write your attempt or ask anything…"
                }
                spellcheck="false"
                autocorrect="off"
                autocapitalize="off"
                value={draft()}
                onInput={(e) => {
                  recordActivity();
                  setDraftFor(sessionKey(), e.currentTarget.value);
                  autoGrow();
                }}
                onKeyDown={(e) => {
                  if (
                    handlePadIndentKey(e, (next) => {
                      recordActivity();
                      setDraftFor(sessionKey(), next);
                      autoGrow();
                    })
                  ) {
                    return;
                  }
                  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
                    e.preventDefault();
                    void tidyPadText("main");
                    return;
                  }
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submitBeat();
                  }
                }}
              />

              <div class={{ "v2-sketch-pane": true, "has-ink": hasInk() }}>
                <canvas
                  ref={(el) => bindCanvas(el)}
                  class="v2-sketch-canvas"
                  onPointerDown={(e) => {
                    if (!canvas) return;
                    e.preventDefault();
                    recordActivity();
                    canvas.setPointerCapture(e.pointerId);
                    drawing = true;
                    const p = posOf(e);
                    curStroke = [p];
                    strokes.push(curStroke);
                    const ctx = canvas.getContext("2d");
                    if (ctx) {
                      ctx.strokeStyle = getComputedStyle(canvas).color || "#e5e5e5";
                      ctx.lineCap = "round";
                      ctx.lineJoin = "round";
                      ctx.lineWidth = 2;
                      ctx.beginPath();
                      ctx.moveTo(p.x, p.y);
                    }
                  }}
                  onPointerMove={(e) => {
                    if (!drawing || !curStroke || !canvas) return;
                    recordActivity();
                    const p = posOf(e);
                    curStroke.push(p);
                    const ctx = canvas.getContext("2d");
                    if (ctx) {
                      ctx.lineTo(p.x, p.y);
                      ctx.stroke();
                    }
                    if (!hasInk()) setHasInk(true);
                  }}
                  onPointerUp={() => {
                    drawing = false;
                    curStroke = null;
                  }}
                  onPointerCancel={() => {
                    drawing = false;
                    curStroke = null;
                  }}
                />
                <span class="v2-sketch-hint">Sketch beside your notes</span>
                <button type="button" class="v2-sketch-clear" onClick={clearSketch}>
                  Clear
                </button>
              </div>
            </div>

            <div class="v2-pad-foot">
              <div class="v2-pad-tools">
                <Show when={(isExploreMode() || activeFrontier()) && exploreAddedCount() > 0}>
                  <span class="v2-pad-map-count">{exploreAddedCount()} on map</span>
                </Show>
              </div>

              <div class="v2-pad-actions">
                <Show when={draft().trim().length >= 12}>
                  <button
                    type="button"
                    class="v2-btn-secondary"
                    disabled={tidying() || busy()}
                    data-tip="Format & typo tidy (⌘⇧F) · ⌘Z undoes"
                    onClick={() => void tidyPadText("main")}
                  >
                    <Show
                      when={tidying()}
                      fallback={
                        <>
                          Tidy <span class="v2-kbd">⌘⇧F</span>
                        </>
                      }
                    >
                      <span class="v2-spinner" aria-hidden="true" />
                      <span>Tidying</span>
                    </Show>
                  </button>
                </Show>
                <button
                  type="button"
                  class={{ "v2-btn-primary": true, "is-busy": busy() }}
                  disabled={!busy() && !canSubmit()}
                  data-tip={busy() ? "Click or press Esc to cancel" : undefined}
                  onClick={() => (busy() ? cancelPending() : void submitBeat())}
                >
                  <Show
                    when={busy()}
                    fallback={
                      <>
                        {isExploreMode()
                          ? beats().length > 0
                            ? "Send"
                            : "Explore"
                          : activeFrontier() || beats().length > 0
                            ? "Send"
                            : "Check"}{" "}
                        <span class="v2-kbd">⌘↵</span>
                      </>
                    }
                  >
                    <span class="v2-spinner" aria-hidden="true" />
                    <span class="v2-busy-label">
                      {isNonUnit() ? "Thinking" : "Checking"}
                    </span>
                    <span class="v2-busy-stop">Cancel</span>
                  </Show>
                </button>
              </div>
            </div>
          </div>
        </Show>

        <Show when={error() || practice.state.error}>
          {(msg) => <p class="v2-error-line">{msg()}</p>}
        </Show>
      </Show>

      {/* Floating T3-style selection pill: Cite, ???, or pin to Map */}
      <Show when={citePill()}>
        {(pill) => (
          <div
            class="v2-cite-pill"
            style={{ top: `${pill().top}px`, left: `${pill().left}px` }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              type="button"
              class="v2-cite-pill-btn"
              data-tip="Quote with a note"
              data-tip-side="bottom"
              onClick={openNewCiteEditor}
            >
              <QuoteIcon />
              <span>Cite</span>
            </button>
            <span class="v2-cite-pill-sep" aria-hidden="true" />
            <button
              type="button"
              class="v2-cite-pill-btn is-confused"
              data-tip="I don't understand this"
              data-tip-side="bottom"
              onClick={addConfusedCite}
            >
              <span class="v2-cite-pill-qmark">???</span>
            </button>
            <span class="v2-cite-pill-sep" aria-hidden="true" />
            <button
              type="button"
              class={{ "v2-cite-pill-btn": true, "is-done": pinnedMap() }}
              data-tip="Add to map"
              data-tip-side="bottom"
              disabled={pinningMap()}
              onClick={() => void pinSelectionToMap()}
            >
              <span>{pinnedMap() ? "Added" : pinningMap() ? "…" : "+ Map"}</span>
            </button>
          </div>
        )}
      </Show>

      {/* Floating T3-style citation comment popover */}
      <Show when={citeEditor()}>
        {(ed) => (
          <div
            class="v2-cite-pop"
            role="dialog"
            aria-label="Add citation"
            style={{ top: `${ed().top}px`, left: `${ed().left}px` }}
          >
            <div class="v2-cite-pop-quote">
              <QuoteIcon />
              <span class="v2-cite-pop-quote-text">{inline(ed().text)}</span>
            </div>
            <textarea
              ref={citeTextarea}
              class="v2-cite-pop-input"
              rows={2}
              placeholder="Add a comment or question… (optional)"
              spellcheck="false"
              value={citeComment()}
              onInput={(e) => setCiteComment(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelCitation();
                } else if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.stopPropagation();
                  saveCitation();
                }
              }}
            />
            <div class="v2-cite-pop-actions">
              <button type="button" class="v2-cite-btn-cancel" onClick={cancelCitation}>
                Cancel
              </button>
              <button type="button" class="v2-cite-btn-save" onClick={saveCitation}>
                Save
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
