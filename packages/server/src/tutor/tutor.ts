// The tutor: a Pi agent per learner, one session per sitting. It answers learner messages, greets a
// learner who opens the app after a break, and streams its reply as a draft while it writes.
// The reply becomes a message.added event when the turn ends; the draft itself is never stored.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeEvent, mapRange, pageLines, pageText, STUDY_MODE_DEVICE, uuidv7, type Anchor, type EventType, type MyelinEvent, type PageState } from "@myelin/core";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Appended, EventStore } from "../store.js";
import type { Stores } from "../stores.js";
import { anchorLabel, buildSittingContext, formatAgo, openPage, tailOf, type ThreadMessage } from "./context.js";
import { changedLines, OBSERVE_PAUSE_MS, observationPrompt, parseVerdict, TRIAGE_SYSTEM, triagePrompt, WORKING_MS, type Verdict } from "./observer.js";
import { describeProbe, offerProbe, tutorTools, type Card, type Offer, type ToolHost, type TurnInfo } from "./tools.js";

/** The device id on everything the tutor writes. */
export const TUTOR_DEVICE = "server:tutor";
export const FIRST_RUN_TEXT = "What do you want to learn, and is there a date you are working toward?";
export const SITTING_GAP_MS = 30 * 60_000;

export interface Draft {
  id: string;
  text: string;
  done: boolean;
  error?: string;
  /** Set when the reply belongs to an aside. */
  anchor?: Anchor | null;
}

export interface ModelChoice {
  runtime: ModelRuntime;
  model: Model<Api>;
}
/** Picks the model for a learner. Friends may bring their own key, so this is per user. */
export type ModelSource = (userId: string) => Promise<ModelChoice>;

export interface TutorOptions {
  systemPrompt: string;
  model: ModelSource;
  /** Where Pi may keep its files. Nothing of the learner's is written there. */
  agentDir: string;
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  sittingGapMs?: number;
  /** Pi's retry on a failed model call. */
  retry?: boolean;
  now?: () => number;
  timeZone?: string | undefined;
  log?: (msg: string) => void;
  /** How long the learner pauses after a page edit before the observer looks. */
  observePauseMs?: number;
  /** The model for the observer's triage. Defaults to the tutor's. */
  triageModel?: ModelSource;
}

const APP_NOTE = `

# Notes from the app

Text in square brackets that starts with "app:" comes from the app, not from the learner. Everything else in a user turn is what the learner wrote. Your reply is posted to the thread as one message when you finish. If nothing needs saying, call stay_quiet and write nothing.`;

type Trigger = "message" | "greeting" | "observation";

export class Tutor {
  private messages: ThreadMessage[] = [];
  private imported = new Set<string>();
  /** The seq of the last learner message the tutor has been given. */
  private answeredThrough = 0;
  private session: AgentSession | null = null;
  private sittingSince = 0;
  private lastTurnAt = 0;
  private pending = new Set<Trigger>();
  private busy: Promise<void> | null = null;
  private current: Draft | null = null;
  private listeners = new Set<(d: Draft) => void>();
  private unsubscribe: () => void;
  private closed = false;
  private firstRunSent = false;
  /** The turn in progress, for the tools. */
  private turnInfo: TurnInfo | null = null;
  /** Probes offered and not yet recorded, by unit id. */
  private offers = new Map<string, Offer>();
  /** Things the app tells the tutor at the start of its next prompt, such as a learner's rewording. */
  private notes: string[] = [];
  /** The revision of each page the tutor has read in this sitting. */
  private seenRev = new Map<string, number>();
  /** A pause timer per page the learner is editing. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Pages whose pause has run out and which the observer has not looked at yet. */
  private due = new Set<string>();
  /** Each page as the observer or the tutor last looked at it. */
  private looked = new Map<string, { rev: number; lines: string[] }>();
  private readonly gap: number;
  private readonly now: () => number;

  constructor(
    readonly userId: string,
    private readonly nameOf: () => string,
    private readonly store: EventStore,
    private readonly opts: TutorOptions,
  ) {
    this.gap = opts.sittingGapMs ?? SITTING_GAP_MS;
    this.now = opts.now ?? Date.now;
    for (const e of store.read(0, -1)) this.index(e);
    // Messages from before this process started count as answered unless they are recent and
    // came after the tutor's last word.
    const lastTutor = this.messages.findLast((m) => m.author === "tutor")?.seq ?? 0;
    const stale = this.messages.findLast((m) => m.author === "learner" && this.now() - m.ts > this.gap)?.seq ?? 0;
    this.answeredThrough = Math.max(lastTutor, stale);
    this.unsubscribe = store.subscribe((fresh) => this.onAppended(fresh));
  }

  /** The reply being written, if any. */
  get draft(): Draft | null {
    return this.current;
  }

  onDraft(fn: (d: Draft) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolves when no turn is running or queued. */
  async idle(): Promise<void> {
    while (this.busy) await this.busy;
  }

  /** A device opened the thread: the first run asks for a goal, and a return after a break gets a greeting. */
  opened(): void {
    if (this.closed) return;
    if (this.messages.length === 0) {
      if (this.firstRunSent) return;
      this.firstRunSent = true;
      this.post(uuidv7(this.now()), FIRST_RUN_TEXT);
      return;
    }
    const last = this.messages.at(-1)!;
    if (this.now() - last.ts > this.gap && !this.busy) this.kick("greeting");
  }

  close(): void {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.unsubscribe();
    this.endSitting();
  }

  // -------------------------------------------------------------------------------------------

  private index(e: MyelinEvent & { seq?: number }): ThreadMessage | null {
    if (e.type !== "message.added" || e.seq === undefined) return null;
    const p = e.payload;
    const m: ThreadMessage = { id: e.id, seq: e.seq, ts: e.ts, author: p.author, text: p.text, anchor: p.anchor ?? null, timing: p.timing ?? null };
    this.messages.push(m);
    if (e.device_id === STUDY_MODE_DEVICE) this.imported.add(e.id);
    return m;
  }

  private onAppended(fresh: Appended[]): void {
    for (const e of fresh) {
      if (e.type === "unit.reworded" && e.payload.by === "learner") {
        const p = e.payload;
        this.notes.push(`[app: the learner reworded unit ${p.unit_id}${p.text ? ` to "${p.text}"` : ""}${p.kind ? ` (kind ${p.kind})` : ""}. Their wording stands.]`);
      }
      if (e.type === "page.edited" && e.device_id !== TUTOR_DEVICE && e.device_id !== STUDY_MODE_DEVICE) this.paused(e.payload.page_id);
      const m = this.index(e);
      if (m?.author === "learner" && !this.imported.has(m.id)) this.kick("message");
    }
  }

  private unanswered(): ThreadMessage[] {
    return this.messages.filter((m) => m.author === "learner" && m.seq > this.answeredThrough && !this.imported.has(m.id));
  }

  /** Restarts a page's pause timer. When the learner stops editing for long enough, the observer looks. */
  private paused(pageId: string): void {
    if (this.closed) return;
    clearTimeout(this.timers.get(pageId));
    const t = setTimeout(() => {
      this.timers.delete(pageId);
      this.due.add(pageId);
      this.kick("observation");
    }, this.opts.observePauseMs ?? OBSERVE_PAUSE_MS);
    t.unref?.();
    this.timers.set(pageId, t);
  }

  private kick(t: Trigger): void {
    if (this.closed) return;
    this.pending.add(t);
    if (this.busy) return;
    this.busy = this.loop().finally(() => {
      this.busy = null;
    });
  }

  private async loop(): Promise<void> {
    // Yield once so a batch of appends lands before the first turn reads them.
    await Promise.resolve();
    while (this.pending.size > 0 && !this.closed) {
      const triggers = new Set(this.pending);
      this.pending.clear();
      try {
        await this.turn(triggers);
      } catch (e) {
        this.log(`tutor turn failed for ${this.userId}: ${e instanceof Error ? e.message : String(e)}`);
        this.endSitting();
      }
    }
  }

  private async turn(triggers: Set<Trigger>): Promise<void> {
    if (triggers.has("message") || triggers.has("greeting")) await this.reply(triggers);
    if (this.due.size > 0) await this.observe();
  }

  private async reply(triggers: Set<Trigger>): Promise<void> {
    const now = this.now();
    const asked = this.unanswered();
    if (asked.length === 0 && !triggers.has("greeting")) return;
    // While a page is being worked on, a message in the thread may be the learner thinking aloud.
    if (asked.length > 0 && !triggers.has("greeting") && asked.every((m) => !m.anchor)) {
      const page = this.workingPage(now);
      if (page && (await this.thinkingAloud(page, asked))) return;
    }
    const session = await this.sitting(now, new Set(asked.map((m) => m.id)));
    const state = this.store.state;
    let prompt: string;
    if (asked.length > 0) {
      prompt = asked.map((m) => (m.anchor ? `[app: this is in an aside ${anchorLabel(state, m.anchor)}]\n${m.text}` : m.text)).join("\n\n");
    } else {
      const last = this.messages.at(-1);
      const opened = `[app: the learner just opened the app${last ? `; the last message was ${formatAgo(now - last.ts)}` : ""}. `;
      const probe = offerProbe(this.toolHost(), { kind: "greeting", seconds: 30, context: [] }, now);
      prompt = probe
        ? `${opened}Greet them in a few words, then open with one short probe before anything else. ${describeProbe(probe, this.store.state)} ` +
          "Once it is graded, ask what they want to work on now, toward their goal if they have one.]"
        : `${opened}Greet them in one short line, then ask what they want to work on now, toward their goal if they have one. One question.]`;
    }
    const notes = [...this.notes, ...this.pageNotes(now)];
    this.notes = [];
    if (notes.length > 0) prompt = `${notes.join("\n")}\n\n${prompt}`;

    // A reply to a message in an aside stays in that aside.
    const lastAsked = asked.at(-1);
    const anchor = lastAsked?.anchor ? this.carry(lastAsked.anchor) : null;
    const draft: Draft = { id: uuidv7(now), text: "", done: false, anchor };
    const info: TurnInfo = { replyId: draft.id, answer: asked[0] ?? null, cards: [] };
    this.turnInfo = info;
    this.current = draft;
    this.emit(draft);

    let separate = false;
    const off = session.subscribe((ev) => {
      if (ev.type === "message_start" && ev.message.role === "assistant") separate = draft.text.length > 0;
      if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
        let d = ev.assistantMessageEvent.delta;
        if (draft.text === "") d = d.trimStart();
        else if (separate && d.trim()) {
          d = `\n\n${d.trimStart()}`;
          separate = false;
        }
        if (!d) return;
        draft.text += d;
        this.emit(draft);
      }
    });

    let error: string | null = null;
    try {
      await session.prompt(prompt);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      off();
      this.turnInfo = null;
    }
    const last = session.messages.findLast((m) => m.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
    if (!error && (last?.stopReason === "error" || last?.stopReason === "aborted")) error = last.errorMessage ?? last.stopReason;

    this.current = null;
    if (error) {
      this.log(`tutor could not answer ${this.userId}: ${error}`);
      this.endSitting();
      // Units already recorded in this turn still get their cards.
      if (info.cards.length > 0) this.post(draft.id, "", info.cards, anchor);
      this.emit({ id: draft.id, text: "", done: true, anchor, error: "The tutor could not answer just now. Your message is kept, and it will answer when you next send." });
      return;
    }
    if (asked.length > 0) this.answeredThrough = Math.max(this.answeredThrough, ...asked.map((m) => m.seq));
    this.lastTurnAt = this.now();
    // The tutor has seen the open page as it is now; the observer starts from here.
    const open = openPage(this.store.state, this.messages, now);
    if (open && this.seenRev.get(open.id) === open.rev) this.remember(open);
    const text = draft.text.trim();
    if (text || info.cards.length > 0) this.post(draft.id, text, info.cards, anchor);
    this.emit({ id: draft.id, text, done: true, anchor });
  }

  /** The session for this sitting. A new sitting starts after a long enough break. */
  private async sitting(now: number, exclude: Set<string>): Promise<AgentSession> {
    const last = Math.max(this.lastTurnAt, this.sittingSince);
    if (this.session && now - last < this.gap) return this.session;
    this.endSitting();

    const host = this.toolHost();
    const page = openPage(this.store.state, this.messages, now);
    if (page) this.seenRev.set(page.id, page.rev);
    const context = buildSittingContext({
      name: this.nameOf(),
      now,
      state: this.store.state,
      tail: tailOf(this.messages.filter((m) => !exclude.has(m.id))),
      timeZone: this.opts.timeZone,
      scheduler: this.store.scheduler,
      page,
    });
    mkdirSync(this.opts.agentDir, { recursive: true });
    const loader = new DefaultResourceLoader({
      cwd: this.opts.agentDir,
      agentDir: this.opts.agentDir,
      extensionFactories: [
        (pi) => {
          for (const t of tutorTools(host)) pi.registerTool(t);
        },
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: this.opts.systemPrompt + APP_NOTE,
      appendSystemPrompt: [context],
    });
    await loader.reload();
    const { runtime, model } = await this.opts.model(this.userId);
    const retry = this.opts.retry ?? true;
    const { session } = await createAgentSession({
      cwd: this.opts.agentDir,
      agentDir: this.opts.agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: this.opts.thinkingLevel ?? "low",
      noTools: "builtin",
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(this.opts.agentDir),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: retry, maxRetries: 2, baseDelayMs: 1500 } }),
    });
    this.session = session;
    this.sittingSince = now;
    return session;
  }

  // --- The quiet observer --------------------------------------------------------------------

  /** The page the learner is writing on now, if any: the open page, edited by the learner recently. */
  private workingPage(now: number): PageState | null {
    const page = openPage(this.store.state, this.messages, now);
    return page && page.rev > 0 && now - page.edited_at < WORKING_MS ? page : null;
  }

  /**
   * Messages sent in the thread while a page is being worked on. If triage finds none of them
   * addressed to the tutor, they are thinking aloud: no reply, unless they show a real flaw.
   * Returns false when they should be answered as usual, which is also the answer when triage fails.
   */
  private async thinkingAloud(page: PageState, asked: ThreadMessage[]): Promise<boolean> {
    const said = asked.map((m) => m.text);
    const v = await this.triage(page, said);
    if (!v || v.addressed !== false) return false;
    this.answeredThrough = Math.max(this.answeredThrough, ...asked.map((m) => m.seq));
    if (v.raise) await this.observation(page, v, said);
    else this.notes.push(`[app: while working on the page, the learner thought aloud in the thread:\n${said.map((s) => `"${s}"`).join("\n")}\nNo reply was needed.]`);
    return true;
  }

  /** Looks at each page whose pause ran out, if it changed since the last look. */
  private async observe(): Promise<void> {
    const ids = [...this.due];
    this.due.clear();
    for (const id of ids) {
      const page = this.store.state.pages[id];
      // Edited again since: the next pause will bring it back.
      if (!page || this.timers.has(id)) continue;
      const seen = this.looked.get(id);
      if (seen?.rev === page.rev) continue;
      if (changedLines(page, seen?.lines ?? null).length === 0) {
        this.remember(page);
        continue;
      }
      const v = await this.triage(page, []);
      if (v?.raise) await this.observation(page, v, []);
    }
  }

  private remember(page: PageState): void {
    this.looked.set(page.id, { rev: page.rev, lines: pageLines(page).map((l) => l.text) });
  }

  /** One cheap call: is anything on the page, or in what the learner said, worth interrupting for? Null if it failed. */
  private async triage(page: PageState, said: readonly string[]): Promise<Verdict | null> {
    const prompt = triagePrompt({
      page,
      before: this.looked.get(page.id)?.lines ?? null,
      messages: this.messages,
      pages: this.store.state.pages,
      said,
      lastTutor: this.messages.findLast((m) => m.author === "tutor" && !m.anchor)?.text ?? null,
    });
    this.remember(page);
    const level = this.opts.thinkingLevel ?? "low";
    try {
      const { runtime, model } = await (this.opts.triageModel ?? this.opts.model)(this.userId);
      const res = await runtime.completeSimple(
        model,
        { systemPrompt: TRIAGE_SYSTEM, messages: [{ role: "user", content: prompt, timestamp: this.now() }] },
        level === "off" ? {} : { reasoning: level as never },
      );
      if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage ?? res.stopReason);
      const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      const v = parseVerdict(text);
      if (!v) throw new Error(`no verdict in ${JSON.stringify(text.slice(0, 200))}`);
      this.log(`observer: page ${page.id} rev ${page.rev}${said.length ? `, ${said.length} said` : ""}: ${JSON.stringify(v)}`);
      return v;
    } catch (e) {
      this.log(`observer triage failed for ${this.userId}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * A tutor turn nobody asked for. It shows no draft, and its text is not posted: it speaks through
   * open_aside or not at all. The one exception is a flaw only in what the learner said aloud, which
   * gets a short question in the thread.
   */
  private async observation(page: PageState, v: Verdict, said: readonly string[]): Promise<void> {
    const now = this.now();
    const session = await this.sitting(now, new Set());
    let prompt = observationPrompt(page, v, said);
    const notes = [...this.notes, ...this.pageNotes(now, page)];
    this.notes = [];
    if (notes.length > 0) prompt = `${notes.join("\n")}\n\n${prompt}`;

    const info: TurnInfo = { replyId: uuidv7(now), answer: null, cards: [] };
    this.turnInfo = info;
    const before = this.messages.length;
    let text = "";
    const off = session.subscribe((ev) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") text += ev.assistantMessageEvent.delta;
    });
    let error: string | null = null;
    try {
      await session.prompt(prompt);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      off();
      this.turnInfo = null;
    }
    const last = session.messages.findLast((m) => m.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
    if (!error && (last?.stopReason === "error" || last?.stopReason === "aborted")) error = last.errorMessage ?? last.stopReason;
    if (error) {
      this.log(`observation failed for ${this.userId}: ${error}`);
      this.endSitting();
      return;
    }
    this.lastTurnAt = this.now();
    this.remember(this.store.state.pages[page.id] ?? page);
    const aside = this.messages.slice(before).some((m) => m.author === "tutor" && m.anchor);
    text = text.trim();
    if (text && said.length > 0 && !aside) this.post(info.replyId, text, info.cards);
    else {
      if (text) this.log(`observation text not posted: ${JSON.stringify(text.slice(0, 200))}`);
      if (info.cards.length > 0) this.post(info.replyId, "", info.cards);
    }
  }

  /** The open page again when it changed since the tutor last read it. */
  private pageNotes(now: number, page = openPage(this.store.state, this.messages, now)): string[] {
    if (!page || this.seenRev.get(page.id) === page.rev) return [];
    const changed = this.seenRev.has(page.id);
    this.seenRev.set(page.id, page.rev);
    return [`[app: the open page ${changed ? "now reads" : "reads"}:\n${pageText(page)}]`];
  }

  /** An anchor carried to the page's current revision. The quote stays as first written. */
  private carry(a: Anchor): Anchor {
    const page = this.store.state.pages[a.page_id];
    const r = page ? mapRange(page, a.rev, a.from, a.to) : null;
    return page && r ? { ...a, rev: page.rev, from: r.from, to: r.to } : a;
  }

  private endSitting(): void {
    this.seenRev.clear();
    const s = this.session;
    this.session = null;
    if (!s) return;
    void s.abort().catch(() => {});
    s.dispose();
  }

  private toolHost(): ToolHost {
    const store = this.store;
    return {
      get state() {
        return store.state;
      },
      scheduler: store.scheduler,
      messages: () => this.messages,
      append: (type, payload) => this.write(type, payload) as never,
      now: this.now,
      timeZone: this.opts.timeZone,
      // A tool called outside a turn has nowhere to put a card; it gets a throwaway list.
      turn: () => this.turnInfo ?? { replyId: uuidv7(this.now()), answer: null, cards: [] },
      offers: this.offers,
    };
  }

  private write(type: EventType, payload: unknown, id = uuidv7(this.now())): MyelinEvent {
    const e = makeEvent(type, payload as never, { id, device_id: TUTOR_DEVICE, ts: this.now() });
    this.store.append([e]);
    return e as MyelinEvent;
  }

  private post(id: string, text: string, cards: Card[] = [], anchor: Anchor | null = null): void {
    this.write("message.added", { author: "tutor", text, cards, anchor, timing: null }, id);
  }

  private emit(d: Draft): void {
    const copy = { ...d };
    for (const fn of this.listeners) fn(copy);
  }

  private log(msg: string): void {
    (this.opts.log ?? console.error)(msg);
  }
}

/** One tutor per learner, made when the learner's store is first used. */
export class Tutors {
  private open = new Map<string, Tutor>();

  constructor(
    private readonly stores: Stores,
    private readonly opts: TutorOptions,
    private readonly nameOf: (userId: string) => string,
  ) {}

  get(userId: string): Tutor {
    let t = this.open.get(userId);
    if (!t) {
      t = new Tutor(userId, () => this.nameOf(userId), this.stores.get(userId), this.opts);
      this.open.set(userId, t);
    }
    return t;
  }

  close(): void {
    for (const t of this.open.values()) t.close();
    this.open.clear();
  }
}

/** The model named by a spec like "google/gemini-4-neon", with the host's key. */
export async function hostModel(opts: { spec: string; apiKey: string; agentDir: string }): Promise<ModelSource> {
  const [provider, ...rest] = opts.spec.split("/");
  const id = rest.join("/");
  if (!provider || !id) throw new Error(`MYELIN_MODEL should look like provider/model, not ${opts.spec}`);
  mkdirSync(opts.agentDir, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(opts.agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  await runtime.setRuntimeApiKey(provider, opts.apiKey);
  const model = runtime.getModel(provider, id);
  if (!model) throw new Error(`Pi does not know the model ${opts.spec}`);
  return async () => ({ runtime, model });
}

/** The environment variable that holds a provider's key. */
export function keyEnvFor(provider: string): string {
  if (provider === "google") return "GEMINI_API_KEY";
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}
