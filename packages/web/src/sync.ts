// The client's link to the record: sign-in, the event stream, and appending events. It holds no
// state beyond what the server sent, and has no outbox: a send that cannot reach the server fails,
// and the caller keeps the draft. Framework-neutral; the UI subscribes to changes.
import { makeEvent, uuidv7, type EventOf, type EventType, type MyelinEvent } from "@myelin/core";

export type Ev = MyelinEvent & { seq: number };
export interface Me {
  user: { id: string; name: string };
  device_id: string;
  head?: number;
}

/** The tutor's reply while it is being written. It is never stored; the finished reply arrives as a message with the same id. */
export interface Draft {
  id: string;
  text: string;
  done: boolean;
  error?: string;
}

export class SignInError extends Error {}
export class SendError extends Error {}

async function json<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new SendError(body.error ?? `HTTP ${r.status}`);
  return body;
}

export async function me(): Promise<Me | null> {
  const r = await fetch("/api/me", { credentials: "same-origin" });
  if (r.status === 401) return null;
  return json<Me>(r);
}

/** Spends a login link (or its token). The server sets this device's cookie. */
export async function login(link: string): Promise<Me> {
  const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: link }) });
  if (r.status === 401) throw new SignInError(((await r.json()) as { error: string }).error);
  return json<Me>(r);
}

type Listener = () => void;

export class Sync {
  readonly events: Ev[] = [];
  /** True once the backlog has arrived. */
  ready = false;
  connected = false;
  /** True after the connection dropped, until it is back. */
  lost = false;
  signedOut = false;
  /** The tutor's reply in progress. */
  reply: Draft | null = null;
  /** A one-off line from the tutor's side, such as a failed reply. It is not part of the record. */
  notice: string | null = null;
  private source: EventSource | null = null;
  private listeners = new Set<Listener>();
  private ids = new Set<string>();

  constructor(readonly session: Me) {}

  get head(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  start(): void {
    if (this.source) return;
    // EventSource reconnects by itself and sends Last-Event-ID, so the server resumes after the last seq.
    const es = new EventSource(`/api/stream?after=${this.head}`);
    this.source = es;
    es.addEventListener("open", () => {
      this.connected = true;
      this.lost = false;
      this.changed();
    });
    es.addEventListener("event", (m) => {
      const e = JSON.parse((m as MessageEvent<string>).data) as Ev;
      if (e.seq <= this.head || this.ids.has(e.id)) return;
      this.ids.add(e.id);
      this.events.push(e);
      if (this.reply?.id === e.id) this.reply = null;
      if (e.type === "message.added") this.notice = null;
      this.changed();
    });
    es.addEventListener("tutor", (m) => {
      const d = JSON.parse((m as MessageEvent<string>).data) as Draft;
      if (d.done) {
        if (this.reply?.id === d.id || !this.reply) this.reply = null;
        if (d.error) this.notice = d.error;
      } else if (!this.ids.has(d.id)) {
        this.reply = d;
        this.notice = null;
      }
      this.changed();
    });
    es.addEventListener("ready", () => {
      this.ready = true;
      this.changed();
    });
    es.addEventListener("error", () => {
      this.connected = false;
      this.lost = true;
      // The server sends the reply in progress again on reconnect.
      this.reply = null;
      this.changed();
      // A closed source will not retry: the cookie is gone, or the server refused the stream.
      if (es.readyState === EventSource.CLOSED) void this.recover();
    });
  }

  private async recover(): Promise<void> {
    this.source = null;
    try {
      if ((await me()) === null) {
        this.signedOut = true;
        this.changed();
        return;
      }
    } catch {
      /* server unreachable: try again shortly */
    }
    setTimeout(() => this.start(), 2000);
  }

  stop(): void {
    this.source?.close();
    this.source = null;
    this.connected = false;
  }

  /**
   * Appends one event. The id is made here, so a retry after a dropped response cannot duplicate it.
   * Resolves once the server has stored it; the event itself arrives over the stream.
   */
  async append<T extends EventType>(type: T, payload: Parameters<typeof makeEvent<T>>[1], attempts = 3): Promise<EventOf<T>> {
    const event = makeEvent(type, payload, { id: uuidv7(), device_id: this.session.device_id, ts: Date.now() });
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [event] }) });
        await json(r);
        return event;
      } catch (e) {
        if (e instanceof SendError) throw e; // the server answered: retrying will not help
        lastError = e;
        await new Promise((r) => setTimeout(r, 300 * 2 ** i));
      }
    }
    throw new SendError(`not sent: ${String(lastError)}`);
  }
}

/** The unsent draft is the one thing kept on the device. */
export const draft = {
  get(key = "thread"): string {
    try {
      return localStorage.getItem(`myelin:draft:${key}`) ?? "";
    } catch {
      return "";
    }
  },
  set(value: string, key = "thread"): void {
    try {
      if (value) localStorage.setItem(`myelin:draft:${key}`, value);
      else localStorage.removeItem(`myelin:draft:${key}`);
    } catch {
      /* storage unavailable */
    }
  },
};
