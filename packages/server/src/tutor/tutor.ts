// The tutor: a Pi agent per learner, one session per sitting. It answers learner messages, greets a
// learner who opens the app after a break, and streams its reply as a draft while it writes.
// The reply becomes a message.added event when the turn ends; the draft itself is never stored.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeEvent, STUDY_MODE_DEVICE, uuidv7, type EventType, type MyelinEvent } from "@myelin/core";
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
import { buildSittingContext, formatAgo, tailOf, type ThreadMessage } from "./context.js";
import { tutorTools, type ToolHost } from "./tools.js";

/** The device id on everything the tutor writes. */
export const TUTOR_DEVICE = "server:tutor";
export const FIRST_RUN_TEXT = "What do you want to learn, and is there a date you are working toward?";
export const SITTING_GAP_MS = 30 * 60_000;

export interface Draft {
  id: string;
  text: string;
  done: boolean;
  error?: string;
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
}

const APP_NOTE = `

# Notes from the app

Text in square brackets that starts with "app:" comes from the app, not from the learner. Everything else in a user turn is what the learner wrote. Your reply is posted to the thread as one message when you finish. If nothing needs saying, call stay_quiet and write nothing.`;

type Trigger = "message" | "greeting";

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
    this.unsubscribe();
    this.endSitting();
  }

  // -------------------------------------------------------------------------------------------

  private index(e: MyelinEvent & { seq?: number }): ThreadMessage | null {
    if (e.type !== "message.added" || e.seq === undefined) return null;
    const p = e.payload;
    const m: ThreadMessage = { id: e.id, seq: e.seq, ts: e.ts, author: p.author, text: p.text };
    this.messages.push(m);
    if (e.device_id === STUDY_MODE_DEVICE) this.imported.add(e.id);
    return m;
  }

  private onAppended(fresh: Appended[]): void {
    for (const e of fresh) {
      const m = this.index(e);
      if (m?.author === "learner" && !this.imported.has(m.id)) this.kick("message");
    }
  }

  private unanswered(): ThreadMessage[] {
    return this.messages.filter((m) => m.author === "learner" && m.seq > this.answeredThrough && !this.imported.has(m.id));
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
    const now = this.now();
    const asked = this.unanswered();
    let prompt: string;
    if (asked.length > 0) {
      prompt = asked.map((m) => m.text).join("\n\n");
    } else if (triggers.has("greeting")) {
      const last = this.messages.at(-1);
      prompt =
        `[app: the learner just opened the app${last ? `; the last message was ${formatAgo(now - last.ts)}` : ""}. ` +
        "Greet them in one short line, then ask what they want to work on now, toward their goal if they have one. One question.]";
    } else {
      return;
    }

    const session = await this.sitting(now, new Set(asked.map((m) => m.id)));
    const draft: Draft = { id: uuidv7(now), text: "", done: false };
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
    }
    const last = session.messages.findLast((m) => m.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
    if (!error && (last?.stopReason === "error" || last?.stopReason === "aborted")) error = last.errorMessage ?? last.stopReason;

    this.current = null;
    if (error) {
      this.log(`tutor could not answer ${this.userId}: ${error}`);
      this.endSitting();
      this.emit({ id: draft.id, text: "", done: true, error: "The tutor could not answer just now. Your message is kept, and it will answer when you next send." });
      return;
    }
    if (asked.length > 0) this.answeredThrough = Math.max(this.answeredThrough, ...asked.map((m) => m.seq));
    this.lastTurnAt = this.now();
    const text = draft.text.trim();
    if (text) this.post(draft.id, text);
    this.emit({ id: draft.id, text, done: true });
  }

  /** The session for this sitting. A new sitting starts after a long enough break. */
  private async sitting(now: number, exclude: Set<string>): Promise<AgentSession> {
    const last = Math.max(this.lastTurnAt, this.sittingSince);
    if (this.session && now - last < this.gap) return this.session;
    this.endSitting();

    const host = this.toolHost();
    const context = buildSittingContext({
      name: this.nameOf(),
      now,
      state: this.store.state,
      tail: tailOf(this.messages.filter((m) => !exclude.has(m.id))),
      timeZone: this.opts.timeZone,
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

  private endSitting(): void {
    const s = this.session;
    this.session = null;
    if (!s) return;
    void s.abort().catch(() => {});
    s.dispose();
  }

  private toolHost(): ToolHost {
    return {
      state: this.store.state,
      messages: () => this.messages,
      append: (type, payload) => this.write(type, payload) as never,
      now: this.now,
      timeZone: this.opts.timeZone,
    };
  }

  private write(type: EventType, payload: unknown, id = uuidv7(this.now())): MyelinEvent {
    const e = makeEvent(type, payload as never, { id, device_id: TUTOR_DEVICE, ts: this.now() });
    this.store.append([e]);
    return e as MyelinEvent;
  }

  private post(id: string, text: string): void {
    this.write("message.added", { author: "tutor", text, cards: [], anchor: null, timing: null }, id);
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

/** The model named by a spec like "google/gemini-flash-latest", with the host's key. */
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
