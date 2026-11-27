// Progressive Solveit-style Practice, Briefing & Exploration stage:
// Always ONE single active pad at the bottom. Reads and writes directly into the account-scoped
// PracticeStore (zero duplicated session signals, zero module-level globals, zero flush races).
import { uuidv7, type Depth } from "@myelin/core";
import { createEffect, createMemo, createSignal, For, Match, onSettled, Show, snapshot, Switch, useContext } from "solid-js";
import {
  buildAnnotatedLines,
  buildEditHighlightSegments,
  isAnnotationEdited,
  isCoachMessageRedundant,
  locateAnnotation,
  type InlineAnnotation,
} from "./annotate.js";
import { assembleFilledStarter, countStarterBlanks, parseStarterBlanks } from "./blanks.js";
import { citationLabel, extractSelectionText, formatCitedMessage, type Citation } from "./cite.js";
import {
  askDrillFollowUp,
  checkDrill,
  createQuickUnit,
  exploreDrill,
  fetchNextDrill,
  rescheduleDrillUnit,
  respondFrontier,
  submitMcqChoice,
  tidyDraft,
  waitExplorationSidecar,
  type AddedUnit,
  type CheckDrillResponse,
  type Frontier,
  type McqOutcome,
} from "./drillApi.js";
import { PracticeContext, sessionHasWork, type Beat, type SittingSlot, type SittingSlotStatus } from "./practiceStore.js";
import { handlePadIndentKey } from "./padKeys.js";
import { SendError } from "./sync.js";
import { Body, inline, mathOnly } from "./text.js";

type CitePillState = { text: string; top: number; left: number };
type CiteEditorState =
  | { mode: "new"; text: string; top: number; left: number }
  | { mode: "edit"; id: string; text: string; top: number; left: number };

const RELEARN_STOPS_MS = [
  15 * 60_000,
  30 * 60_000,
  3_600_000,
  2 * 3_600_000,
  4 * 3_600_000,
  8 * 3_600_000,
  16 * 3_600_000,
  24 * 3_600_000,
  2 * 24 * 3_600_000,
  4 * 24 * 3_600_000,
  7 * 24 * 3_600_000,
  14 * 24 * 3_600_000,
  30 * 24 * 3_600_000,
  60 * 24 * 3_600_000,
] as const;

function nearestStopIdx(ms: number | null | undefined): number {
  const target = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 20 * 60_000;
  let best = 0;
  let bestDist = Infinity;
  const logT = Math.log(target);
  for (let i = 0; i < RELEARN_STOPS_MS.length; i++) {
    const d = Math.abs(Math.log(RELEARN_STOPS_MS[i]!) - logT);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function starterAnchorLine(starter: string | null | undefined): string {
  if (!starter) return "";
  for (const line of starter.split("\n")) {
    const t = line.trim();
    if (t.length >= 6) return t;
  }
  return starter.trim();
}

function isTouchDevice(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/** True when a starter contains TeX math or numbered prose blanks that should render with KaTeX rather than raw in a textarea. */
function isRenderedStarter(starter: string | null | undefined): boolean {
  if (!starter) return false;
  if (/\$[^$\n]+\$|\\(?:frac|sqrt|gamma|beta|alpha|sigma|delta|theta|lambda|mu|sum|prod|cdot|times|le|ge|approx|infty|mathbb|mathbf|mathrm|text|hat|bar|tilde|\|)/.test(starter)) {
    return true;
  }
  if (/^\s*1\.\s+[A-Z]/.test(starter) && /___/.test(starter)) return true;
  return false;
}

/** On touch devices, for prose/TeX starters, or for fillable `___` skeletons, never pre-fill raw text into the textarea. */
function shouldPinStarterAbovePad(starter: string | null | undefined): boolean {
  if (!starter) return false;
  return countStarterBlanks(starter) > 0 || isRenderedStarter(starter) || isTouchDevice();
}

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

const DEPTH_LABEL: Record<Depth, string> = {
  recall: "recall",
  rebuild: "rebuild",
  explain: "explain",
  use: "apply",
};

/** Slot states that are finished for this sitting (a `retry` still owes its end-of-sitting attempt). */
const isSlotResolved = (status: SittingSlotStatus) =>
  status === "pass" || status === "missed" || status === "rescheduled" || status === "removed";

/**
 * The committed sitting as a fixed row of hairline ticks, one per slot in locked order.
 * Carries no unit names, prompts or topics: position and state only.
 */
function SittingHairline(props: { slots: readonly SittingSlot[]; receipt?: boolean }) {
  const label = () => {
    const total = props.slots.length;
    const resolved = props.slots.filter((s) => isSlotResolved(s.status)).length;
    const retry = props.slots.filter((s) => s.status === "retry").length;
    return `Sitting progress: ${resolved} of ${total} resolved${retry > 0 ? `, ${retry} to retry` : ""}`;
  };
  return (
    <div class={{ "v2-sitting-line": true, "is-receipt": Boolean(props.receipt) }} role="img" aria-label={label()}>
      <For each={props.slots} keyed={(s) => s.unitId}>
        {(s) => (
          <span
            class={{
              "v2-sitting-tick": true,
              "is-active": s().status === "active",
              "is-pass": s().status === "pass",
              "is-retry": s().status === "retry",
              "is-closed": s().status === "missed" || s().status === "rescheduled" || s().status === "removed",
            }}
          />
        )}
      </For>
    </div>
  );
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
                <Show when={c().kind === "confused"}>
                  <span class="v2-cite-flag">Didn't follow</span>
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
                  <span class="v2-added-tag">{removed() ? "Removed" : u().observe_only ? "Added move" : "Added to practice"}</span>
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
  const [previewDelayMs, setPreviewDelayMs] = createSignal<number | null>(null);
  const [editingBeatIdx, setEditingBeatIdx] = createSignal<number | null>(null);
  const [editDraft, setEditDraft] = createSignal("");
  const [blankValues, setBlankValues] = createSignal<string[]>([]);
  const [blankNote, setBlankNote] = createSignal("");
  const [tidying, setTidying] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [mcqSubmitting, setMcqSubmitting] = createSignal<"check" | "reveal" | null>(null);
  const [mcqError, setMcqError] = createSignal<string | null>(null);

  // Selection-based citations & quiet "+ Map" pin (T3 Code-style floating pill on text selection)
  const [citePill, setCitePill] = createSignal<CitePillState | null>(null);
  const [citeEditor, setCiteEditor] = createSignal<CiteEditorState | null>(null);
  const [citeComment, setCiteComment] = createSignal("");
  const [pinningMap, setPinningMap] = createSignal(false);
  const [pinnedMap, setPinnedMap] = createSignal(false);
  const [manualAddedIds, setManualAddedIds] = createSignal<string[]>([]);

  // Active stage accessors backed directly by PracticeStore (fine-grained, single source of truth).
  const isExplore = () => practice.state.stage.kind === "explore";
  const isSittingDone = () => practice.state.stage.kind === "sitting-done";
  const activeExploration = () => practice.currentExploration();
  const isExploreMode = () => isExplore() || Boolean(activeExploration());
  const activeFrontier = () => practice.currentFrontier();
  const isNonUnit = () => isExplore() || isSittingDone() || Boolean(activeExploration()) || Boolean(activeFrontier());
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

  // Bounded multiple-choice rep: four frozen options, select then Check, ungraded clarifying line.
  const mcqChoices = () => (rep()?.modality === "mcq" ? (rep()?.mcq?.choices ?? []) : []);
  const isMcq = () => mcqChoices().length > 0;
  const mcqOpen = () => isMcq() && !passedVerdict()?.ok;
  const mcqResult = () => (isMcq() ? (passedVerdict()?.mcq_result ?? null) : null);
  const mcqSelectedId = () => mcqResult()?.selected_choice_id ?? (mcqOpen() ? (unitSession()?.mcqSelectedChoiceId ?? null) : null);
  const exploreAddedIds = createMemo(() => {
    const ids = new Set<string>();
    if (!isExploreMode() && !activeFrontier()) return ids;
    for (const b of beats()) {
      if (!b.added) continue;
      for (const u of b.added) {
        if (!practice.state.removedUnits[u.unit_id]) ids.add(u.unit_id);
      }
    }
    for (const id of manualAddedIds()) {
      if (!practice.state.removedUnits[id]) ids.add(id);
    }
    return ids;
  });
  const dueFromExplore = createMemo(() => {
    const ids = exploreAddedIds();
    if (ids.size === 0) return [];
    return practice.state.queue.filter(
      (u) => u.due && !practice.state.sittingCompletedIds[u.unit_id] && ids.has(u.unit_id),
    );
  });

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
  // Choosing an option involves no typing, so an MCQ rep is timed from when its card was shown.
  const MCQ_LATENCY_CAP_MS = 10 * 60_000;
  let mcqShownAt = 0;

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
  let postInputEl!: HTMLInputElement;
  let blankNoteEl: HTMLInputElement | undefined;
  let mcqClarifyEl: HTMLInputElement | undefined;
  let mcqStageEl: HTMLDivElement | undefined;
  let mcqVerdictEl: HTMLDivElement | undefined;
  let mcqOptionEls: (HTMLDivElement | undefined)[] = [];
  let blankEls: (HTMLSpanElement | undefined)[] = [];
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

  const focusComposer = () => {
    if (passedVerdict()?.ok) postInputEl?.focus();
    else if (isMcq()) mcqClarifyEl?.focus();
    else textarea?.focus();
  };

  const cancelPending = () => {
    // Only abort — let `submitBeat`'s `finally` release `busy` cleanly when identity matches.
    activeAbort?.abort();
    if (!isMcq()) requestAnimationFrame(() => textarea?.focus());
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
    setBlankValues([]);
    setBlankNote("");
    blankEls = [];
    setCitePill(null);
    setCiteEditor(null);
    setCiteComment("");
    setPinningMap(false);
    setPinnedMap(false);
    setBumpOpen(false);
    setPreviewDelayMs(null);
    setManualAddedIds([]);
    setError(null);
    setMcqSubmitting(null);
    setMcqError(null);
    mcqOptionEls = [];
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
      // Clean up any untouched raw-TeX or mobile starter previously pre-filled into the draft.
      if (
        existing.rep.starter &&
        shouldPinStarterAbovePad(existing.rep.starter) &&
        existing.beats.length === 0 &&
        !existing.passedVerdict &&
        existing.draft.trim() === existing.rep.starter.trim()
      ) {
        practice.updateUnitSession(unitId, (d) => {
          d.draft = "";
        });
      }
      setLoading(false);
      mcqShownAt = Date.now();
      // A choice card has no text field to land in: leave focus alone so 1-4 work straight away.
      if (!existing.passedVerdict?.ok && existing.rep.modality !== "mcq") {
        requestAnimationFrame(() => {
          autoGrow();
          if (!isTouchDevice()) textarea?.focus();
        });
      }
      return;
    }

    const ctrl = new AbortController();
    loadAbort = ctrl;
    setLoading(true);
    try {
      const upcomingIds = practice
        .dueQueue()
        .filter((u) => u.unit_id !== unitId)
        .slice(0, 4)
        .map((u) => u.unit_id);
      const res = await fetchNextDrill(
        {
          unitId,
          sittingId: practice.state.sittingId,
          sittingSize: practice.state.sittingIds.length,
          directDone: practice.sittingDirectDoneCount(),
          manual: practice.isManualPractice(unitId),
          retry: practice.isRetryUnit(unitId),
          nextIds: upcomingIds,
        },
        ctrl.signal,
      );
      if (disposed || seq !== loadSeq || ctrl.signal.aborted || practice.stageKey() !== unitId) return;
      const issuedMcq = res.rep?.modality === "mcq";
      if (res.rep) {
        practice.rememberPrompt(unitId, res.rep.prompt);
        practice.updateUnitSession(unitId, (d) => {
          d.scheduler = res.scheduler;
          d.rep = res.rep;
          if (res.rep?.attempt_id) d.attemptId = res.rep.attempt_id;
          if (issuedMcq && !res.rep?.mcq?.choices.some((c) => c.id === d.mcqSelectedChoiceId)) {
            d.mcqSelectedChoiceId = null;
          }
          if (
            !issuedMcq &&
            res.rep?.starter &&
            !shouldPinStarterAbovePad(res.rep.starter) &&
            !d.draft.trim() &&
            d.beats.length === 0 &&
            !d.passedVerdict
          ) {
            d.draft = res.rep.starter;
          }
        });
      }
      activeMs = practice.state.sessions[unitId]?.activeMs ?? 0;
      lastActivityAt = 0;
      mcqShownAt = Date.now();
      if (!issuedMcq) {
        requestAnimationFrame(() => {
          autoGrow();
          if (!isTouchDevice()) textarea?.focus();
        });
      }
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

  // Re-sync canvas DPR whenever Sketch opens.
  createEffect(
    () => [sketchOpen(), loading(), Boolean(passedVerdict()?.ok)] as const,
    ([open]) => {
      if (open) requestAnimationFrame(resizeCanvas);
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
    if (!stageEl) return;
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
    requestAnimationFrame(focusComposer);
  };

  const pinSelectionToMap = async () => {
    const pill = citePill();
    if (!pill || pinningMap() || pinnedMap()) return;
    setPinningMap(true);
    try {
      const topic = activeExploration()?.title ?? activeFrontier()?.title ?? null;
      const created = await createQuickUnit({ text: pill.text, topic, told: true });
      if (disposed) return;
      setManualAddedIds((prev) => (prev.includes(created.unit_id) ? prev : [...prev, created.unit_id]));
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
    requestAnimationFrame(focusComposer);
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
      } else if (mcqOpen()) {
        handleMcqKey(e);
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
    return draft().trim().length > 0 || citations().length > 0 || (sketchOpen() && hasInk());
  };

  const activeBlanks = createMemo(() => {
    if (isNonUnit() || passedVerdict()?.ok || beats().length > 0 || editingBeatIdx() !== null) return null;
    const starter = rep()?.starter;
    if (!starter || countStarterBlanks(starter) === 0) return null;
    return {
      starter,
      parsed: parseStarterBlanks(starter),
      isProse: isRenderedStarter(starter),
    };
  });

  const setBlankValue = (index: number, value: string) => {
    setBlankValues((prev) => {
      const next = prev.slice();
      next[index] = value;
      return next;
    });
  };

  const filledBlankCount = () => blankValues().filter((v) => v && v.trim().length > 0).length;

  const canSubmitBlanks = () => {
    if (busy() || !activeBlanks()) return false;
    return filledBlankCount() > 0 || blankNote().trim().length > 0 || citations().length > 0;
  };

  const submitFillableBlanks = async () => {
    const b = activeBlanks();
    if (!b || !canSubmitBlanks()) return;
    const text = assembleFilledStarter(b.starter, blankValues(), blankNote());
    await submitBeat(text);
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
    practice.markUnitCompleted(ownerKey, res.credited_unit_ids);
  };

  const updateBeatsFor = (key: string, fn: (list: Beat[]) => void) => {
    if (key === "__explore__") practice.updateExplore((d) => fn(d.beats));
    else practice.updateUnitSession(key, (d) => fn(d.beats));
  };

  // ---- Bounded MCQ: select, then Check. A tap never submits. ----
  const mcqAttemptId = () => unitSession()?.attemptId ?? rep()?.attempt_id ?? null;

  const mcqLatencyMs = (): number | null => {
    if (mcqShownAt <= 0) return null;
    const total = Math.round(activeMs + (Date.now() - mcqShownAt));
    if (total > MCQ_LATENCY_CAP_MS) return null;
    return Math.max(500, total);
  };

  const mcqFailureMessage = (e: unknown): string => {
    if (e instanceof SendError) {
      if (e.status === 409) return "This question was already answered with a different choice.";
      if (e.status >= 400 && e.status < 500 && e.message) return e.message;
    }
    return "Couldn't check that just now. Your choice is kept. Try again.";
  };

  const isEditableTarget = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    Boolean(target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));

  const selectMcqChoice = (choiceId: string, focus = false) => {
    if (!mcqOpen() || busy()) return;
    if (unitSession()?.mcqSelectedChoiceId !== choiceId) {
      practice.updateUnitSession(sessionKey(), (d) => {
        d.mcqSelectedChoiceId = choiceId;
      });
    }
    setMcqError(null);
    if (focus) mcqOptionEls[mcqChoices().findIndex((c) => c.id === choiceId)]?.focus();
  };

  const onMcqOptionClick = (e: MouseEvent, choiceId: string) => {
    // Dragging across an option to cite it must not also change the answer.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim() && e.currentTarget instanceof Node && sel.containsNode(e.currentTarget, true)) {
      return;
    }
    selectMcqChoice(choiceId);
  };

  const onMcqOptionKey = (e: KeyboardEvent, index: number) => {
    if (!mcqOpen() || busy() || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const list = mcqChoices();
    let next = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (index + 1) % list.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (index - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === " " || e.key === "Enter") next = index;
    const target = list[next];
    if (!target) return;
    e.preventDefault();
    selectMcqChoice(target.id, true);
  };

  /** Settle an issued MCQ from the server's verdict. The option card carries the verdict, so no beat is added. */
  const settleMcq = (ownerKey: string, res: CheckDrillResponse) => {
    practice.updateUnitSession(ownerKey, (d) => {
      d.passedVerdict = res;
      d.overridden = false;
      d.mcqSelectedChoiceId = res.mcq_result?.selected_choice_id ?? null;
      // An unsent clarifying question carries over to the follow-up line instead of being dropped.
      if (d.draft.trim() && !d.postInput.trim()) d.postInput = d.draft;
      d.draft = "";
    });
    setMcqError(null);
    setBumpOpen(false);
    setPreviewDelayMs(null);
    practice.markUnitCompleted(ownerKey, res.credited_unit_ids);
    if (practice.stageKey() !== ownerKey) return;
    requestAnimationFrame(() => {
      mcqVerdictEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      const active = document.activeElement;
      if (!isTouchDevice() && (!active || active === document.body || stageEl.contains(active))) {
        mcqVerdictEl?.focus({ preventScroll: true });
      }
    });
  };

  const submitMcq = async (mode: "check" | "reveal") => {
    const r = rep();
    const ownerKey = sessionKey();
    if (!r || !mcqOpen() || busy()) return;
    const choiceId = mode === "check" ? (unitSession()?.mcqSelectedChoiceId ?? null) : null;
    if (mode === "check" && !choiceId) return;
    const attemptId = mcqAttemptId();
    if (!attemptId) {
      setMcqError("This question didn't load fully. Reload and try again.");
      return;
    }
    const latencyMs = mcqLatencyMs();

    const ctrl = new AbortController();
    activeAbort = ctrl;
    setCitePill(null);
    setCiteEditor(null);
    setBusy(true);
    setMcqSubmitting(mode);
    setMcqError(null);
    setError(null);
    try {
      const res = await submitMcqChoice(
        {
          attempt_id: attemptId,
          unit_id: r.unit_id,
          ...(choiceId ? { choice_id: choiceId } : { reveal: true }),
          latency_ms: latencyMs,
        },
        ctrl.signal,
      );
      if (disposed || ctrl.signal.aborted) return;
      settleMcq(ownerKey, res);
    } catch (e) {
      // The selected choice and the attempt id stay exactly as they were, so a retry re-sends the same answer.
      if (disposed || ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
      setMcqError(mcqFailureMessage(e));
    } finally {
      if (activeAbort === ctrl) {
        activeAbort = null;
        if (!disposed) {
          setBusy(false);
          setMcqSubmitting(null);
        }
      }
    }
  };

  /** Ungraded clarifying question on an open MCQ. Passing `retryIdx` re-sends a parked failed question. */
  const sendMcqClarify = async (retryIdx?: number) => {
    const r = rep();
    const ownerKey = sessionKey();
    if (!r || !mcqOpen() || busy()) return;
    const attemptId = mcqAttemptId();
    if (!attemptId) {
      setMcqError("This question didn't load fully. Reload and try again.");
      return;
    }
    const isRetry = typeof retryIdx === "number";
    const all = snapshot(beats());
    const retryTarget = isRetry ? all[retryIdx] : undefined;
    if (isRetry && !retryTarget) return;
    const question = retryTarget ? retryTarget.user : draft().trim();
    const pendingCitations: Citation[] = retryTarget ? (retryTarget.citations ?? []) : snapshot(citations());
    const payloadText = formatCitedMessage(pendingCitations, question);
    if (!payloadText) return;

    const turns: { role: "user" | "assistant"; text: string }[] = [];
    for (const b of isRetry ? all.slice(0, retryIdx) : all) {
      if (b.pending || isFailedBeat(b)) continue;
      const u = beatUserPayload(b);
      if (u) turns.push({ role: "user", text: u });
      if (b.coach) turns.push({ role: "assistant", text: b.coach });
    }
    const latencyMs = mcqLatencyMs();

    const ctrl = new AbortController();
    activeAbort = ctrl;
    setCitePill(null);
    setCiteEditor(null);
    setBusy(true);
    setMcqError(null);
    setError(null);

    const pendingId = uuidv7();
    const asBeat = (coach: string, extra?: Partial<Beat>): Beat => ({
      user: question,
      ...(pendingCitations.length > 0 ? { citations: pendingCitations } : {}),
      sketch: null,
      coach,
      ...extra,
    });
    const replacePending = (next: Beat | null) => {
      practice.updateUnitSession(ownerKey, (d) => {
        const idx = d.beats.findIndex((b) => b.pending && b.pendingId === pendingId);
        if (idx < 0) {
          if (next) d.beats.push(next);
        } else if (next) d.beats[idx] = next;
        else d.beats.splice(idx, 1);
      });
    };
    practice.updateUnitSession(ownerKey, (d) => {
      if (latencyMs !== null) d.activeMs = latencyMs;
      const pendingBeat = asBeat("", { pending: true, pendingId });
      if (isRetry && retryIdx < d.beats.length) {
        d.beats[retryIdx] = pendingBeat;
      } else {
        d.beats.push(pendingBeat);
        d.draft = "";
        d.citations = [];
      }
    });
    const settleFocus = () => {
      if (disposed || practice.stageKey() !== ownerKey) return;
      requestAnimationFrame(() => {
        mcqClarifyEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        if (!isTouchDevice()) mcqClarifyEl?.focus({ preventScroll: true });
      });
    };
    requestAnimationFrame(() => mcqClarifyEl?.scrollIntoView({ block: "nearest", behavior: "smooth" }));

    const restoreUnsent = () => {
      if (isRetry && retryTarget) {
        replacePending(retryTarget);
        return;
      }
      replacePending(null);
      practice.updateUnitSession(ownerKey, (d) => {
        if (!d.draft) d.draft = question;
        if (d.citations.length === 0 && pendingCitations.length > 0) d.citations.push(...pendingCitations);
      });
    };

    try {
      const res = await askDrillFollowUp(
        {
          attempt_id: attemptId,
          unit_id: r.unit_id,
          depth: "recall",
          prompt: r.prompt,
          attempt: "",
          feedback: "",
          turns,
          question: payloadText,
          latency_ms: latencyMs,
          hints_used: 0,
        },
        ctrl.signal,
        (partial) => {
          if (disposed || ctrl.signal.aborted) return;
          practice.updateUnitSession(ownerKey, (d) => {
            const target = d.beats.find((b) => b.pending && b.pendingId === pendingId);
            if (target) target.coach = partial;
          });
        },
      );
      if (disposed) return;
      if (ctrl.signal.aborted) {
        restoreUnsent();
        return;
      }
      replacePending(
        asBeat(res.message, {
          ...(res.added_units && res.added_units.length > 0 ? { added: res.added_units } : {}),
          ...(res.failed && !res.ok ? { failed: true } : {}),
        }),
      );
      if (res.added_units && res.added_units.length > 0) void practice.refreshQueue({ preserveOrder: true });
      // The server closes the attempt as revealed when the clarification gave the answer away.
      if (res.ok) settleMcq(ownerKey, res);
      else settleFocus();
    } catch (e) {
      if (disposed) return;
      if (ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        restoreUnsent();
        settleFocus();
        return;
      }
      // Park the question as a retryable failed beat. The card stays open and selectable.
      replacePending(asBeat(e instanceof Error && e.message ? e.message : "Could not reach the tutor just now.", { failed: true }));
    } finally {
      if (activeAbort === ctrl) {
        activeAbort = null;
        if (!disposed) setBusy(false);
      }
    }
  };

  const handleMcqKey = (e: KeyboardEvent) => {
    if (busy() || e.isComposing || e.repeat) return;
    const editable = isEditableTarget(e.target);
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      if (editable) {
        // Inside the clarifying line the chord sends the question; it never submits a choice from a field.
        if (e.target === mcqClarifyEl && (draft().trim().length > 0 || citations().length > 0)) {
          e.preventDefault();
          void sendMcqClarify();
        }
        return;
      }
      e.preventDefault();
      if (draft().trim().length > 0 || citations().length > 0) return;
      if (unitSession()?.mcqSelectedChoiceId) void submitMcq("check");
      return;
    }
    if (editable || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    // Match the physical digit row too, so layouts that need Shift for digits (AZERTY) still work unshifted.
    const digit = /^[1-4]$/.test(e.key) ? Number(e.key) : Number(/^Digit([1-4])$/.exec(e.code)?.[1] ?? 0);
    const choice = digit > 0 ? mcqChoices()[digit - 1] : undefined;
    if (!choice) return;
    e.preventDefault();
    selectMcqChoice(choice.id, true);
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
    showPivot?: boolean;
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
        sidecarPending?: boolean;
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
      const firstUser = cleanPrior.length > 0 ? beatUserPayload(cleanPrior[0]!) : "";
      const initial =
        cleanPrior.length === 0
          ? opts.payloadText
          : firstUser || cleanPrior[0]!.coach || opts.payloadText;
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
        ...(res.sidecar_pending ? { sidecarPending: true } : {}),
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
          ...(opts.showPivot ? { show_pivot: true } : {}),
          ...(r.modality ? { modality: r.modality } : {}),
          ...(r.bundled_unit_ids && r.bundled_unit_ids.length > 0 ? { bundled_unit_ids: r.bundled_unit_ids } : {}),
          sketch_data_url: opts.sketch,
          latency_ms: opts.latencyMs,
          hints_used: opts.showPivot ? 1 : 0,
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
        ...(r.modality ? { modality: r.modality } : {}),
        ...(r.bundled_unit_ids && r.bundled_unit_ids.length > 0 ? { bundled_unit_ids: r.bundled_unit_ids } : {}),
        ...(opts.showPivot ? { show_pivot: true } : {}),
        sketch_data_url: opts.sketch,
        latency_ms: opts.latencyMs,
        hints_used: cleanPrior.length,
      },
      opts.signal,
      opts.onDelta,
    );
    return { kind: "drill", res };
  };

  const submitBeat = async (overrideText?: string, opts?: { showPivot?: boolean; tellMe?: boolean }) => {
    const showPivot = Boolean(opts?.showPivot);
    const tellMe = Boolean(opts?.tellMe);
    const hasOverride = typeof overrideText === "string" && overrideText.trim().length > 0;
    if (!hasOverride && !showPivot && !tellMe && !canSubmit()) return;
    if ((hasOverride || showPivot || tellMe) && (busy() || (!isNonUnit() && passedVerdict()?.ok))) return;
    const ownerKey = sessionKey();
    const isFreshExplore = isExplore();
    const savedExp = activeExploration();
    const modeExplore = isExploreMode();
    const frontier = activeFrontier();
    const unitRep = rep();
    const prevDraft = draft().trim();
    const text = tellMe
      ? ""
      : hasOverride
        ? overrideText.trim()
        : showPivot
          ? prevDraft || "Show answer."
          : prevDraft;
    const activeQ = activeExploreQuestion();
    const qAns = tellMe ? "Walk me through this directly." : "";
    const rawCitations = tellMe ? [] : snapshot(citations());
    const pendingCitations: Citation[] =
      activeQ && qAns
        ? [{ id: uuidv7(), text: activeQ, comment: qAns }, ...rawCitations]
        : rawCitations;
    const payloadText = formatCitedMessage(pendingCitations, text || (tellMe ? qAns : ""));
    const sketch = tellMe ? null : exportSketch();
    const priorBeats = snapshot(beats());
    const latencyMs = !modeExplore && !frontier ? currentActiveLatencyMs() : null;
    const attemptId = !modeExplore && !frontier && unitRep ? ensureAttemptId(ownerKey) : undefined;
    pauseActivity();

    const ctrl = new AbortController();
    activeAbort = ctrl;
    setCitePill(null);
    setCiteEditor(null);
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
        if (!tellMe) {
          d.draft = "";
          d.citations = [];
        }
      });
    } else {
      practice.updateUnitSession(ownerKey, (d) => {
        if (latencyMs !== null) d.activeMs = latencyMs;
        d.beats.push(pendingBeat);
        if (!tellMe) {
          d.draft = "";
          d.citations = [];
        }
      });
    }
    if (!tellMe) clearSketch();
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
        showPivot,
        signal: ctrl.signal,
        onDelta,
      });
      if (!out || disposed || ctrl.signal.aborted) {
        updateBeatsFor(ownerKey, (list) => {
          const idx = list.findIndex((b) => b.pending && b.pendingId === pendingId);
          if (idx >= 0) list.splice(idx, 1);
        });
        if (!disposed && !tellMe) {
          setDraftFor(ownerKey, hasOverride ? prevDraft : text);
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
      if (out.kind === "explore" && out.sidecarPending && !failed) {
        const expIdForSidecar = out.exploration?.id ?? savedExp?.id;
        if (expIdForSidecar) {
          void waitExplorationSidecar(expIdForSidecar)
            .then((meta) => {
              if (disposed) return;
              if (meta.title || meta.added_units.length > 0) {
                void practice.refreshExplorations();
                if (meta.added_units.length > 0) void practice.refreshQueue({ preserveOrder: true });
              }
            })
            .catch(() => {});
        }
      }
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
        if (!disposed && !tellMe) {
          setDraftFor(ownerKey, hasOverride ? prevDraft : text);
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
      if (out.kind === "explore" && out.sidecarPending && !failed) {
        const expIdForSidecar = out.exploration?.id ?? savedExp?.id;
        if (expIdForSidecar) {
          void waitExplorationSidecar(expIdForSidecar)
            .then((meta) => {
              if (disposed) return;
              if (meta.title || meta.added_units.length > 0) {
                void practice.refreshExplorations();
                if (meta.added_units.length > 0) void practice.refreshQueue({ preserveOrder: true });
              }
            })
            .catch(() => {});
        }
      }
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
          ...(r.modality ? { modality: r.modality } : {}),
          ...(r.bundled_unit_ids && r.bundled_unit_ids.length > 0 ? { bundled_unit_ids: r.bundled_unit_ids } : {}),
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
    const cleanDrillBeats = snapshot(beats())
      .filter((b) => !b.pending && !isFailedBeat(b))
      .map((b): Beat => ({
        user: b.user,
        ...(b.citations && b.citations.length > 0 ? { citations: b.citations } : {}),
        ...(b.sketch ? { sketch: b.sketch } : {}),
        coach: b.coach,
        ...(b.question ? { question: b.question } : {}),
        ...(b.added && b.added.length > 0 ? { added: b.added } : {}),
      }));
    const vNow = passedVerdict();
    const mcqVerdictBeat: Beat | null = (() => {
      const m = vNow?.mcq_result;
      if (!isMcq() || !m) return null;
      const choices = mcqChoices();
      const pickedIdx = m.selected_choice_id ? choices.findIndex((c) => c.id === m.selected_choice_id) : -1;
      const pickedText = pickedIdx >= 0 ? `${pickedIdx + 1}. ${choices[pickedIdx]!.text}` : "I'm not sure · Show answer";
      const coachParts = [
        m.outcome === "wrong" && m.why_wrong_selected ? m.why_wrong_selected : "",
        m.explanation,
      ].filter(Boolean);
      return { user: pickedText, coach: coachParts.join("\n\n") };
    })();
    const originCoach = (() => {
      const choices = mcqChoices();
      if (choices.length > 0) {
        return `${r.prompt}\n\n${choices.map((c, i) => `${i + 1}. ${c.text}`).join("\n")}`;
      }
      return r.prompt;
    })();
    const cleanPriorPost = priorPost.filter((b) => !b.pending && !isFailedBeat(b));
    const promotedHistoryBeats: Beat[] = [
      { user: "", coach: originCoach },
      ...cleanDrillBeats,
      ...(mcqVerdictBeat ? [mcqVerdictBeat] : []),
      ...cleanPriorPost,
    ];

    const priorTurns: { role: "user" | "assistant"; text: string }[] = [];
    for (const b of [...cleanDrillBeats, ...(mcqVerdictBeat ? [mcqVerdictBeat] : []), ...cleanPriorPost]) {
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

    try {
      const res = await exploreDrill(
        {
          initial: `Completed practice on: ${r.prompt} (Unit: ${r.text})${mcqExploreContext()}`,
          turns: priorTurns,
          reply: payloadText,
          promote_on_unit: true,
          origin_prompt: r.prompt,
          prior_post_turns: promotedHistoryBeats.map((b) => ({
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
      if (res.exploration && !res.failed && !(fix && fix.changes.length > 0)) {
        // Auto-promote conceptual post-pass follow-ups into a saved Exploration carrying the full drill history.
        const promotedBeats: Beat[] = [...promotedHistoryBeats, resolved];
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

  const handleUndoAddedUnit = async (u: AddedUnit) => {
    if (practice.state.removedUnits[u.unit_id] || removingId() === u.unit_id) return;
    setRemovingId(u.unit_id);
    try {
      await practice.undoAddedUnit(u.unit_id);
    } finally {
      if (!disposed) setRemovingId(null);
    }
  };

  const commitDelayOverride = async (delayMs: number) => {
    const r = rep();
    const v = passedVerdict();
    const ownerKey = sessionKey();
    if (!r || !v?.ok || overriding()) return;
    setOverriding(true);
    setError(null);
    try {
      const res = await rescheduleDrillUnit({
        unit_id: r.unit_id,
        delay_ms: delayMs,
      });
      if (disposed) return;
      const appliedMs = res.next_in_ms ?? delayMs;
      practice.updateUnitSession(ownerKey, (d) => {
        if (d.passedVerdict) {
          // Pure timing override: keep grade honest, only update next_in_ms.
          d.passedVerdict.next_in_ms = appliedMs;
        }
        d.overridden = true;
      });
      practice.syncDueOverride(r.unit_id, appliedMs);
      setPreviewDelayMs(null);
      void practice.refreshQueue({ preserveOrder: true });
    } catch (e) {
      if (!disposed) {
        setPreviewDelayMs(null);
        setError(e instanceof Error ? e.message : "Could not update schedule right now.");
      }
    } finally {
      if (!disposed) setOverriding(false);
    }
  };

  // One truthful scheduling line. Answer time is deliberately not shown or compared: the timer
  // measures typing activity, so it penalises thinking pauses and rewards shorter answers.
  const intervalLabel = () => {
    const v = passedVerdict();
    if (!v || !v.ok) return "";
    const lapse = v.grade === "again";
    const soon = (ms: number) =>
      lapse && ms < 4 * 3_600_000 ? `back soon (~${fmtDur(ms)})` : `next ~${fmtDur(ms)}`;
    const preview = previewDelayMs();
    if (preview !== null) return soon(preview);
    const next = v.next_in_ms !== null && v.next_in_ms > 0 ? v.next_in_ms : null;
    if (overridden()) return next !== null ? `next ~${fmtDur(next)}` : "scheduled";
    if (lapse && practice.state.sittingRetryIds[sessionKey()]) return "end of sitting";
    if (next === null) return lapse ? "back soon" : "";
    if (v.schedule_kind === "relearn") return `relearn · next ~${fmtDur(next)}`;
    const prev = v.prev_interval_ms;
    const planned = v.scheduled_interval_ms;
    if (
      v.schedule_kind === "normal" &&
      v.prev_schedule_kind !== "first" &&
      v.prev_schedule_kind !== "override" &&
      typeof prev === "number" &&
      prev > 0 &&
      typeof planned === "number" &&
      planned > 0 &&
      fmtDur(prev) !== fmtDur(planned) &&
      fmtDur(prev) !== fmtDur(next)
    ) {
      return `~${fmtDur(prev)} → ~${fmtDur(next)}`;
    }
    return soon(next);
  };

  // MCQ verdicts state the next assignment, never a win: the next rep always removes the choices.
  const mcqScheduleLabel = () => {
    const v = passedVerdict();
    const outcome = v?.mcq_result?.outcome;
    if (!v || !v.ok) return "";
    const inTime = (ms: number) => `Next: answer without choices in ${fmtDur(ms)}`;
    const preview = previewDelayMs();
    if (preview !== null) return inTime(preview);
    const next = v.next_in_ms !== null && v.next_in_ms > 0 ? v.next_in_ms : null;
    if (overridden() && next !== null) return inTime(next);
    const missed = outcome === "wrong" || outcome === "revealed" || (!outcome && v.grade === "again");
    if (missed && practice.isRetryUnit(sessionKey())) return "Answer without choices at end of sitting";
    return inTime(next ?? (outcome === "correct" ? 4 * 3_600_000 : 20 * 60_000));
  };

  /** The frozen options and what the learner did with them, for the post-verdict explore context. */
  const mcqExploreContext = (): string => {
    const choices = mcqChoices();
    if (choices.length === 0) return "";
    const res = mcqResult();
    const numberOf = (id: string | null | undefined) => {
      const i = id ? choices.findIndex((c) => c.id === id) : -1;
      return i >= 0 ? String(i + 1) : null;
    };
    const lines = choices.map((c, i) => `${i + 1}. ${c.text}`);
    const picked = numberOf(res?.selected_choice_id);
    const correct = numberOf(res?.correct_id);
    const answer = correct ? ` The correct answer is option ${correct}.` : "";
    const outcomes: Record<McqOutcome, string> = {
      correct: `The learner chose option ${picked ?? "?"}, which is correct.`,
      assisted_correct: `The learner chose option ${picked ?? "?"}, which is correct, after asking for clarifying help.`,
      wrong: `The learner chose option ${picked ?? "?"}, which is wrong.${answer}`,
      revealed: `The learner did not choose an option; the answer was shown to them.${answer}`,
    };
    return `\n\nIt was asked as multiple choice with these options:\n${lines.join("\n")}${res ? `\n${outcomes[res.outcome]}` : ""}`;
  };

  // What the next rep will ask for, when it differs from this one. Stated as an assignment, not an award.
  const nextDepthNote = () => {
    const v = passedVerdict();
    const depth = rep()?.depth;
    if (!v || !v.ok || v.grade === "again" || !v.next_depth || !depth || v.next_depth === depth) return "";
    return `next time: ${DEPTH_LABEL[v.next_depth]}`;
  };

  const inSittingLine = () => {
    const id = activeUnitId();
    return !isNonUnit() && Boolean(id) && practice.sittingSlots().some((s) => s.unitId === id);
  };

  const receiptSummary = () => {
    const p = practice.sittingPracticedCount();
    const r = practice.sittingRescheduledCount();
    const rescheduled = (related: boolean) =>
      `${r} ${related ? "related " : ""}${r === 1 ? "review was" : "reviews were"} rescheduled.`;
    if (p === 0) return r > 0 ? rescheduled(false) : "";
    const practiced = `You practiced ${p} ${p === 1 ? "unit" : "units"}.`;
    return r > 0 ? `${practiced} ${rescheduled(true)}` : practiced;
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
    void submitBeat(undefined, { tellMe: true });
  };

  /** Schedule line with the Bring back slider, plus Next. Shared by the written and the MCQ verdict. */
  const VerdictFoot = (props: { label: () => string; note?: () => string; clean: () => boolean }) => {
    const note = () => props.note?.() ?? "";
    return (
      <>
        <div class="v2-verdict-foot">
          <span class="v2-verdict-trace">
            <Show when={props.label()}>
              <Show
                when={rep()?.unit_id}
                fallback={<span>{props.label()}</span>}
              >
                <button
                  type="button"
                  class={{ "v2-interval-btn": true, "is-open": bumpOpen() }}
                  disabled={overriding()}
                  data-tip="Adjust when this comes back"
                  aria-expanded={bumpOpen() ? "true" : "false"}
                  onClick={() => {
                    setBumpOpen((open) => {
                      if (open) setPreviewDelayMs(null);
                      return !open;
                    });
                  }}
                >
                  <span>{overriding() ? "updating…" : props.label()}</span>
                  <svg class="v2-interval-caret" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M2.5 3.75 5 6.25l2.5-2.5" />
                  </svg>
                </button>
              </Show>
            </Show>
            <Show when={note()}>
              <span class="v2-verdict-note">
                <Show when={props.label()}>
                  <span aria-hidden="true"> · </span>
                </Show>
                {note()}
              </span>
            </Show>
          </span>
          <div class="v2-pass-actions">
            <button
              type="button"
              class={{ "v2-btn-primary": true, "is-passed": props.clean() }}
              onClick={transitionToNext}
            >
              <Show when={props.clean()}>
                <svg class="v2-check-svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3.2 8.4l3.2 3.2 6.4-7" />
                </svg>
              </Show>
              Next <span class="v2-kbd">⌘↵</span>
            </button>
          </div>
        </div>
        <Show when={bumpOpen() && rep()?.unit_id}>
          {(() => {
            const effectiveMs = () =>
              previewDelayMs() ??
              (passedVerdict()?.next_in_ms && passedVerdict()!.next_in_ms! > 0
                ? passedVerdict()!.next_in_ms!
                : 20 * 60_000);
            const recommendedMs = () => {
              const v = passedVerdict();
              if (typeof v?.scheduled_interval_ms === "number" && v.scheduled_interval_ms > 0) {
                return v.scheduled_interval_ms;
              }
              if (typeof v?.next_in_ms === "number" && v.next_in_ms > 0) {
                return v.next_in_ms;
              }
              return 20 * 60_000;
            };
            const recIdx = () => nearestStopIdx(recommendedMs());
            const recFrac = () => recIdx() / (RELEARN_STOPS_MS.length - 1);
            const curIdx = () => nearestStopIdx(effectiveMs());
            const atRecommended = () => curIdx() === recIdx();
            return (
              <div class="v2-bump-row" role="group" aria-label="Adjust next review time">
                <span class="v2-bump-label">Bring back</span>
                <div class="v2-bump-track-wrap">
                  <span
                    class={{ "v2-bump-rec-tick": true, "is-active": atRecommended() }}
                    style={{ left: `calc(5.5px + (100% - 11px) * ${recFrac()})` }}
                    aria-hidden="true"
                  />
                  <input
                    type="range"
                    class="v2-bump-range"
                    min={0}
                    max={RELEARN_STOPS_MS.length - 1}
                    step={1}
                    value={curIdx()}
                    disabled={overriding()}
                    aria-label="Bring back interval"
                    aria-valuetext={fmtDur(effectiveMs())}
                    onInput={(e) => {
                      const ms = RELEARN_STOPS_MS[Number(e.currentTarget.value)];
                      if (ms !== undefined) setPreviewDelayMs(ms);
                    }}
                    onChange={(e) => {
                      const ms = RELEARN_STOPS_MS[Number(e.currentTarget.value)];
                      if (ms !== undefined) void commitDelayOverride(ms);
                    }}
                  />
                  <button
                    type="button"
                    class={{
                      "v2-bump-rec-label": true,
                      "is-start": recIdx() === 0,
                      "is-end": recIdx() === RELEARN_STOPS_MS.length - 1,
                      "is-active": atRecommended(),
                    }}
                    style={{ left: `calc(5.5px + (100% - 11px) * ${recFrac()})` }}
                    disabled={overriding() || atRecommended()}
                    data-tip={`Recommended (~${fmtDur(recommendedMs())})`}
                    onClick={() => void commitDelayOverride(recommendedMs())}
                  >
                    {fmtDur(recommendedMs())}
                  </button>
                </div>
                <span class="v2-bump-val">{fmtDur(effectiveMs())}</span>
              </div>
            );
          })()}
        </Show>
      </>
    );
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
      <Show when={!loading()} fallback={<div class="v2-loading-dots"><span /><span /><span /></div>}>
        <Show
          when={!isSittingDone()}
          fallback={
            <div class="v2-sitting-done">
              <Show when={practice.sittingSlots().length > 0}>
                <SittingHairline slots={practice.sittingSlots()} receipt />
              </Show>
              <h1 class="v2-prompt">Done for now.</h1>
              <Show when={receiptSummary()}>
                <p class="v2-sitting-done-sub">{receiptSummary()}</p>
              </Show>
              <Show when={practice.sittingReconstructed().length > 0}>
                <section class="v2-sitting-done-notes" aria-labelledby="v2-sitting-done-label">
                  <p id="v2-sitting-done-label" class="v2-sitting-done-label">
                    Reconstructed on the second try
                  </p>
                  <ul class="v2-sitting-done-list">
                    <For each={practice.sittingReconstructed().slice(0, 2)} keyed={(item) => item.unitId}>
                      {(item) => <li class="v2-sitting-done-unit">{inline(item().label)}</li>}
                    </For>
                    <Show when={practice.sittingReconstructed().length > 2}>
                      <li class="v2-sitting-done-more">
                        and {practice.sittingReconstructed().length - 2} more
                      </li>
                    </Show>
                  </ul>
                </section>
              </Show>
              <div class="v2-sitting-done-foot">
                <div class="v2-sitting-done-actions">
                  <button
                    type="button"
                    class="v2-btn-secondary"
                    onClick={() => practice.selectExplore()}
                  >
                    Explore something new
                  </button>
                  <Show when={practice.backlogDueCount() > 0}>
                    <button
                      type="button"
                      class="v2-ghost-btn"
                      onClick={() => practice.startNextSitting()}
                    >
                      Start another sitting ({Math.min(8, practice.backlogDueCount())})
                    </button>
                  </Show>
                </div>
                <Show when={practice.soonestNextMs()}>
                  {(ms) => <p class="v2-sitting-done-next">Next review in {fmtDur(ms() ?? 0)}</p>}
                </Show>
              </div>
            </div>
          }
        >
        <Show when={inSittingLine()}>
          <SittingHairline slots={practice.sittingSlots()} />
        </Show>
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
              {(r) => {
                const anchor = () => starterAnchorLine(r().starter);
                const pinnedAbove = () => shouldPinStarterAbovePad(r().starter);
                const rendered = () => isRenderedStarter(r().starter);
                const showStarterRef = () =>
                  Boolean(r().starter) &&
                  !activeBlanks() &&
                  (pinnedAbove() ||
                    (beats().length > 0 && !beats().some((b) => anchor() && b.user.includes(anchor()))));
                return (
                  <>
                    <h1 class="v2-prompt" data-citable="true">
                      {inline(r().prompt)}
                    </h1>
                    <Show when={showStarterRef()}>
                      <Show
                        when={rendered()}
                        fallback={
                          <pre class="v2-prompt-starter" data-citable="true">
                            {mathOnly(r().starter!)}
                          </pre>
                        }
                      >
                        <div class="v2-prompt-starter is-prose" data-citable="true">
                          <Body text={r().starter!} />
                        </div>
                      </Show>
                    </Show>
                  </>
                );
              }}
            </Match>
          </Switch>
        </div>

        {/* Bounded MCQ: four frozen options. Select, then Check; the verdict settles right under them. */}
        <Show when={isMcq()}>
          <div ref={mcqStageEl} class="v2-mcq-stage">
            <div
              class={{
                "v2-pad": true,
                "v2-textured": true,
                "v2-mcq": true,
                "is-checking": mcqSubmitting() !== null,
                "is-settled": !mcqOpen(),
              }}
            >
              <div class="v2-mcq-options" role="radiogroup" aria-label="Answer choices">
                <For each={mcqChoices()} keyed={(c) => c.id}>
                  {(choice, i) => {
                    const selected = () => mcqSelectedId() === choice().id;
                    const isCorrect = () => mcqResult()?.correct_id === choice().id;
                    const isWrongPick = () => mcqResult()?.outcome === "wrong" && selected() && !isCorrect();
                    const tabbable = () => mcqOpen() && (selected() || (!mcqSelectedId() && i() === 0));
                    return (
                      <div
                        ref={(el) => {
                          mcqOptionEls[i()] = el;
                        }}
                        class={{
                          "v2-mcq-option": true,
                          "is-selected": selected(),
                          "is-correct": isCorrect(),
                          "is-wrong-pick": isWrongPick(),
                          "is-locked": !mcqOpen(),
                        }}
                        role="radio"
                        aria-checked={selected() ? "true" : "false"}
                        aria-disabled={!mcqOpen() || busy() ? "true" : undefined}
                        tabindex={tabbable() ? 0 : -1}
                        onClick={(e) => onMcqOptionClick(e, choice().id)}
                        onKeyDown={(e) => onMcqOptionKey(e, i())}
                      >
                        <span class="v2-mcq-mark" aria-hidden="true">
                          <Show when={isCorrect()} fallback={<span class="v2-mcq-num">{i() + 1}</span>}>
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M3.2 8.4l3.2 3.2 6.4-7" />
                            </svg>
                          </Show>
                        </span>
                        <span class="v2-mcq-text" data-citable="true">
                          {inline(choice().text)}
                        </span>
                        <Show when={isCorrect() || isWrongPick()}>
                          <span class="v2-mcq-badge">{isCorrect() ? "Correct" : "Your choice"}</span>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
              <Show when={mcqOpen()}>
                <Show when={mcqError()}>
                  {(msg) => (
                    <p class="v2-error-line v2-mcq-error" role="alert">
                      {msg()}
                    </p>
                  )}
                </Show>
                <div class="v2-pad-foot v2-mcq-foot">
                  <button
                    type="button"
                    class="v2-mcq-reveal"
                    disabled={busy()}
                    onClick={() => void submitMcq("reveal")}
                  >
                    I'm not sure · Show answer
                  </button>
                  <div class="v2-pad-actions">
                    <button
                      type="button"
                      class={{ "v2-btn-primary": true, "is-busy": mcqSubmitting() === "check" }}
                      disabled={mcqSubmitting() === "check" ? false : busy() || !mcqSelectedId()}
                      onClick={() => {
                        if (mcqSubmitting() === "check") cancelPending();
                        else void submitMcq("check");
                      }}
                    >
                      <Show
                        when={mcqSubmitting() === "check"}
                        fallback={
                          <>
                            Check <span class="v2-kbd">⌘↵</span>
                          </>
                        }
                      >
                        <span class="v2-spinner" aria-hidden="true" />
                        <span class="v2-busy-label">Checking</span>
                        <span class="v2-busy-stop">Cancel</span>
                      </Show>
                    </button>
                  </div>
                </div>
              </Show>
            </div>

            <Show when={passedVerdict()?.ok ? passedVerdict() : null}>
              {(v) => {
                const outcome = () => v()?.mcq_result?.outcome ?? null;
                return (
                  <div
                    ref={mcqVerdictEl}
                    class={{
                      "v2-beat-coach": true,
                      "v2-mcq-verdict": true,
                      "is-pass": outcome() === "correct",
                      "is-missed": outcome() !== "correct",
                    }}
                    role="status"
                    tabindex={-1}
                  >
                    <Show when={outcome() === "correct" || outcome() === "assisted_correct"}>
                      <p class="v2-mcq-verdict-title">{outcome() === "correct" ? "Correct" : "Correct with help"}</p>
                    </Show>
                    <Show when={v()?.mcq_result}>
                      {(m) => (
                        <div class="v2-verdict-body" data-citable="true">
                          <Show when={m()?.outcome === "wrong" && m()?.why_wrong_selected}>
                            {(why) => <p>{inline(why() ?? "")}</p>}
                          </Show>
                          <p>{inline(m()?.explanation ?? "")}</p>
                        </div>
                      )}
                    </Show>
                    <VerdictFoot label={mcqScheduleLabel} clean={() => outcome() === "correct"} />
                  </div>
                );
              }}
            </Show>
          </div>
        </Show>

        {/* Progressive Solveit-style committed beats */}
        <Show when={beats().length > 0}>
          <div class="v2-beats">
            <For each={beats()}>
              {(beat, idx) => {
                // An MCQ's verdict lives on its option card; its beats are only clarification turns.
                const isFinalPass = () => !isMcq() && Boolean(passedVerdict()?.ok) && idx() === beats().length - 1;
                const isCleanPass = () => isFinalPass() && passedVerdict()?.grade !== "again";
                const isMissedClose = () => isFinalPass() && passedVerdict()?.grade === "again";
                const failed = () => isFailedBeat(beat);
                const isEditing = () => editingBeatIdx() === idx();
                const canEdit = () =>
                  !isNonUnit() &&
                  !isMcq() &&
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
                                      <div class="v2-edit-pin-head">
                                        <button
                                          type="button"
                                          class={{ "v2-edit-pin-quote": true, [`is-${pin.kind}`]: true }}
                                          disabled={resolved()}
                                          data-tip={resolved() ? "Edited" : "Jump to this span"}
                                          onClick={() => focusEditAnnotation(pin.quote)}
                                        >
                                          {pin.quote}
                                        </button>
                                        <Show when={resolved()}>
                                          <span class="v2-edit-pin-state">Edited</span>
                                        </Show>
                                      </div>
                                      <span class="v2-edit-pin-note">{inline(pin.note)}</span>
                                    </div>
                                  );
                                }}
                              </For>
                            </div>
                          </Show>
                          <div class="v2-inline-edit-foot">
                            <button type="button" class="v2-inline-edit-cancel" onClick={cancelEditingBeat}>
                              Cancel
                            </button>
                            <div class="v2-pad-actions">
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
                                  class={{ "v2-beat-code": true, "is-prose": isNonUnit() || isMcq() }}
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
                          "is-pass": isCleanPass(),
                          "is-missed": isMissedClose(),
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
                                  : isNonUnit() || isMcq()
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
                              <Show when={!isMcq() || mcqOpen()}>
                                <button
                                  type="button"
                                  class="v2-retry-btn"
                                  disabled={busy()}
                                  onClick={() => void (isMcq() ? sendMcqClarify(idx()) : retryBeat(idx()))}
                                >
                                  <RetryIcon />
                                  Retry
                                </button>
                              </Show>
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
                          <VerdictFoot label={intervalLabel} note={nextDepthNote} clean={isCleanPass} />
                        </Show>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        {/* Ungraded clarifying line while an MCQ is open */}
        <Show when={mcqOpen()}>
          <div class="v2-post-follow-wrap v2-mcq-clarify">
            <ComposerCitationChips />
            <form
              class={{
                "v2-post-follow": true,
                "has-text": draft().trim().length > 0 || citations().length > 0,
              }}
              onSubmit={(e) => {
                e.preventDefault();
                void sendMcqClarify();
              }}
            >
              <input
                ref={mcqClarifyEl}
                type="text"
                class="v2-post-input"
                placeholder="Or ask a clarifying question…"
                aria-label="Ask a clarifying question"
                enterkeyhint="send"
                spellcheck="false"
                value={draft()}
                disabled={busy()}
                onInput={(e) => setDraftFor(sessionKey(), e.currentTarget.value)}
              />
              <Show when={!busy() && (draft().trim().length > 0 || citations().length > 0)}>
                <button type="submit" class="v2-post-send" aria-label="Ask question">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M8 12.5V3.5M4 7.5L8 3.5l4 4" />
                  </svg>
                </button>
              </Show>
            </form>
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
                          <pre class="v2-beat-code is-prose">{mathOnly(beat.user)}</pre>
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
            </form>
          </div>
        </Show>

        {/* Explicit active question card in Explore mode: quiet header + 1-click Tell me */}
        <Show when={activeExploreQuestion()}>
          {(q) => (
            <div class="v2-explore-q">
              <div class="v2-explore-q-head">
                <span class="v2-explore-q-label">Question</span>
                <div class="v2-explore-q-actions">
                  <button
                    type="button"
                    class="v2-explore-q-tell"
                    disabled={busy()}
                    data-tip="Walk me through this directly"
                    onClick={tellMeDirectly}
                  >
                    Tell me
                  </button>
                </div>
              </div>
              <div class="v2-explore-q-body" data-citable="true">
                <Body text={q()} />
              </div>
            </div>
          )}
        </Show>

        {/* The ONE active pad at the bottom (hidden once rep passes or while editing a derivation in place) */}
        <Show when={!passedVerdict()?.ok && editingBeatIdx() === null && !isMcq()}>
          <Show
            when={activeBlanks()}
            fallback={
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
                        ? "Answer or ask a follow-up…"
                        : beats().length > 0
                          ? "Continue, or ask…"
                          : isExploreMode()
                            ? "Drop a question, derivation, paper, file path, or topic to work through…"
                            : activeFrontier()
                              ? "Cite a line above, ask a question, or explain it back…"
                              : rep()?.starter && shouldPinStarterAbovePad(rep()?.starter)
                                ? "Write your answer for the points above…"
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
                    <Show when={(isExploreMode() || activeFrontier()) && dueFromExplore().length > 0}>
                      <span class="v2-pad-map-count">{dueFromExplore().length} to practice</span>
                    </Show>
                  </div>

                  <div class="v2-pad-actions">
                    <Show when={!isNonUnit() && !busy()}>
                      <button
                        type="button"
                        class="v2-btn-secondary"
                        data-tip="Reveal the answer and bring this card back soon"
                        onClick={() => void submitBeat(undefined, { showPivot: true })}
                      >
                        Show answer
                      </button>
                    </Show>
                    <Show when={draft().trim().length >= 12 && draft().trim() !== (rep()?.starter?.trim() ?? "")}>
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
            }
          >
            {(blanks) => (
              <div class="v2-blank-stage">
                <div
                  ref={padEl}
                  class={{
                    "v2-pad": true,
                    "v2-textured": true,
                    "v2-blank-pad": true,
                    "is-checking": busy(),
                  }}
                >
                  <ComposerCitationChips />
                  <div
                    class={{
                      "v2-blank-lines": true,
                      "is-prose": Boolean(blanks()?.isProse),
                      "is-code": !blanks()?.isProse,
                    }}
                    data-citable="true"
                  >
                    <For each={blanks()?.parsed.lines ?? []}>
                      {(line) => (
                        <div class={{ "v2-blank-row": true, "has-marker": Boolean(line.marker) }}>
                          <Show when={line.marker}>
                            <span class="v2-blank-marker" aria-hidden="true">
                              {line.marker}
                            </span>
                          </Show>
                          <div class="v2-blank-content">
                            <For each={line.segments}>
                              {(seg) =>
                                seg.kind === "text" ? (
                                  blanks()?.isProse ? inline(seg.text) : mathOnly(seg.text)
                                ) : (
                                  <span
                                    ref={(el) => {
                                      blankEls[seg.index] = el;
                                      const saved = blankValues()[seg.index];
                                      if (saved && el.textContent !== saved) el.textContent = saved;
                                    }}
                                    class={{
                                      "v2-blank": true,
                                      "is-code": !blanks()?.isProse,
                                      "is-empty": !(blankValues()[seg.index]?.trim()),
                                    }}
                                    contenteditable={busy() ? "false" : "true"}
                                    role="textbox"
                                    aria-label={`Blank ${seg.index + 1} of ${blanks()?.parsed.blankCount ?? 0}`}
                                    spellcheck={false}
                                    autocorrect="off"
                                    autocapitalize="off"
                                    enterkeyhint={seg.index < (blanks()?.parsed.blankCount ?? 0) - 1 ? "next" : "send"}
                                    onBlur={(e) => {
                                      if (!e.currentTarget.innerText.trim()) e.currentTarget.textContent = "";
                                    }}
                                    onInput={(e) => {
                                      recordActivity();
                                      const val = (e.currentTarget.innerText || "").replace(/\r?\n/g, " ");
                                      setBlankValue(seg.index, val);
                                    }}
                                    onPaste={(e) => {
                                      e.preventDefault();
                                      const text =
                                        e.clipboardData?.getData("text/plain")?.replace(/\r?\n+/g, " ") ?? "";
                                      if (typeof document.execCommand === "function") {
                                        document.execCommand("insertText", false, text);
                                      }
                                    }}
                                    onKeyDown={(e) => {
                                      const count = blanks()?.parsed.blankCount ?? 0;
                                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                        e.preventDefault();
                                        void submitFillableBlanks();
                                        return;
                                      }
                                      if (e.key === "Enter" && !e.shiftKey) {
                                        e.preventDefault();
                                        if (seg.index < count - 1) {
                                          blankEls[seg.index + 1]?.focus();
                                        } else {
                                          void submitFillableBlanks();
                                        }
                                        return;
                                      }
                                      if (e.key === "Tab") {
                                        e.preventDefault();
                                        const targetIdx = e.shiftKey ? seg.index - 1 : seg.index + 1;
                                        if (targetIdx >= 0 && targetIdx < count) {
                                          blankEls[targetIdx]?.focus();
                                        } else if (!e.shiftKey) {
                                          blankNoteEl?.focus();
                                        }
                                      }
                                    }}
                                  />
                                )
                              }
                            </For>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>

                  <div class="v2-pad-foot">
                    <div class="v2-pad-tools">
                      <span class="v2-blank-count">
                        {filledBlankCount()}/{blanks()?.parsed.blankCount ?? 0} filled
                      </span>
                    </div>

                    <div class="v2-pad-actions">
                      <Show when={!busy()}>
                        <button
                          type="button"
                          class="v2-btn-secondary"
                          data-tip="Reveal the answer and bring this card back soon"
                          onClick={() => {
                            const cur = blanks();
                            void submitBeat(
                              cur && filledBlankCount() > 0
                                ? assembleFilledStarter(cur.starter, blankValues(), blankNote())
                                : undefined,
                              { showPivot: true },
                            );
                          }}
                        >
                          Show answer
                        </button>
                      </Show>
                      <button
                        type="button"
                        class={{ "v2-btn-primary": true, "is-busy": busy() }}
                        disabled={!busy() && !canSubmitBlanks()}
                        data-tip={busy() ? "Click or press Esc to cancel" : undefined}
                        onClick={() => (busy() ? cancelPending() : void submitFillableBlanks())}
                      >
                        <Show
                          when={busy()}
                          fallback={
                            <>
                              Check <span class="v2-kbd">⌘↵</span>
                            </>
                          }
                        >
                          <span class="v2-spinner" aria-hidden="true" />
                          <span class="v2-busy-label">Checking</span>
                          <span class="v2-busy-stop">Cancel</span>
                        </Show>
                      </button>
                    </div>
                  </div>
                </div>

                <form
                  class={{
                    "v2-post-follow": true,
                    "v2-blank-note-form": true,
                    "has-text": blankNote().trim().length > 0,
                  }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitFillableBlanks();
                  }}
                >
                  <input
                    ref={blankNoteEl}
                    type="text"
                    class="v2-post-input"
                    placeholder="Or ask a clarifying question…"
                    spellcheck="false"
                    value={blankNote()}
                    disabled={busy()}
                    onInput={(e) => {
                      recordActivity();
                      setBlankNote(e.currentTarget.value);
                    }}
                  />
                  <Show when={!busy() && blankNote().trim().length > 0}>
                    <button type="submit" class="v2-post-send" aria-label="Ask question">
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M8 12.5V3.5M4 7.5L8 3.5l4 4" />
                      </svg>
                    </button>
                  </Show>
                </form>
              </div>
            )}
          </Show>
        </Show>

        <Show when={error() || practice.state.error}>
          {(msg) => <p class="v2-error-line">{msg()}</p>}
        </Show>
        </Show>
      </Show>

      {/* Floating T3-style selection pill: Cite, ???, or pin to Map */}
      <Show when={citePill()}>
        {(pill) => (
          <div
            class="v2-cite-pill"
            style={{ top: `${pill()?.top ?? 0}px`, left: `${pill()?.left ?? 0}px` }}
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
              data-tip="Add to practice"
              data-tip-side="bottom"
              disabled={pinningMap()}
              onClick={() => void pinSelectionToMap()}
            >
              <Show when={!pinnedMap() && !pinningMap()}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true">
                  <path d="M6 2.25v7.5M2.25 6h7.5" />
                </svg>
              </Show>
              <span>{pinnedMap() ? "Added" : pinningMap() ? "…" : "Practice"}</span>
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
            style={{ top: `${ed()?.top ?? 0}px`, left: `${ed()?.left ?? 0}px` }}
          >
            <div class="v2-cite-pop-quote">
              <span class="v2-cite-pop-quote-text">{inline(ed()?.text ?? "")}</span>
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
                Save <span class="v2-kbd">↵</span>
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
