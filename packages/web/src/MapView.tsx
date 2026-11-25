// Calm, boxless spatial index: Knowledge dependency tree (Seeds -> Rebuilds with silent RWKV
// strength hairlines and 1-click drill), Thinking Moves, and inspectable Agent Memory (learner.md + Dreaming).
import { createMemo, createSignal, createStore, For, onSettled, reconcile, Show, useContext } from "solid-js";
import {
  createQuickUnit,
  fetchAgentMemory,
  fetchMap,
  saveAgentMemory,
  triggerDream,
  type AgentMemory,
  type DreamLog,
  type MapHabit,
  type MapUnit,
} from "./drillApi.js";
import { PracticeContext } from "./practiceStore.js";
import { Body, inline } from "./text.js";

function fmtSpeed(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
}

function fmtAgo(ts: number): string {
  if (!ts) return "never";
  const sec = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function MapView() {
  const practice = useContext(PracticeContext);
  const [tab, setTab] = createSignal<"units" | "memory">("units");
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [data, setData] = createStore<{ units: MapUnit[]; habits: MapHabit[] }>({
    units: [],
    habits: [],
  });
  const [addingKind, setAddingKind] = createSignal<"unit" | "habit" | null>(null);
  const [draftText, setDraftText] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  // Lean agent memory (learner.md) + offline Dreaming state
  const [memLoaded, setMemLoaded] = createSignal(false);
  const [memory, setMemory] = createSignal<AgentMemory | null>(null);
  const [dreamLogs, setDreamLogs] = createSignal<DreamLog[]>([]);
  const [pendingEvents, setPendingEvents] = createSignal(0);
  const [dreaming, setDreaming] = createSignal(false);
  const [editingMem, setEditingMem] = createSignal(false);
  const [memDraft, setMemDraft] = createSignal("");
  const [savingMem, setSavingMem] = createSignal(false);

  let loadAbort: AbortController | null = null;
  let loadSeq = 0;
  let disposed = false;

  const loadMemory = async (signal?: AbortSignal) => {
    try {
      const res = await fetchAgentMemory(signal);
      if (disposed || signal?.aborted) return;
      setMemory(res.memory);
      setDreamLogs(res.logs);
      setPendingEvents(res.pending_events);
      setDreaming(res.dreaming);
      setMemLoaded(true);
    } catch {
      if (!disposed) setMemLoaded(true);
    }
  };

  const load = async () => {
    loadAbort?.abort();
    const ctrl = new AbortController();
    loadAbort = ctrl;
    const seq = ++loadSeq;
    setError(null);
    try {
      const [res] = await Promise.all([fetchMap(ctrl.signal), loadMemory(ctrl.signal)]);
      if (disposed || seq !== loadSeq || ctrl.signal.aborted) return;
      setData((s) => {
        reconcile(res.units, "id")(s.units);
        reconcile(res.habits, "id")(s.habits);
      });
      setLoaded(true);
    } catch (e) {
      if (disposed || seq !== loadSeq || ctrl.signal.aborted) return;
      setError(e instanceof Error ? e.message : "Could not load your map.");
      setLoaded(true);
    }
  };

  const runDreamNow = async () => {
    if (dreaming()) return;
    setDreaming(true);
    setError(null);
    try {
      const res = await triggerDream();
      if (disposed) return;
      setMemory(res.memory);
      setDreamLogs(res.logs);
      setPendingEvents(0);
      setEditingMem(false);
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : "Could not run Dream consolidation.");
    } finally {
      if (!disposed) setDreaming(false);
    }
  };

  const saveEditedMemory = async () => {
    if (savingMem()) return;
    setSavingMem(true);
    setError(null);
    try {
      const res = await saveAgentMemory(memDraft());
      if (disposed) return;
      setMemory(res.memory);
      setEditingMem(false);
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : "Could not save memory.");
    } finally {
      if (!disposed) setSavingMem(false);
    }
  };

  onSettled(() => {
    void load();
    return () => {
      disposed = true;
      loadAbort?.abort();
    };
  });

  // Memoized dependency tree: seeds (lowest recall first so fading ones surface), dependents nested under their first seed.
  const tree = createMemo(() => {
    const all = data.units;
    const byId = new Map(all.map((u) => [u.id, u]));
    const children = new Map<string, MapUnit[]>();
    const roots: MapUnit[] = [];

    for (const u of all) {
      const parentId = u.rests_on.find((id) => byId.has(id));
      if (parentId) {
        const list = children.get(parentId) ?? [];
        list.push(u);
        children.set(parentId, list);
      } else {
        roots.push(u);
      }
    }

    const byUrgency = (a: MapUnit, b: MapUnit) => {
      const pa = a.reviews === 0 ? -1 : a.p_imm;
      const pb = b.reviews === 0 ? -1 : b.p_imm;
      return pa - pb || b.found_at - a.found_at;
    };
    roots.sort(byUrgency);

    const flat: { id: string; unit: MapUnit; depth: number }[] = [];
    const visited = new Set<string>();
    const walk = (u: MapUnit, depth: number) => {
      if (visited.has(u.id)) return;
      visited.add(u.id);
      flat.push({ id: u.id, unit: u, depth });
      const kids = (children.get(u.id) ?? []).sort(byUrgency);
      for (const k of kids) walk(k, Math.min(depth + 1, 2));
    };
    for (const r of roots) walk(r, 0);
    for (const u of all) if (!visited.has(u.id)) walk(u, 0);
    return flat;
  });

  const saveNew = async (ev: SubmitEvent) => {
    ev.preventDefault();
    const text = draftText().trim();
    const kind = addingKind();
    if (!text || !kind || saving()) return;
    setSaving(true);
    setError(null);
    try {
      await createQuickUnit({ text, kind: kind === "habit" ? "thinking move" : "move", observe_only: kind === "habit" });
      if (disposed) return;
      setDraftText("");
      setAddingKind(null);
      // Invalidate queue immediately upon server success, independent of Map reload.
      void practice.refreshQueue({ preserveOrder: true });
      await load();
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : "Could not save item.");
    } finally {
      if (!disposed) setSaving(false);
    }
  };

  const strengthOpacity = (u: MapUnit) => {
    if (u.reviews === 0) return 0.22;
    return Math.max(0.2, Math.min(1, u.p_imm));
  };

  return (
    <div class="v2-index">
      <div class="v2-index-bar">
        <Show
          when={tab() === "units" && addingKind()}
          fallback={
            <div class="v2-index-tabs" role="tablist" aria-label="Map sections">
              <button
                type="button"
                role="tab"
                aria-selected={tab() === "units" ? "true" : "false"}
                class={{ "v2-index-tab": true, "is-active": tab() === "units" }}
                onClick={() => setTab("units")}
              >
                Units
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab() === "memory" ? "true" : "false"}
                class={{ "v2-index-tab": true, "is-active": tab() === "memory" }}
                onClick={() => setTab("memory")}
              >
                Memory
              </button>
            </div>
          }
        >
          {(k) => (
            <form class="v2-inline-add" onSubmit={saveNew}>
              <input
                ref={(el) => queueMicrotask(() => el.focus())}
                class="v2-inline-input"
                type="text"
                placeholder={k() === "habit" ? "New thinking move…" : "New unit…"}
                value={draftText()}
                onInput={(e) => setDraftText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setAddingKind(null);
                    setDraftText("");
                  }
                }}
              />
              <button class="v2-btn-primary" type="submit" disabled={!draftText().trim() || saving()}>
                Add
              </button>
            </form>
          )}
        </Show>
        <div class="v2-index-actions">
          <Show
            when={tab() === "units"}
            fallback={
              <>
                <Show when={!editingMem()}>
                  <button
                    type="button"
                    class="v2-ghost-btn"
                    onClick={() => {
                      setMemDraft(memory()?.content ?? "");
                      setEditingMem(true);
                    }}
                  >
                    Edit
                  </button>
                </Show>
                <button
                  type="button"
                  class="v2-ghost-btn"
                  disabled={dreaming()}
                  title="Consolidate recent drills and explorations into lean learner memory"
                  onClick={() => void runDreamNow()}
                >
                  {dreaming() ? "Dreaming…" : "Dream now"}
                </button>
              </>
            }
          >
            <button type="button" class="v2-ghost-btn" onClick={() => setAddingKind((k) => (k === "unit" ? null : "unit"))}>
              + Unit
            </button>
            <button type="button" class="v2-ghost-btn" onClick={() => setAddingKind((k) => (k === "habit" ? null : "habit"))}>
              + Move
            </button>
          </Show>
        </div>
      </div>

      <Show when={error()}>
        {(msg) => (
          <p class="v2-index-error">
            {msg()}{" "}
            <button type="button" class="v2-ghost-btn" onClick={() => void load()}>
              Retry
            </button>
          </p>
        )}
      </Show>

      <Show when={tab() === "memory"}>
        <Show when={memLoaded()} fallback={<div class="v2-loading-dots"><span /><span /><span /></div>}>
          <section class="v2-mem-wrap">
            <div class="v2-mem-meta">
              <span>
                {memory()?.last_dream_at
                  ? `Last dreamed ${fmtAgo(memory()!.last_dream_at)} · ${memory()!.dream_count} pass${memory()!.dream_count === 1 ? "" : "es"}`
                  : "Not dreamed yet"}
              </span>
              <Show when={pendingEvents() > 0}>
                <span> · {pendingEvents()} new events</span>
              </Show>
              <Show when={memory()?.content}>
                <span> · {memory()!.content.trim().split(/\s+/).length} words</span>
              </Show>
            </div>

            <Show
              when={!editingMem()}
              fallback={
                <div class="v2-mem-editor">
                  <textarea
                    class="v2-pad-input v2-mem-textarea"
                    rows={12}
                    spellcheck="false"
                    value={memDraft()}
                    placeholder="Notes about your baseline, what explanations click for you, and active blind spots…"
                    onInput={(e) => setMemDraft(e.currentTarget.value)}
                  />
                  <div class="v2-inline-edit-foot">
                    <button type="button" class="v2-ghost-btn" onClick={() => setEditingMem(false)}>
                      Cancel
                    </button>
                    <button type="button" class="v2-btn-primary" disabled={savingMem()} onClick={() => void saveEditedMemory()}>
                      {savingMem() ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              }
            >
              <Show
                when={memory()?.content?.trim()}
                fallback={
                  <div class="v2-mem-empty">
                    <p>
                      Myelin keeps a lean cognitive profile of your baseline, what explanations click for you, and
                      recurring blind spots—automatically pruning weaknesses once you master them.
                    </p>
                    <button type="button" class="v2-btn-primary" disabled={dreaming()} onClick={() => void runDreamNow()}>
                      {dreaming() ? "Dreaming…" : "Run first dream"}
                    </button>
                  </div>
                }
              >
                {(text) => (
                  <div class="v2-mem-body">
                    <Body text={text()} />
                  </div>
                )}
              </Show>
            </Show>

            <Show when={dreamLogs().length > 0}>
              <div class="v2-mem-logs">
                <div class="v2-section-whisper">Recent dreams</div>
                <For each={dreamLogs()}>
                  {(log) => (
                    <div class="v2-mem-log">
                      <div class="v2-mem-log-head">{fmtAgo(log.created_at)}</div>
                      <p class="v2-mem-log-summary">{log.summary}</p>
                      <Show when={log.promoted.length > 0 || log.graduated.length > 0}>
                        <div class="v2-mem-log-tags">
                          <For each={log.promoted}>
                            {(p) => <span class="v2-mem-tag is-promoted">+ {p}</span>}
                          </For>
                          <For each={log.graduated}>
                            {(g) => <span class="v2-mem-tag is-graduated">✓ {g}</span>}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </Show>
      </Show>

      <Show when={tab() === "units"}>
      <Show when={loaded()} fallback={<div class="v2-loading-dots"><span /><span /><span /></div>}>
        <Show when={tree().length > 0}>
          <section class="v2-index-section">
            <For each={tree()} keyed={(row) => row.id}>
              {(row) => {
                const u = () => row().unit;
                const speed = () => {
                  const first = fmtSpeed(u().first_latency_ms);
                  const last = fmtSpeed(u().last_latency_ms);
                  if (!last) return "";
                  return first && first !== last ? `${first} → ${last}` : last;
                };
                return (
                  <button
                    type="button"
                    class={{ "v2-row": true, "is-nested": row().depth > 0 }}
                    style={{ "padding-left": row().depth > 0 ? `${row().depth * 24}px` : undefined }}
                    onClick={() => practice.selectUnit(u().id)}
                  >
                    <span
                      class="v2-strength-bar"
                      style={{ opacity: strengthOpacity(u()) }}
                      title={u().reviews > 0 ? `P(recall) ${Math.round(u().p_imm * 100)}%` : "Untested"}
                    />
                    <span class="v2-row-text">{inline(u().text)}</span>
                    <span class="v2-row-right">
                      <span class="v2-row-meta">{speed() || (u().reviews > 0 ? `${Math.round(u().p_imm * 100)}%` : "")}</span>
                      <span class="v2-row-cta">Practice →</span>
                    </span>
                  </button>
                );
              }}
            </For>
          </section>
        </Show>

        <Show when={data.habits.length > 0}>
          <section class="v2-index-section v2-index-section--spaced">
            <div class="v2-section-whisper">Thinking moves</div>
            <For each={data.habits}>
              {(h) => (
                <div class="v2-row v2-row--static">
                  <span class="v2-strength-bar is-habit" />
                  <span class="v2-row-text">{inline(h.text)}</span>
                  <Show when={h.present + h.missing > 0}>
                    <span class="v2-row-meta">
                      {h.present}/{h.present + h.missing}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </section>
        </Show>
      </Show>
      </Show>
    </div>
  );
}
