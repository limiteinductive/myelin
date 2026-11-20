// The events API: sign-in with one-time links, append and read events, and a Server-Sent Events
// stream that keeps every open device in step.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { EventError } from "@myelin/core";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { RegistryError, type Device, type Registry, type User } from "./registry.js";
import { ConflictError, type Appended } from "./store.js";
import type { Stores } from "./stores.js";
import type { Draft, Tutors } from "./tutor/tutor.js";

export const COOKIE = "myelin_device";
const COOKIE_MAX_AGE = 400 * 24 * 3600; // the longest browsers allow
const HEARTBEAT_MS = 20_000;
const PAGE = 2_000;

export interface AppOptions {
  registry: Registry;
  stores: Stores;
  /** The built web app. Without it the server answers the API only. */
  webRoot?: string | undefined;
  /** The tutor. Without it the thread is the learner's alone. */
  tutors?: Tutors | undefined;
}

type Session = { user: User; device: Device };
type Env = { Variables: { session: Session } };

/** Event types a device may append. Everything else is written by the server's tutor. */
export function clientMayWrite(e: { type?: unknown; payload?: unknown }): boolean {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "message.added":
      return p.author === "learner";
    case "unit.reworded":
      return p.by === "learner";
    case "page.created":
    case "page.edited":
    case "activity.signal":
      return true;
    default:
      return false;
  }
}

const isHttps = (c: Context) => (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")) === "https";

export function createApp({ registry, stores, webRoot, tutors }: AppOptions): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    await next();
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
  });

  // Writes must come from this origin as JSON. With a SameSite=Strict cookie this rules out CSRF.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET") {
      const origin = c.req.header("origin");
      if (origin && new URL(origin).host !== c.req.header("host")) return c.json({ error: "cross-origin request" }, 403);
      if (!c.req.header("content-type")?.startsWith("application/json")) return c.json({ error: "send JSON" }, 415);
    }
    await next();
  });
  app.use("/api/*", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "request too large" }, 413) }));

  app.post("/api/login", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const raw = typeof body?.token === "string" ? body.token.trim() : "";
    // Accept a pasted link as well as a bare token.
    const token = raw.match(/\/login\/([A-Za-z0-9_-]+)/)?.[1] ?? raw;
    try {
      const { user, device, deviceToken } = registry.redeemLink(token, c.req.header("user-agent") ?? null);
      setCookie(c, COOKIE, deviceToken, { httpOnly: true, sameSite: "Strict", secure: isHttps(c), path: "/", maxAge: COOKIE_MAX_AGE });
      return c.json({ user: { id: user.id, name: user.name }, device_id: device.id });
    } catch (e) {
      if (e instanceof RegistryError) return c.json({ error: "That link has already been used or is not valid." }, 401);
      throw e;
    }
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/login") return next();
    const token = getCookie(c, COOKIE);
    const session = token ? registry.authenticate(token) : null;
    if (!session) {
      if (token) deleteCookie(c, COOKIE, { path: "/" });
      return c.json({ error: "not signed in" }, 401);
    }
    c.set("session", session);
    await next();
  });

  app.get("/api/me", (c) => {
    const { user, device } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    return c.json({ user: { id: user.id, name: user.name }, device_id: device.id, head: store.head });
  });

  app.get("/api/events", (c) => {
    const { user } = c.get("session");
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
    const limit = Math.min(PAGE, Math.max(1, Number(c.req.query("limit") ?? PAGE) || PAGE));
    const store = stores.get(user.id);
    store.catchUp();
    return c.json({ events: store.read(after, limit), head: store.head });
  });

  app.post("/api/events", async (c) => {
    const { user, device } = c.get("session");
    const body = (await c.req.json().catch(() => null)) as { events?: unknown } | null;
    const events = body?.events;
    if (!Array.isArray(events) || events.length === 0 || events.length > 500) return c.json({ error: "send {events: [...]}, 1 to 500" }, 400);
    for (const [i, e] of events.entries()) {
      if (typeof e !== "object" || e === null) return c.json({ error: `event ${i}: not an object` }, 400);
      const ev = e as { device_id?: unknown; type?: unknown };
      if (ev.device_id !== device.id) return c.json({ error: `event ${i}: device_id must be this device` }, 400);
      if (!clientMayWrite(ev)) return c.json({ error: `event ${i}: a device may not append ${String(ev.type)}` }, 403);
    }
    try {
      return c.json({ results: stores.get(user.id).append(events) });
    } catch (e) {
      if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
      if (e instanceof EventError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // Every event after `after` (or Last-Event-ID), then each new one as it is appended.
  // The SSE id is the event's seq, so a reconnecting EventSource resumes where it stopped.
  app.get("/api/stream", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    const after = Math.max(0, Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0);
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    const tutor = tutors?.get(user.id);
    return streamSSE(c, async (stream) => {
      // Stored events, and the tutor's reply while it is being written. A draft is never stored;
      // the finished reply arrives as an ordinary message.added with the draft's id.
      type Item = { kind: "event"; e: Appended } | { kind: "draft"; d: Draft };
      const queue: Item[] = [];
      let wake: (() => void) | null = null;
      const nudge = () => {
        wake?.();
        wake = null;
      };
      // Subscribe and read the backlog in the same tick, so nothing appended in between is missed.
      store.catchUp();
      const unsubscribe = store.subscribe((fresh) => {
        for (const e of fresh) queue.push({ kind: "event", e });
        nudge();
      });
      let undraft = () => {};
      stream.onAbort(() => {
        unsubscribe();
        undraft();
        nudge();
      });
      let last = after;
      let backlog = store.read(last, PAGE);
      while (backlog.length > 0 && !stream.aborted) {
        for (const e of backlog) {
          await stream.writeSSE({ id: String(e.seq), event: "event", data: JSON.stringify(e) });
          last = e.seq;
        }
        backlog = backlog.length === PAGE ? store.read(last, PAGE) : [];
      }
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ head: last }) });
      if (tutor && !stream.aborted) {
        const pushDraft = (d: Draft) => {
          // A slow reader gets the latest text, not every delta.
          const prev = queue.at(-1);
          if (prev?.kind === "draft" && prev.d.id === d.id && !prev.d.done) queue[queue.length - 1] = { kind: "draft", d };
          else queue.push({ kind: "draft", d });
          nudge();
        };
        undraft = tutor.onDraft(pushDraft);
        if (tutor.draft) pushDraft({ ...tutor.draft });
        tutor.opened();
      }
      try {
        while (!stream.aborted) {
          while (queue.length > 0 && !stream.aborted) {
            const item = queue.shift()!;
            if (item.kind === "draft") {
              await stream.writeSSE({ event: "tutor", data: JSON.stringify(item.d) });
              continue;
            }
            const e = item.e;
            if (e.seq <= last) continue;
            await stream.writeSSE({ id: String(e.seq), event: "event", data: JSON.stringify(e) });
            last = e.seq;
          }
          if (stream.aborted) break;
          const timedOut = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => resolve(true), HEARTBEAT_MS);
            wake = () => {
              clearTimeout(t);
              resolve(false);
            };
          });
          if (timedOut && !stream.aborted) await stream.write(": heartbeat\n\n");
        }
      } finally {
        unsubscribe();
        undraft();
      }
    });
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (webRoot && existsSync(join(webRoot, "index.html"))) {
    const index = readFileSync(join(webRoot, "index.html"), "utf8");
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
    });
    app.use("*", serveStatic({ root: webRoot }));
    // Everything else is the app. /login/<token> lands here too: the page spends the token with a
    // POST, so a link preview that fetches the URL cannot use it up.
    app.get("*", (c) => {
      c.header("Cache-Control", "no-cache");
      return c.html(index);
    });
  }

  return app;
}
