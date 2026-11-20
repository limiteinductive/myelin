// The page editor: a ProseMirror view on one page, kept in step with the log by prosemirror-collab.
// Local steps go to the server in small timed batches as `page.edited` events, each naming the
// revision it was made against. Every edit comes back over the stream: ours as confirmation, others'
// with our unsent steps rebased on top. Unsent steps are kept in browser storage until confirmed.
// Framework-neutral: the UI passes in the aside highlights and reads the selection back as a scope.
import { pageDoc, pageSchema, uuidv7, type Anchor, type MyelinEvent, type PageRun, type PageState } from "@myelin/core";
import { collab, getVersion, receiveTransaction, sendableSteps } from "prosemirror-collab";
import { baseKeymap, exitCode } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { inputRules, textblockTypeInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, Plugin, PluginKey, TextSelection, type Command, type Transaction } from "prosemirror-state";
import { Mapping, Step, StepMap } from "prosemirror-transform";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import { codeBlockView, type CodeInfo } from "./codeblock.js";
import { mathElement, mathSpans, type MathSpan } from "./math.js";

/** An aside's passage, in the positions of the page at `rev` (see setHighlights). */
export interface Highlight {
  id: string;
  from: number;
  to: number;
  kind: "asked" | "selection" | "resting";
}

/** What the composer is aimed at: a selected passage, or the aside the cursor sits in. */
export interface Scope {
  from: number;
  to: number;
  quote: string;
  aside: string | null;
}

export interface EditPayload {
  page_id: string;
  base_rev: number;
  steps: unknown[];
  started_at: number;
  ended_at: number;
}

/** "offline": the server was not reached, so the same event is posted again later. */
export type SendResult = "ok" | "stale" | "refused" | "offline";

export interface EditorOptions {
  /** The page as folded from the log. It is updated in place as edits arrive. */
  page: PageState;
  editable: boolean;
  /** Posts one edit. A retry passes the same id and time, so the server sees the same event. */
  send?: (payload: EditPayload, id: string, ts: number) => Promise<SendResult>;
  /** Whether an event with this id is in the log. */
  logged?: (id: string) => boolean;
  /** After any change of document, selection or focus. */
  changed?: () => void;
  /** Runs the page as the server has it. Resolves to null, or to why it did not run. */
  run?: () => Promise<string | null>;
}

/** A batch is sent after this long without an edit, or once it is this old. */
const IDLE_MS = 1000;
const BATCH_MS = 10_000;

interface Ui {
  focused: boolean;
  rev: number;
  highlights: Highlight[];
  run: PageRun | null;
  running: boolean;
  runError: string | null;
}
const uiKey = new PluginKey<Ui>("myelin-ui");

interface Batch {
  id: string;
  ts: number;
  count: number;
  payload: EditPayload;
}

interface Saved {
  version: number;
  steps: unknown[];
  /** The batch posted and not yet confirmed: the first `count` steps. */
  sending: Batch | null;
}

const storeKey = (id: string) => `myelin:page:${id}`;
function load(id: string): Saved | null {
  try {
    const raw = localStorage.getItem(storeKey(id));
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}
function save(id: string, s: Saved | null): void {
  try {
    if (s) localStorage.setItem(storeKey(id), JSON.stringify(s));
    else localStorage.removeItem(storeKey(id));
  } catch {
    /* storage unavailable */
  }
}

/** A textblock's text, one character per position: a hard break is a newline. */
function blockText(node: PMNode): string {
  let s = "";
  node.forEach((child) => {
    s += child.isText ? child.text! : "\n";
  });
  return s;
}

const INDENT = "    ";

/** In code, Tab indents rather than leaving the page. */
const codeIndent: Command = (state, dispatch) => {
  if (!state.selection.$from.parent.type.spec.code) return false;
  dispatch?.(state.tr.insertText(INDENT).scrollIntoView());
  return true;
};

/** In code, Shift-Tab takes up to one indent off the start of the line. */
const codeDedent: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if (!$from.parent.type.spec.code) return false;
  const text = $from.parent.textContent;
  const lineStart = text.lastIndexOf("\n", $from.parentOffset - 1) + 1;
  const spaces = /^ */.exec(text.slice(lineStart))![0].length;
  const n = Math.min(spaces, INDENT.length);
  if (n > 0 && dispatch) dispatch(state.tr.delete($from.start() + lineStart, $from.start() + lineStart + n).scrollIntoView());
  return true;
};

/** In code, a new line keeps the indent, and goes one further after a colon. */
const codeNewline: Command = (state, dispatch) => {
  const { $from, $to } = state.selection;
  if (!$from.parent.type.spec.code || !$from.sameParent($to)) return false;
  const before = $from.parent.textContent.slice(0, $from.parentOffset);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  let indent = /^ */.exec(line)![0];
  if (/:\s*$/.test(line)) indent += INDENT;
  dispatch?.(state.tr.insertText(`\n${indent}`).scrollIntoView());
  return true;
};

/** Down from the last line of a code block at the end of the page makes a paragraph after it. */
const codeExitDown: Command = (state, dispatch, view) => {
  const { $head, empty } = state.selection;
  if (!empty || !$head.parent.type.spec.code || $head.after() !== state.doc.content.size) return false;
  if ($head.parent.textContent.slice($head.parentOffset).includes("\n")) return false;
  if (view && !view.endOfTextblock("down")) return false;
  return exitCode(state, dispatch);
};

export class PageEditor {
  readonly view: EditorView;
  private readonly page: PageState;
  private readonly clientID = uuidv7();
  /** Ids of the edits this editor posted, to tell its own steps from others' when they come back. */
  private readonly sent = new Set<string>();
  private sending: Batch | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private batchStart: number | null = null;
  private lastEdit = 0;
  /** How many events of the log have been read. */
  private cursor = 0;
  private dismissed: string | null = null;
  /** The highlights in this document's positions, by aside id. */
  private local = new Map<string, { from: number; to: number }>();
  private waiters: (() => void)[] = [];
  private mathDoc: PMNode | null = null;
  private mathList: MathSpan[] = [];
  private destroyed = false;

  constructor(
    mount: HTMLElement,
    private readonly opts: EditorOptions,
  ) {
    this.page = opts.page;
    this.view = new EditorView(mount, {
      state: this.fresh(),
      editable: () => opts.editable,
      dispatchTransaction: (tr) => this.dispatch(tr),
      nodeViews: { code_block: codeBlockView(opts.editable && opts.run ? () => void this.runPage() : null) },
      attributes: { class: "app-doc", "aria-label": "Page", spellcheck: "true" },
    });
    if (opts.editable) this.restore();
  }

  private fresh(ui?: Ui): EditorState {
    const s = pageSchema;
    const plugins: Plugin[] = [collab({ version: this.page.rev, clientID: this.clientID }), this.uiPlugin()];
    if (this.opts.editable) {
      plugins.push(
        history(),
        inputRules({ rules: [textblockTypeInputRule(/^#\s$/, s.nodes.heading!), textblockTypeInputRule(/^```$/, s.nodes.code_block!)] }),
        keymap({ "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo }),
        keymap({ Tab: codeIndent, "Shift-Tab": codeDedent, Enter: codeNewline, ArrowDown: codeExitDown }),
        keymap(baseKeymap),
        problemGuard(),
      );
    }
    const state = EditorState.create({ doc: pageDoc(this.page), plugins });
    return ui ? state.apply(state.tr.setMeta(uiKey, { ...ui, focused: false })) : state;
  }

  private uiPlugin(): Plugin<Ui> {
    return new Plugin<Ui>({
      key: uiKey,
      state: {
        init: () => ({ focused: false, rev: this.page.rev, highlights: [], run: this.page.run, running: false, runError: null }),
        apply: (tr, v) => {
          const m = tr.getMeta(uiKey) as Partial<Ui> | undefined;
          return m ? { ...v, ...m } : v;
        },
      },
      props: {
        decorations: (state) => this.decorations(state),
        handleDOMEvents: {
          focus: (view) => {
            if (!this.destroyed) view.dispatch(view.state.tr.setMeta(uiKey, { focused: true }));
            return false;
          },
          blur: (view) => {
            if (!this.destroyed) view.dispatch(view.state.tr.setMeta(uiKey, { focused: false }));
            return false;
          },
        },
      },
    });
  }

  private dispatch(tr: Transaction): void {
    if (this.destroyed) return;
    this.view.updateState(this.view.state.apply(tr));
    if (tr.docChanged && !tr.getMeta("collab$")) {
      const now = Date.now();
      this.batchStart ??= now;
      this.lastEdit = now;
      this.store();
      this.schedule();
    }
    this.opts.changed?.();
  }

  // ---------- sending ----------

  private schedule(): void {
    clearTimeout(this.timer);
    const age = this.batchStart === null ? 0 : Date.now() - this.batchStart;
    this.timer = setTimeout(() => void this.flush(), this.waiters.length > 0 || age >= BATCH_MS ? 0 : IDLE_MS);
  }

  private async flush(): Promise<void> {
    if (this.sending || !this.opts.send || this.destroyed) return;
    const s = sendableSteps(this.view.state);
    if (!s) return;
    const now = Date.now();
    const id = uuidv7();
    const payload: EditPayload = {
      page_id: this.page.id,
      base_rev: s.version,
      steps: s.steps.map((x) => x.toJSON()),
      started_at: this.batchStart ?? now,
      ended_at: this.lastEdit || now,
    };
    this.sending = { id, ts: now, count: s.steps.length, payload };
    this.sent.add(id);
    this.batchStart = null;
    this.store();
    await this.post();
  }

  /** Posts the batch in flight. A batch that may have been stored is only ever posted again as itself. */
  private async post(): Promise<void> {
    const batch = this.sending;
    if (!batch || !this.opts.send) return;
    const result = await this.opts.send(batch.payload, batch.id, batch.ts);
    if (this.sending !== batch) return; // confirmed over the stream already, or reloaded
    if (result === "ok") return; // confirmed when the event comes back over the stream
    if (result === "offline") {
      this.timer = setTimeout(() => void this.post(), 3000);
      return;
    }
    // Refused, so not stored. A stale batch is rebased when the newer edits arrive, then sent again.
    this.sending = null;
    this.batchStart = Math.min(this.batchStart ?? batch.payload.started_at, batch.payload.started_at);
    if (result === "refused") return this.reload();
    this.store();
    this.timer = setTimeout(() => void this.flush(), 500);
  }

  private store(): void {
    if (!this.opts.editable) return;
    const s = sendableSteps(this.view.state);
    save(this.page.id, s ? { version: s.version, steps: s.steps.map((x) => x.toJSON()), sending: this.sending } : null);
  }

  /**
   * Puts back steps kept from an earlier visit, unless they were confirmed or the page moved on since.
   * A batch that was posted and not yet seen is posted again as the same event: if it was stored, the
   * server answers with the stored copy.
   */
  private restore(): void {
    const saved = load(this.page.id);
    if (!saved || saved.steps.length === 0) return;
    let { version, steps } = saved;
    let sending = saved.sending;
    if (sending && this.opts.logged?.(sending.id)) {
      steps = steps.slice(sending.count);
      version += sending.count;
      sending = null;
    }
    if (steps.length === 0) return save(this.page.id, null);
    if (version !== this.page.rev) {
      console.warn(`page ${this.page.id}: ${steps.length} kept steps dropped, the page changed elsewhere`);
      return save(this.page.id, null);
    }
    const tr = this.view.state.tr;
    try {
      for (const j of steps) tr.step(Step.fromJSON(pageSchema, j));
    } catch {
      return save(this.page.id, null);
    }
    if (sending) {
      this.sending = sending;
      this.sent.add(sending.id);
    }
    this.view.dispatch(tr);
    if (sending) void this.post();
  }

  /** Rebuilds from the folded page, dropping anything unsent. Used when the log and the editor disagree. */
  private reload(): void {
    clearTimeout(this.timer);
    this.sent.clear();
    this.sending = null;
    this.batchStart = null;
    this.cursor = 0;
    save(this.page.id, null);
    this.view.updateState(this.fresh(uiKey.getState(this.view.state)));
    this.opts.changed?.();
  }

  /** Reads new events from the log. Call it whenever the log grows. */
  receive(events: readonly MyelinEvent[]): void {
    if (this.destroyed) return;
    for (; this.cursor < events.length; this.cursor++) {
      const e = events[this.cursor]!;
      if (e.type === "page.ran" && e.payload.page_id === this.page.id) {
        this.view.dispatch(this.view.state.tr.setMeta(uiKey, { run: this.page.run }));
        continue;
      }
      if (e.type !== "page.edited" || e.payload.page_id !== this.page.id) continue;
      const version = getVersion(this.view.state);
      if (e.payload.base_rev < version) continue;
      // A gap: an edit was missed, so start again from the folded page, which has every edit.
      if (e.payload.base_rev > version) return this.reload();
      const ours = this.sent.has(e.id);
      let steps: Step[];
      try {
        steps = e.payload.steps.map((j) => Step.fromJSON(pageSchema, j));
      } catch {
        return this.reload();
      }
      const id = ours ? this.clientID : "elsewhere";
      this.view.dispatch(receiveTransaction(this.view.state, steps, steps.map(() => id), { mapSelectionBackward: true }));
      if (this.sending?.id === e.id) this.sending = null;
    }
    this.store();
    if (!this.sending && sendableSteps(this.view.state)) this.schedule();
    this.settled();
  }

  /** Resolves once every local step is confirmed, or after `ms`. */
  settle(ms = 3000): Promise<void> {
    if (!sendableSteps(this.view.state)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      }, ms);
      this.waiters.push(done);
      if (!this.sending) {
        clearTimeout(this.timer);
        void this.flush();
      }
    });
  }

  private settled(): void {
    if (sendableSteps(this.view.state)) return;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  // ---------- running ----------

  /** Runs every code block on the page once the server has the latest edits. */
  async runPage(): Promise<void> {
    const ui = uiKey.getState(this.view.state)!;
    if (ui.running || !this.opts.run || this.destroyed) return;
    this.view.dispatch(this.view.state.tr.setMeta(uiKey, { running: true, runError: null }));
    await this.settle(10_000);
    let error: string | null;
    try {
      error = await this.opts.run();
    } catch {
      error = "The page could not run just now";
    }
    if (this.destroyed) return;
    this.view.dispatch(this.view.state.tr.setMeta(uiKey, { running: false, runError: error, run: this.page.run }));
  }

  // ---------- highlights, math and scope ----------

  setHighlights(rev: number, highlights: Highlight[]): void {
    if (this.destroyed) return;
    this.view.dispatch(this.view.state.tr.setMeta(uiKey, { rev, highlights }));
  }

  private localHighlights(state: EditorState, ui: Ui): Map<string, { from: number; to: number }> {
    const out = new Map<string, { from: number; to: number }>();
    const version = getVersion(state);
    if (ui.rev > version || this.page.maps.length < version) return this.local;
    const pending = sendableSteps(state)?.steps ?? [];
    const mapping = new Mapping([...this.page.maps.slice(ui.rev, version).map((r) => new StepMap(r)), ...pending.map((s) => s.getMap())]);
    for (const h of ui.highlights) {
      const from = mapping.map(h.from, 1);
      const to = mapping.map(h.to, -1);
      if (to > from) out.set(h.id, { from, to });
    }
    return out;
  }

  private math(doc: PMNode): MathSpan[] {
    if (doc === this.mathDoc) return this.mathList;
    const out: MathSpan[] = [];
    doc.descendants((node, pos) => {
      if (node.type.spec.code) return false;
      if (!node.isTextblock) return true;
      for (const m of mathSpans(blockText(node))) out.push({ ...m, from: pos + 1 + m.from, to: pos + 1 + m.to });
      return false;
    });
    this.mathDoc = doc;
    this.mathList = out;
    return out;
  }

  private decorations(state: EditorState): DecorationSet {
    const ui = uiKey.getState(state)!;
    const sel = state.selection;
    const live = ui.focused && this.opts.editable;
    const decos: Decoration[] = [];
    this.local = this.localHighlights(state, ui);
    const marks: { from: number; to: number; cls: string }[] = [];
    for (const h of ui.highlights) {
      const r = this.local.get(h.id);
      if (r) marks.push({ ...r, cls: `myl-highlight myl-highlight--${h.kind}` });
    }
    // With the focus in the composer, the passage it is aimed at stays marked.
    if (!ui.focused && !sel.empty) marks.push({ from: sel.from, to: sel.to, cls: "myl-highlight myl-highlight--selection" });
    for (const k of marks) decos.push(Decoration.inline(k.from, k.to, { class: k.cls }));
    // Each code block learns its output and status from a node decoration. The attribute changes
    // with them, so the block's view is told.
    let index = 0;
    state.doc.forEach((node, offset) => {
      if (node.type !== pageSchema.nodes.code_block) return;
      const code: CodeInfo = { index, run: ui.run, running: ui.running, error: ui.runError };
      decos.push(Decoration.node(offset, offset + node.nodeSize, { "data-run": `${index}:${ui.run?.at ?? 0}:${ui.running ? 1 : 0}:${ui.runError ?? ""}` }, { code }));
      index++;
    });
    // Math shows rendered, and as typed while the cursor is in it. Its source is hidden, so a
    // highlight over it marks the rendered formula instead.
    for (const m of this.math(state.doc)) {
      if (live && sel.from <= m.to && sel.to >= m.from) {
        decos.push(Decoration.inline(m.from, m.to, { class: "app-math-source" }));
        continue;
      }
      const cls = marks.findLast((k) => k.from < m.to && m.from < k.to)?.cls ?? "";
      decos.push(Decoration.widget(m.from, (view) => this.mathWidget(view, m, cls), { side: -1, key: `${m.display ? "D" : "I"}${cls}${m.tex}`, ignoreSelection: true }));
      decos.push(Decoration.inline(m.from, m.to, { class: "app-math-hidden" }));
    }
    return DecorationSet.create(state.doc, decos);
  }

  private mathWidget(view: EditorView, m: MathSpan, cls: string): HTMLElement {
    const el = mathElement(m.tex, m.display);
    if (cls) el.className += ` ${cls}`;
    if (this.opts.editable) {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const doc = view.state.doc;
        const at = Math.min(view.posAtDOM(el, 0) + (m.display ? 2 : 1), doc.content.size);
        view.dispatch(view.state.tr.setSelection(TextSelection.near(doc.resolve(at))));
        view.focus();
      });
    }
    return el;
  }

  private asideAt(from: number, to: number): string | null {
    let hit: string | null = null;
    for (const [id, r] of this.local) if (r.from <= to && from <= r.to) hit = id;
    return hit;
  }

  /** The passage the composer is aimed at, in this document's positions. */
  scope(): Scope | null {
    if (!this.opts.editable) return null;
    const st = this.view.state;
    const sel = st.selection;
    const key = `${sel.from}:${sel.to}`;
    if (this.dismissed === key) return null;
    this.dismissed = null;
    if (!sel.empty) {
      const quote = st.doc.textBetween(sel.from, sel.to, "\n", "\n").trim();
      return quote ? { from: sel.from, to: sel.to, quote, aside: this.asideAt(sel.from, sel.to) } : null;
    }
    const id = this.asideAt(sel.head, sel.head);
    if (!id) return null;
    const r = this.local.get(id)!;
    return { ...r, quote: st.doc.textBetween(r.from, r.to, "\n", "\n"), aside: id };
  }

  /** Aims the composer back at the thread until the selection changes. */
  dismissScope(): void {
    const sel = this.view.state.selection;
    this.dismissed = `${sel.from}:${sel.to}`;
    this.opts.changed?.();
  }

  /** The anchor for a message about the current scope, in the positions of a revision the server has. */
  async anchor(): Promise<Anchor | null> {
    await this.settle();
    const sc = this.scope();
    if (!sc) return null;
    const st = this.view.state;
    const pending = sendableSteps(st)?.steps ?? [];
    let { from, to } = sc;
    if (pending.length > 0) {
      const back = new Mapping(pending.map((s) => s.getMap())).invert();
      from = back.map(from, 1);
      to = back.map(to, -1);
      if (to <= from) return null;
    }
    return { page_id: this.page.id, rev: getVersion(st), from, to, quote: sc.quote };
  }

  /** The top of an aside's passage on screen, for lining its card up beside it. */
  topOf(id: string): number | null {
    const r = this.local.get(id);
    if (!r) return null;
    try {
      return this.view.coordsAtPos(r.from, 1).top;
    } catch {
      return null;
    }
  }

  focusEnd(): void {
    const doc = this.view.state.doc;
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.atEnd(doc)).scrollIntoView());
    this.view.focus();
  }

  destroy(): void {
    clearTimeout(this.timer);
    // Unsent steps stay in storage; whatever can be sent now is sent.
    if (!this.sending && this.opts.send && sendableSteps(this.view.state)) void this.flush();
    this.destroyed = true;
    for (const f of this.waiters) f();
    this.view.destroy();
  }
}

/** Steps may not touch the problem statement: the server refuses them, so the editor does too. */
function problemGuard(): Plugin {
  return new Plugin({
    filterTransaction: (tr, state) => {
      if (!tr.docChanged || tr.getMeta("collab$")) return true;
      const first = state.doc.firstChild;
      if (first?.type !== pageSchema.nodes.problem) return true;
      const end = first.nodeSize;
      let ok = true;
      for (const step of tr.steps) {
        step.getMap().forEach((from) => {
          if (from < end) ok = false;
        });
      }
      return ok;
    },
  });
}
