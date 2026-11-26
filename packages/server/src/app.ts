// The events API: sign-in with one-time links, append and read events, and a Server-Sent Events
// stream that keeps every open device in step.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { codeBlocks, EventError, makeEvent, PhotoCard, resolveUnit, uuidv7, type Depth, type Grade, type State, type Unit } from "@myelin/core";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { FileError, type Files } from "./files.js";
import { FrontierStore, type Frontier } from "./frontiers.js";
import { FastJudge } from "./judge.js";
import { formatServerTiming, PerfLog, type PerfOp, type PerfRecord } from "./perf.js";
import { RegistryError, type Device, type Registry, type User } from "./registry.js";
import {
  computeCalibratedIntervals,
  pickDrillDepth,
  pickRepModality,
  pickSynthesisCluster,
  RwkvInstantEngine,
  unitExposureStats,
  type RepModality,
  type RwkvUnitScore,
} from "./rwkv.js";
import type { Sandbox } from "./sandbox.js";
import {
  ConflictError,
  StaleError,
  type AgentMemoryRecord,
  type Appended,
  type BriefingRecord,
  type DreamLogRecord,
  type ExplorationRecord,
} from "./store.js";
import type { Stores } from "./stores.js";
import { KeyRejected, type ModelKeys } from "./tutor/keys.js";
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
  /** Runs the code on pages. Without it Run page is refused. */
  sandbox?: Sandbox | undefined;
  /** Whose model key each tutor uses. With it a friend is asked for their own key. */
  keys?: ModelKeys | undefined;
  /** Where photos are kept. Without it a photo is refused. */
  files?: Files | undefined;
  /** Local RWKV-Instant memory engine (sm72e25). Falls back to FSRS when absent. */
  rwkv?: RwkvInstantEngine | null | undefined;
  /** Fast System 1 (Jev) -> System 2 (LLM) cascade judge for live micro-production reps. */
  judge?: FastJudge | undefined;
  /** Optional passive latency log (`perf.jsonl`). */
  perf?: PerfLog | undefined;
  /** Optional data directory for persisting chapter/source frontiers. */
  dataDir?: string | undefined;
}

/** The device recorded on a page.ran event: the server ran the code. */
export const SANDBOX_DEVICE = "server:sandbox";
/** The device recorded on fast drill probes and learner-created units. */
export const DRILL_DEVICE = "server:drill";

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
      // Only the tutor opens a page for a probe.
      return p.probe === undefined || p.probe === null;
    case "page.edited":
    case "activity.signal":
      return true;
    default:
      return false;
  }
}

/** Why a learner's message names a photo the server cannot show, or null if every photo is kept. */
export function missingPhoto(e: { type?: unknown; payload?: unknown }, kept: (id: string, mime: PhotoCard["mime"]) => boolean): string | null {
  if (e.type !== "message.added") return null;
  const cards = (e.payload as { cards?: unknown } | null)?.cards;
  if (!Array.isArray(cards)) return null;
  for (const card of cards) {
    if ((card as { kind?: unknown } | null)?.kind !== "photo") continue;
    const p = PhotoCard.safeParse(card);
    // A malformed card is refused by the event schema with its own reason.
    if (p.success && !kept(p.data.file, p.data.mime)) return "send the photo before the message that shows it";
  }
  return null;
}

const isHttps = (c: Context) => (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")) === "https";

export function createApp({ registry, stores, webRoot, tutors, sandbox, keys, files, rwkv, judge = new FastJudge(), perf, dataDir }: AppOptions): Hono<Env> {
  const app = new Hono<Env>();
  const perfLog = perf ?? (dataDir ? new PerfLog(join(dataDir, "perf.jsonl")) : undefined);
  const frontiers = new FrontierStore(dataDir ? join(dataDir, "frontiers.json") : undefined);
  const dreamingUsers = new Set<string>();
  const idleDreamTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const AUTO_DREAM_IDLE_MS = 10 * 60_000;
  const AUTO_DREAM_MIN_EVENTS = 3;

  const learnerMemoryOf = (store: ReturnType<Stores["get"]>): string | undefined => {
    const content = store.getAgentMemory("learner")?.content.trim();
    return content || undefined;
  };

  const countMeaningfulEventsSince = (store: ReturnType<Stores["get"]>, afterSeq: number): number => {
    const evs = store.read(afterSeq, 500);
    return evs.filter(
      (e) =>
        e.type === "unit.probed" ||
        e.type === "unit.found" ||
        e.type === "unit.reworded" ||
        e.type === "unit.observed",
    ).length;
  };

  async function runDreamForUser(
    userId: string,
    store: ReturnType<Stores["get"]>,
    opts: { force?: boolean } = {},
  ): Promise<{ memory: AgentMemoryRecord; log: DreamLogRecord | null; skipped?: boolean }> {
    store.catchUp();
    const existing = store.getAgentMemory("learner");
    const fromSeq = existing?.last_dream_seq ?? 0;
    const toSeq = store.head;
    const sinceAt = existing?.last_dream_at ?? 0;

    if (dreamingUsers.has(userId)) {
      return {
        memory: existing ?? {
          key: "learner",
          content: "",
          last_dream_seq: 0,
          last_dream_at: 0,
          dream_count: 0,
          updated_at: 0,
          updated_by: "dream",
        },
        log: null,
        skipped: true,
      };
    }

    const pendingCount = countMeaningfulEventsSince(store, fromSeq);
    const recentExplorations = store
      .listExplorations(true)
      .filter((e) => (opts.force ? true : e.updated_at >= sinceAt))
      .slice(0, 6);
    if (!opts.force && pendingCount < AUTO_DREAM_MIN_EVENTS && recentExplorations.length === 0) {
      return {
        memory: existing ?? {
          key: "learner",
          content: "",
          last_dream_seq: fromSeq,
          last_dream_at: sinceAt,
          dream_count: 0,
          updated_at: 0,
          updated_by: "dream",
        },
        log: null,
        skipped: true,
      };
    }

    dreamingUsers.add(userId);
    try {
      const now = Date.now();
      const state = store.state;
      const { scores } = scoreAll(state, store.scheduler, now);
      const activeUnits = Object.values(state.units).filter((u) => u.status === "active" && !u.observe_only);

      const masteredUnits = activeUnits
        .map((u) => ({ u, s: scores.get(u.id) }))
        .filter(({ s }) => (s?.reviews ?? 0) >= 2 && (s?.p_imm ?? 0) >= 0.88)
        .sort((a, b) => (b.s?.p_imm ?? 0) - (a.s?.p_imm ?? 0))
        .slice(0, 25)
        .map(({ u, s }) => ({ text: u.text, topic: u.topic, p_imm: s?.p_imm ?? 0, reviews: s?.reviews ?? 0 }));

      const shakyUnits = activeUnits
        .map((u) => ({ u, s: scores.get(u.id) }))
        .filter(({ s }) => (s?.reviews ?? 0) > 0 && (s?.p_imm ?? 0) < 0.78)
        .sort((a, b) => (a.s?.p_imm ?? 0) - (b.s?.p_imm ?? 0))
        .slice(0, 20)
        .map(({ u, s }) => ({ text: u.text, topic: u.topic, p_imm: s?.p_imm ?? 0, reviews: s?.reviews ?? 0 }));

      const attempts = store.listRecentAttempts(opts.force ? 0 : sinceAt, 12).map((a) => ({
        prompt: a.prompt,
        unitText: state.units[a.unit_id]?.text ?? a.prompt,
        grade: a.grade,
        status: a.status,
        turns: a.turns.map((t) => ({ user: t.user, coach: t.coach })),
      }));

      const recentEvents = store.read(opts.force ? Math.max(0, toSeq - 400) : fromSeq, 400);
      const recentOverrides: { unitText: string; grade: string; note: string | null }[] = [];
      for (const ev of recentEvents) {
        if (ev.type === "unit.probed" && "corrects" in ev.payload) {
          recentOverrides.push({
            unitText: state.units[ev.payload.unit_id]?.text ?? ev.payload.unit_id,
            grade: ev.payload.grade,
            note: ev.payload.note ?? null,
          });
        }
      }

      const allUnitsCatalog = activeUnits.slice(0, 80).map((u) => {
        const s = scores.get(u.id);
        return {
          id: u.id,
          text: u.text,
          kind: u.kind,
          topic: u.topic,
          rests_on: u.rests_on,
          p_imm: s?.p_imm ?? 0,
          reviews: s?.reviews ?? 0,
        };
      });

      const dreamed = await judge.dream({
        currentMemory: existing?.content ?? "",
        updatedBy: existing?.updated_by ?? "dream",
        masteredUnits,
        shakyUnits,
        allUnits: allUnitsCatalog,
        recentAttempts: attempts,
        recentExplorations: recentExplorations.map((e) => ({
          title: e.title,
          turns: e.turns.map((t) => ({
            user: t.user,
            coach: t.coach,
            ...(t.added ? { added: t.added.map((u) => ({ text: u.text })) } : {}),
          })),
        })),
        recentOverrides,
      });

      // Conservative offline Map Compaction: apply validated merges, baseline retires, and missing DAG links.
      let mergedCount = 0;
      let retiredCount = 0;
      let linkedCount = 0;
      let evOffset = 1;
      const compactedIds = new Set<string>();

      for (const m of dreamed.merges ?? []) {
        const liveState = store.state;
        const keeper = resolveUnit(liveState, m.keep_id);
        if (!keeper || keeper.status !== "active" || keeper.observe_only || compactedIds.has(keeper.id)) continue;
        const validMerged = m.merge_ids
          .map((id) => resolveUnit(liveState, id))
          .filter((u): u is Unit => Boolean(u && u.status === "active" && !u.observe_only && u.id !== keeper.id && !compactedIds.has(u.id)))
          .map((u) => u.id);
        if (validMerged.length === 0) continue;
        const ev = makeEvent(
          "unit.merged",
          { unit_id: keeper.id, merged: validMerged, text: m.text?.trim() || null },
          { id: uuidv7(now + evOffset++), device_id: DRILL_DEVICE, ts: now + evOffset },
        );
        store.append([ev]);
        for (const id of validMerged) compactedIds.add(id);
        mergedCount += validMerged.length;
      }

      for (const rid of dreamed.retire_ids ?? []) {
        const liveState = store.state;
        const target = resolveUnit(liveState, rid);
        const s = target ? scores.get(target.id) : undefined;
        if (!target || target.status !== "active" || target.observe_only || compactedIds.has(target.id)) continue;
        // Safety rail: only auto-retire genuinely mastered baseline units.
        if ((s?.reviews ?? 0) < 3 || (s?.p_imm ?? 0) < 0.9) continue;
        const ev = makeEvent(
          "unit.retired",
          { unit_id: target.id, reason: "Retired by Dream compaction (mastered baseline)" },
          { id: uuidv7(now + evOffset++), device_id: DRILL_DEVICE, ts: now + evOffset },
        );
        store.append([ev]);
        compactedIds.add(target.id);
        retiredCount++;
      }

      const reaches = (st: State, fromId: string, targetId: string, seen = new Set<string>()): boolean => {
        if (fromId === targetId) return true;
        if (seen.has(fromId)) return false;
        seen.add(fromId);
        const cur = st.units[fromId];
        if (!cur) return false;
        return cur.rests_on.some((pid) => reaches(st, pid, targetId, seen));
      };

      for (const l of dreamed.links ?? []) {
        const liveState = store.state;
        const target = resolveUnit(liveState, l.unit_id);
        if (!target || target.status !== "active" || target.observe_only) continue;
        const nextRestsOn = new Set(target.rests_on);
        let addedAny = false;
        for (const pid of l.rests_on) {
          const p = resolveUnit(liveState, pid);
          if (!p || p.status !== "active" || p.observe_only || p.id === target.id) continue;
          if (nextRestsOn.has(p.id)) continue;
          if (reaches(liveState, p.id, target.id)) continue; // prevent DAG cycles
          nextRestsOn.add(p.id);
          addedAny = true;
        }
        if (!addedAny) continue;
        const ev = makeEvent(
          "unit.linked",
          { unit_id: target.id, rests_on: [...nextRestsOn] },
          { id: uuidv7(now + evOffset++), device_id: DRILL_DEVICE, ts: now + evOffset },
        );
        store.append([ev]);
        linkedCount++;
      }

      const compactNotes: string[] = [];
      if (mergedCount > 0) compactNotes.push(`merged ${mergedCount} duplicate${mergedCount === 1 ? "" : "s"}`);
      if (retiredCount > 0) compactNotes.push(`retired ${retiredCount} mastered`);
      if (linkedCount > 0) compactNotes.push(`linked ${linkedCount} prereq${linkedCount === 1 ? "" : "s"}`);
      const finalSummary =
        compactNotes.length > 0 ? `${dreamed.summary} (Compaction: ${compactNotes.join(", ")}.)` : dreamed.summary;

      const updated: AgentMemoryRecord = {
        key: "learner",
        content: dreamed.memory,
        last_dream_seq: store.head,
        last_dream_at: now,
        dream_count: (existing?.dream_count ?? 0) + 1,
        updated_at: now,
        updated_by: "dream",
      };
      store.saveAgentMemory(updated);

      const log: DreamLogRecord = {
        id: uuidv7(now),
        from_seq: fromSeq,
        to_seq: store.head,
        summary: finalSummary,
        promoted: dreamed.promoted,
        graduated: dreamed.graduated,
        created_at: now,
      };
      store.addDreamLog(log);
      return { memory: updated, log };
    } finally {
      dreamingUsers.delete(userId);
    }
  }

  function scheduleIdleDream(userId: string, store: ReturnType<Stores["get"]>): void {
    if (process.env.VITEST || process.env.MYELIN_AUTO_DREAM === "0" || !judge.enabled) return;
    const prev = idleDreamTimers.get(userId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      idleDreamTimers.delete(userId);
      void runDreamForUser(userId, store, { force: false }).catch((err) => {
        console.error("[dream] idle consolidation failed:", err instanceof Error ? err.message : err);
      });
    }, AUTO_DREAM_IDLE_MS);
    t.unref?.();
    idleDreamTimers.set(userId, t);
  }
  // The provider whose key the learner must paste before the tutor answers, or null.
  const needsKey = (userId: string) => (tutors && keys ? keys.needed(userId) : null);

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
      return c.json({ user: { id: user.id, name: user.name }, device_id: device.id, needs_key: needsKey(user.id) });
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
    return c.json({ user: { id: user.id, name: user.name }, device_id: device.id, head: store.head, needs_key: needsKey(user.id) });
  });

  // A friend's own model key, pasted once. It is checked with the provider, kept on the server and
  // never sent back.
  app.post("/api/key", async (c) => {
    const { user } = c.get("session");
    if (!tutors || !keys) return c.json({ error: "this server has no tutor" }, 404);
    const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
    if (typeof body?.key !== "string") return c.json({ error: "send {key: \"...\"}" }, 400);
    try {
      await keys.set(user.id, body.key);
    } catch (e) {
      if (e instanceof KeyRejected) return c.json({ error: e.message }, 400);
      throw e;
    }
    tutors.get(user.id).opened();
    return c.json({ needs_key: null });
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
      const missing = missingPhoto(e as { type?: unknown; payload?: unknown }, (id, mime) => files?.has(user.id, id, mime) ?? false);
      if (missing) return c.json({ error: `event ${i}: ${missing}` }, 400);
    }
    try {
      return c.json({ results: stores.get(user.id).append(events) });
    } catch (e) {
      if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
      if (e instanceof StaleError) return c.json({ error: e.message, stale: true }, 409);
      if (e instanceof EventError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // A photo of the learner's work. It is kept first, then named by hash in the message that sends it.
  app.post("/api/files", async (c) => {
    if (!files) return c.json({ error: "Photos are not kept on this server." }, 501);
    const { user } = c.get("session");
    const body = (await c.req.json().catch(() => null)) as { mime?: unknown; data?: unknown } | null;
    if (typeof body?.mime !== "string" || typeof body.data !== "string") return c.json({ error: 'send {mime: "image/jpeg", data: "<base64>"}' }, 400);
    try {
      return c.json(files.put(user.id, Buffer.from(body.data, "base64"), body.mime));
    } catch (e) {
      if (e instanceof FileError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // Only the learner who sent a file can fetch it. Its bytes never change, so it is cached for good.
  app.get("/api/files/:id", (c) => {
    const { user } = c.get("session");
    const f = files?.get(user.id, c.req.param("id"));
    if (!f) return c.json({ error: "no such file" }, 404);
    return c.body(new Uint8Array(f.bytes), 200, {
      "content-type": f.mime,
      "cache-control": "private, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    });
  });

  // Run page: every code block on the page as it is now, top to bottom, in a fresh interpreter. The
  // result is a page.ran event, so every open device shows the output.
  const running = new Map<string, Promise<{ seq: number }>>();
  app.post("/api/pages/:id/run", async (c) => {
    if (!sandbox) return c.json({ error: "Code does not run on this server." }, 501);
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const page = store.state.pages[c.req.param("id")];
    if (!page) return c.json({ error: "no such page" }, 404);
    const key = `${user.id}:${page.id}`;
    // Pressing Run page again while a run is in flight waits for that run.
    let run = running.get(key);
    if (!run) {
      const rev = page.rev;
      const blocks = codeBlocks(page);
      run = sandbox
        .run(blocks)
        .then((r) => {
          const ts = Date.now();
          const e = makeEvent("page.ran", { page_id: page.id, rev, blocks: r.blocks, timed_out: r.timed_out, duration_ms: r.duration_ms }, { id: uuidv7(ts), device_id: SANDBOX_DEVICE, ts });
          return { seq: store.append([e])[0]!.seq };
        })
        .finally(() => running.delete(key));
      running.set(key, run);
    }
    return c.json(await run);
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
        // The tutor's first words wait for the learner's key; passive v2 clock connections never auto-greet.
        if (!needsKey(user.id) && c.req.query("passive") !== "1") tutor.opened();
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

  // --- Fast Micro-Production Drill (RWKV-Instant + Jev System 1 -> System 2 cascade) & Map ---

  function scoreAll(state: State, scheduler: { name: string; recall(m: Unit["memory"], at: number): number }, now: number): { scheduler: string; scores: Map<string, RwkvUnitScore> } {
    const calibrated = computeCalibratedIntervals(state, now);
    if (rwkv) {
      const rwkvScores = rwkv.scoreUnits(state, now);
      for (const [id, s] of rwkvScores) {
        const cal = calibrated.get(id);
        if (cal) {
          // Keep RWKV's fine-grained p_imm for within-due priority ordering, while using
          // calibrated FSRS-6 (R=0.85, Build-gear-aware, >=4h floor) for due/next_in_ms spacing.
          s.next_in_ms = cal.next_in_ms;
          s.reviews = cal.reviews;
        }
      }
      return { scheduler: `${rwkv.name}+fsrs85`, scores: rwkvScores };
    }
    const scores = new Map<string, RwkvUnitScore>();
    for (const u of Object.values(state.units)) {
      if (u.status === "split" || u.status === "merged" || u.observe_only) continue;
      const cal = calibrated.get(u.id);
      const p = cal && cal.reviews > 0 ? cal.fsrs_recall : u.memory_reviews > 0 ? scheduler.recall(u.memory, now) : 0;
      const due = cal ? cal.next_in_ms : typeof u.memory.due === "number" ? Math.max(0, u.memory.due - now) : null;
      scores.set(u.id, { unit_id: u.id, p_imm: p, p_rating: [1 - p, 0, p, 0], next_in_ms: due, reviews: cal?.reviews ?? u.memory_reviews });
    }
    return { scheduler: scheduler.name, scores };
  }

  function latencyTrend(state: State, u: Unit): { prev_ms: number | null; first_ms: number | null } {
    const times = u.evidence
      .map((id) => state.evidence[id])
      .filter((ev) => ev?.source === "probe" && ev.grade !== null && ev.grade !== "again" && ev.latency_ms !== null)
      .map((ev) => ev!.latency_ms!);
    if (times.length === 0) return { prev_ms: null, first_ms: null };
    return { first_ms: times[0]!, prev_ms: times.at(-1)! };
  }

  function activeHabits(state: State): Unit[] {
    return Object.values(state.units).filter((u) => u.status === "active" && u.observe_only);
  }

  /**
   * DAG-aware ranker layered on top of RWKV-Instant recall probabilities:
   * Any unit that rests on an unmastered/weak prerequisite (reviews === 0 or p_imm < 0.85)
   * sorts after unblocked foundations, so learners build the ground floor before compound units.
   */
  function rankDrillCandidates(candidates: Unit[], state: State, scores: Map<string, RwkvUnitScore>): Unit[] {
    const isWeak = (u: Unit): boolean => {
      const s = scores.get(u.id);
      return !s || s.reviews === 0 || s.p_imm < 0.85;
    };
    const hasWeakPrereq = (u: Unit, seen = new Set<string>()): boolean => {
      if (seen.has(u.id)) return false;
      seen.add(u.id);
      for (const pid of u.rests_on) {
        const p = state.units[pid];
        if (!p || p.status !== "active" || p.observe_only) continue;
        if (isWeak(p) || hasWeakPrereq(p, seen)) return true;
      }
      return false;
    };
    const blocked = new Map<string, number>();
    for (const u of candidates) blocked.set(u.id, hasWeakPrereq(u) ? 1 : 0);
    return [...candidates].sort((a, b) => {
      const ba = blocked.get(a.id) ?? 0;
      const bb = blocked.get(b.id) ?? 0;
      if (ba !== bb) return ba - bb;
      const sa = scores.get(a.id)?.p_imm ?? 0;
      const sb = scores.get(b.id)?.p_imm ?? 0;
      if (sa !== sb) return sa - sb;
      return a.found_at - b.found_at;
    });
  }

  const normUnitText = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
  const unitTokens = (s: string) => new Set(normUnitText(s).split(" ").filter((w) => w.length > 2));
  const isNearDuplicate = (candidate: string, existingTexts: Iterable<string>): boolean => {
    const nc = normUnitText(candidate);
    if (!nc) return true;
    const tc = unitTokens(candidate);
    for (const ex of existingTexts) {
      const ne = normUnitText(ex);
      if (ne === nc) return true;
      if (tc.size >= 4) {
        const te = unitTokens(ex);
        if (te.size >= 4) {
          let inter = 0;
          for (const w of tc) if (te.has(w)) inter++;
          const union = tc.size + te.size - inter;
          if (union > 0 && inter / union >= 0.75) return true;
        }
      }
    }
    return false;
  };

  function autoAddPrereqs(
    store: ReturnType<Stores["get"]>,
    targetUnit: Unit,
    prereqs: { text: string; kind: string; observe_only: boolean }[] | undefined,
    now: number,
  ): { unit_id: string; text: string; kind: string; observe_only: boolean }[] {
    if (!prereqs || prereqs.length === 0) return [];
    const state = store.state;
    const byNorm = new Map<string, Unit>();
    const activeTexts: string[] = [];
    for (const u of Object.values(state.units)) {
      if (u.status === "active") {
        byNorm.set(normUnitText(u.text), u);
        activeTexts.push(u.text);
      }
    }
    const added: { unit_id: string; text: string; kind: string; observe_only: boolean }[] = [];
    const nextRestsOn = new Set(targetUnit.rests_on);
    let linkedChanged = false;
    for (const [idx, p] of prereqs.entries()) {
      const key = normUnitText(p.text);
      if (!key || key === normUnitText(targetUnit.text)) continue;
      const existing = byNorm.get(key);
      if (existing) {
        if (existing.id !== targetUnit.id && !existing.observe_only && !nextRestsOn.has(existing.id)) {
          nextRestsOn.add(existing.id);
          linkedChanged = true;
        }
        continue;
      }
      if (isNearDuplicate(p.text, activeTexts)) continue;
      const unit_id = uuidv7(now + 10 + idx);
      const ev = makeEvent(
        "unit.found",
        {
          unit_id,
          text: p.text,
          kind: p.kind || "definition",
          topic: targetUnit.topic,
          rests_on: [],
          origin: "need",
          told: false,
          observe_only: false,
          message_id: null,
        },
        { id: uuidv7(now + 10 + idx), device_id: DRILL_DEVICE, ts: now + 10 + idx },
      );
      store.append([ev]);
      const created = store.state.units[unit_id];
      if (created) byNorm.set(key, created);
      activeTexts.push(p.text);
      nextRestsOn.add(unit_id);
      linkedChanged = true;
      added.push({ unit_id, text: p.text, kind: p.kind || "definition", observe_only: false });
    }
    if (linkedChanged) {
      store.append([
        makeEvent(
          "unit.linked",
          { unit_id: targetUnit.id, rests_on: [...nextRestsOn] },
          { id: uuidv7(now + 20), device_id: DRILL_DEVICE, ts: now + 20 },
        ),
      ]);
    }
    if (added.length > 0) {
      judge.warmPrompts(added.map((u) => ({ unit: { id: u.unit_id, text: u.text, kind: u.kind }, restsOn: [], depth: "recall" as Depth })));
    }
    return added;
  }

  const migratedFrontierUsers = new Set<string>();
  function ensureBriefingsMigrated(userId: string, store: ReturnType<Stores["get"]>): void {
    if (migratedFrontierUsers.has(userId)) return;
    migratedFrontierUsers.add(userId);
    const legacy = frontiers.list(userId);
    if (legacy.length === 0) return;
    for (const f of legacy) {
      if (store.getBriefing(f.id)) continue;
      store.saveBriefing({
        id: f.id,
        title: f.title,
        source: f.source,
        body: f.body,
        skipped_known: f.skipped_known ?? [],
        cruxes: f.cruxes ?? [],
        demonstrated_cruxes: f.demonstrated_cruxes ?? [],
        turns: f.turns ?? [],
        created_at: f.created_at ?? Date.now(),
        updated_at: f.created_at ?? Date.now(),
      });
    }
  }

  function briefingToFrontier(b: BriefingRecord): Frontier {
    return {
      id: b.id,
      title: b.title,
      source: b.source,
      body: b.body,
      skipped_known: b.skipped_known,
      cruxes: b.cruxes,
      demonstrated_cruxes: b.demonstrated_cruxes,
      turns: b.turns,
      created_at: b.created_at,
    };
  }

  interface PendingExploreSidecar {
    exploration_id: string;
    turn_index: number;
    title?: string | undefined;
    added_units: { unit_id: string; text: string; kind: string; observe_only: boolean }[];
  }
  const pendingExploreSidecars = new Map<string, Promise<PendingExploreSidecar>>();

  /**
   * Streams live coach prose over SSE when `?stream=1` is passed (emitting `delta` text updates
   * followed by one final `done` JSON payload), or returns regular JSON for non-streaming callers.
   * Wires real `AbortSignal` propagation so client cancel immediately aborts the LLM turn and skips
   * stale SQLite mutations, merges LLM + post-LLM timing into `perf.jsonl`, and sets `Server-Timing`.
   */
  function respondMaybeStream<T>(
    c: Context,
    work: (onText?: (partial: string) => void, onPerf?: (rec: PerfRecord) => void, signal?: AbortSignal) => Promise<T>,
    op?: PerfOp,
  ) {
    const reqStart = Date.now();
    let llmRec: PerfRecord | undefined;
    let abortedAtMs: number | undefined;
    const capturePerf = op ? (rec: PerfRecord) => { llmRec = rec; } : undefined;
    const finalizePerf = (ok: boolean, aborted: boolean, errMsg?: string): PerfRecord | undefined => {
      if (!op || !perfLog) return undefined;
      const totalMs = Math.max(0, Date.now() - reqStart);
      const base = llmRec;
      const llmSpan = base?.total_ms ?? base?.llm_ms;
      const postMs = llmSpan !== undefined ? Math.max(0, totalMs - llmSpan) : undefined;
      const merged: PerfRecord = {
        ...(base ?? { ts: reqStart, op, ok }),
        ts: base?.ts ?? reqStart,
        op,
        ok: ok && (base ? base.ok : true),
        ...(aborted ? { aborted: true, ...(abortedAtMs !== undefined ? { aborted_at_ms: abortedAtMs } : {}) } : {}),
        ...(postMs !== undefined ? { post_ms: postMs } : {}),
        total_ms: totalMs,
        ...(errMsg && !base?.error ? { error: errMsg } : {}),
      };
      perfLog.record(merged);
      return merged;
    };

    if (c.req.query("stream") !== "1") {
      return work(undefined, capturePerf, c.req.raw.signal).then(
        (res) => {
          const rec = finalizePerf(true, false);
          if (rec) c.header("Server-Timing", formatServerTiming(rec));
          return c.json(res);
        },
        (err) => {
          const aborted = Boolean(c.req.raw.signal?.aborted) || (err instanceof Error && err.name === "AbortError");
          finalizePerf(false, aborted, err instanceof Error ? err.message : String(err));
          throw err;
        },
      );
    }
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      const triggerAbort = () => {
        if (abortedAtMs === undefined) abortedAtMs = Math.max(0, Date.now() - reqStart);
        if (!ac.signal.aborted) ac.abort();
      };
      stream.onAbort(triggerAbort);
      if (c.req.raw.signal) {
        if (c.req.raw.signal.aborted) triggerAbort();
        else c.req.raw.signal.addEventListener("abort", triggerAbort, { once: true });
      }
      let lastSent = "";
      let sendChain: Promise<void> = Promise.resolve();
      const onText = (partial: string) => {
        if (stream.aborted || ac.signal.aborted || !partial || partial === lastSent) return;
        lastSent = partial;
        sendChain = sendChain.then(() =>
          stream.aborted || ac.signal.aborted ? undefined : stream.writeSSE({ event: "delta", data: JSON.stringify({ text: partial }) }),
        );
      };
      try {
        const final = await work(onText, capturePerf, ac.signal);
        await sendChain;
        const wasAborted = stream.aborted || ac.signal.aborted;
        finalizePerf(!wasAborted, wasAborted);
        if (!wasAborted) {
          await stream.writeSSE({ event: "done", data: JSON.stringify(final) });
        }
      } catch (err) {
        await sendChain;
        const wasAborted = stream.aborted || ac.signal.aborted || (err instanceof Error && err.name === "AbortError");
        const msg = err instanceof Error ? err.message : "stream failed";
        finalizePerf(false, wasAborted, msg);
        if (!wasAborted) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: msg }),
          });
        }
      }
    });
  }

  app.get("/api/drill/queue", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const state = store.state;
    const now = Date.now();
    const { scheduler, scores } = scoreAll(state, store.scheduler, now);
    const candidates = rankDrillCandidates(
      Object.values(state.units).filter((u) => u.status === "active" && !u.observe_only),
      state,
      scores,
    );
    const items = candidates.slice(0, 100).map((u) => {
      const s = scores.get(u.id);
      const pImm = s?.p_imm ?? 0;
      const reviews = s?.reviews ?? 0;
      const nextIn = s?.next_in_ms ?? null;
      const depth = pickDrillDepth(u, state);
      const restsOn = u.rests_on.map((id) => state.units[id]?.text ?? id);
      const stats = unitExposureStats(state, u.id, depth, now);
      return {
        unit_id: u.id,
        text: u.text,
        prompt: judge.peekPrompt(u, depth, restsOn, stats.depthPasses),
        kind: u.kind,
        topic: u.topic,
        depth,
        p_imm: pImm,
        reviews,
        next_in_ms: nextIn,
        due: reviews === 0 || (nextIn !== null ? nextIn <= 0 : pImm < 0.85),
      };
    });
    // Warm prompts for the top due items in the background so switching items is instant.
    const toWarm = candidates.filter((u) => {
      const s = scores.get(u.id);
      const reviews = s?.reviews ?? 0;
      const nextIn = s?.next_in_ms ?? null;
      return reviews === 0 || (nextIn !== null ? nextIn <= 0 : (s?.p_imm ?? 0) < 0.85);
    });
    judge.warmPrompts(
      (toWarm.length > 0 ? toWarm : candidates).slice(0, 12).map((u) => {
        const depth = pickDrillDepth(u, state);
        const restsOn = u.rests_on.map((id) => state.units[id]?.text ?? id);
        const stats = unitExposureStats(state, u.id, depth, now);
        return {
          unit: u,
          restsOn,
          depth,
          variant: stats.depthPasses,
          priorPrompts: stats.priorPrompts,
          delayedTransfer: stats.passes >= 1 && stats.daysSinceLastExposure >= 5,
        };
      }),
    );
    return c.json({
      scheduler,
      total_units: candidates.length,
      active_ids: candidates.map((u) => u.id),
      active_attempts: store.getActiveAttempts().map((a) => ({
        attempt_id: a.attempt_id,
        unit_id: a.unit_id,
        depth: a.depth,
        prompt: a.prompt,
        turns: a.turns,
        assistance_count: a.assistance_count,
        active_ms: a.active_ms,
        updated_at: a.updated_at,
      })),
      items,
    });
  });

  /**
   * Detects when a first-turn Explore message is asking to unpack an unfamiliar paper, file,
   * chapter, codebase, or broad topic as a saved plain-English Briefing (zero mode toggle needed).
   */
  function shouldAutoBrief(raw: string): boolean {
    const t = raw.trim();
    if (!t) return false;
    // File paths, document extensions, or URLs/arXiv links
    if (/(^|\s)(~\/|\/Users\/|\/home\/|\.\/)\S+/i.test(t)) return true;
    if (/\b\S+\.(pdf|epub|tex|md|ipynb)\b/i.test(t)) return true;
    if (/https?:\/\/\S+/i.test(t)) return true;
    // Explicit briefing / paper / chapter / codebase walkthrough intent
    if (
      /\b(brief\s+me|briefing|walk\s+me\s+through|give\s+me\s+an?\s+overview|summarize\s+(this|the)|chapter\s+\d+|ch\.?\s*\d+|from\s+scratch\b.*\b(explain|overview|guide)|understand\s+(this|the)\s+(paper|chapter|book|codebase|repo))\b/i.test(
        t,
      )
    ) {
      return true;
    }
    return false;
  }

  function fallbackExplorationTitle(raw: string): string {
    const clean = raw
      .replace(/^>.*$/gm, "")
      .replace(/\s+/g, " ")
      .replace(/^(can\s+(we|you)\s+|help\s+me\s+|please\s+)/i, "")
      .replace(
        /^(i\s+(would\s+|'d\s+)?(really\s+)?(like|want)\s+to\s+(get\s+|build\s+|have\s+)?(a\s+)?(good\s+|solid\s+|working\s+|deep\s+)?(understand(ing)?|grasp|intuition|learn|explore|work\s+through)\s*)/i,
        "",
      )
      .replace(/^\([^)]{1,32}\)\s*/i, "")
      .replace(/^(of|about|on|for|how)\s+/i, "")
      .trim();
    if (!clean) return "Exploration";
    const firstClause = clean.split(/[,;.!?\n]/)[0]?.trim() || clean;
    const base = firstClause.length >= 8 ? firstClause : clean;
    const cut = base.length > 46 ? base.slice(0, 46).replace(/\s+\S*$/, "") : base;
    const trimmed = cut.replace(/[\s,;:–—-]+$/g, "").replace(/\s+\b(the|a|an|of|and|or|to|in|on|with|for)$/i, "").trim();
    if (!trimmed) return "Exploration";
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  app.get("/api/explorations", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    const all = store.listExplorations(true);
    return c.json({
      explorations: all.filter((e) => !e.archived),
      archived: all.filter((e) => e.archived),
    });
  });

  app.post("/api/explorations", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    const body = (await c.req.json().catch(() => null)) as {
      id?: string;
      title?: string;
      turns?: { user: string; coach: string; added?: { unit_id: string; text: string; kind: string; observe_only: boolean }[] }[];
    } | null;
    const turns = Array.isArray(body?.turns)
      ? body.turns
          .filter((t) => typeof t?.user === "string" && typeof t?.coach === "string")
          .slice(-60)
          .map((t) => ({
            user: t.user,
            coach: t.coach,
            ...(Array.isArray(t.added) && t.added.length > 0 ? { added: t.added } : {}),
          }))
      : [];
    if (turns.length === 0) return c.json({ error: "turns required" }, 400);
    const now = Date.now();
    const id = typeof body?.id === "string" && body.id.trim() ? body.id.trim() : uuidv7(now);
    const existing = store.getExploration(id);
    const title = (typeof body?.title === "string" && body.title.trim()) || existing?.title || fallbackExplorationTitle(turns[0]!.user);
    const rec: ExplorationRecord = {
      id,
      title,
      turns,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    store.saveExploration(rec);
    return c.json({ exploration: rec });
  });

  app.post("/api/explorations/:id/archive", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    const id = c.req.param("id");
    store.archiveExploration(id, true);
    judge.closeSession(`explore:${id}`);
    return c.json({ ok: true, id });
  });

  app.post("/api/explorations/:id/unarchive", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    const id = c.req.param("id");
    store.archiveExploration(id, false);
    return c.json({ ok: true, id });
  });

  app.delete("/api/explorations/:id", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    const id = c.req.param("id");
    store.deleteExploration(id);
    judge.closeSession(`explore:${id}`);
    pendingExploreSidecars.delete(id);
    return c.json({ ok: true, id });
  });

  app.get("/api/explorations/:id/sidecar", async (c) => {
    const id = c.req.param("id");
    const pending = pendingExploreSidecars.get(id);
    if (!pending) return c.json({ exploration_id: id, added_units: [] });
    try {
      const res = await pending;
      return c.json(res);
    } catch {
      return c.json({ exploration_id: id, added_units: [] });
    }
  });

  app.post("/api/drill/tidy", async (c) => {
    const t0 = Date.now();
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) return c.json({ text, changed: false });
    if (text.length > 8000) return c.json({ error: "draft too long to tidy" }, 400);
    let rec: PerfRecord | undefined;
    try {
      const res = await judge.tidyInput(text, (r) => {
        rec = r;
      });
      const finalRec: PerfRecord = { ...(rec ?? { ts: t0, op: "tidy", ok: true }), total_ms: Date.now() - t0 };
      perfLog?.record(finalRec);
      c.header("Server-Timing", formatServerTiming(finalRec));
      return c.json(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not format draft.";
      perfLog?.record({ ts: t0, op: "tidy", ok: false, total_ms: Date.now() - t0, error: msg });
      return c.json({ error: msg }, 502);
    }
  });

  app.post("/api/drill/explore", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const body = (await c.req.json().catch(() => null)) as {
      exploration_id?: string | null;
      initial?: string;
      sketch_data_url?: string | null;
      turns?: { role: "user" | "assistant"; text: string }[];
      reply?: string;
      promote_on_unit?: boolean;
      origin_prompt?: string;
      prior_post_turns?: { user: string; coach: string; added?: { unit_id: string; text: string; kind: string; observe_only: boolean }[] }[];
      rep_context?: { unit_id?: string; depth?: Depth; prompt?: string; probe_id?: string | null; grade?: Grade } | null;
    } | null;
    const initial = (body?.initial ?? "").trim();
    const sketch = typeof body?.sketch_data_url === "string" && body.sketch_data_url.startsWith("data:image/") ? body.sketch_data_url : null;
    if (!initial && !sketch) return c.json({ error: "write something or sketch first" }, 400);
    const state = store.state;
    const existingUnits = Object.values(state.units)
      .filter((u) => u.status === "active" && !u.observe_only)
      .map((u) => u.text);
    const habits = activeHabits(state).map((h) => h.text);
    const turns = Array.isArray(body?.turns)
      ? body.turns.filter((t): t is { role: "user" | "assistant"; text: string } => (t?.role === "user" || t?.role === "assistant") && typeof t?.text === "string").slice(-20)
      : [];

    // Auto-route opening paper/file/chapter/walkthrough requests straight into a saved Briefing.
    if (turns.length === 0 && !body?.reply?.trim() && !sketch && shouldAutoBrief(initial)) {
      ensureBriefingsMigrated(user.id, store);
      const now = Date.now();
      const { scores } = scoreAll(state, store.scheduler, now);
      const existingWithStrength = Object.values(state.units)
        .filter((u) => u.status === "active" && !u.observe_only)
        .map((u) => {
          const s = scores.get(u.id);
          return { text: u.text, p_imm: s?.p_imm ?? 0, reviews: s?.reviews ?? 0 };
        });
      return respondMaybeStream(
        c,
        async (_onText, onPerf, signal) => {
          const planned = await judge.planFrontier(
            {
              request: initial,
              existingUnits: existingWithStrength,
              learnerMemory: learnerMemoryOf(store),
            },
            onPerf,
            signal,
          );
          if (signal?.aborted) return { message: "", added_units: [] };
          const record: BriefingRecord = {
            id: uuidv7(now),
            title: planned.title,
            source: initial,
            body: planned.body,
            skipped_known: planned.skipped_known,
            cruxes: planned.cruxes,
            demonstrated_cruxes: [],
            turns: [],
            created_at: now,
            updated_at: now,
          };
          store.saveBriefing(record);
          return { message: "", added_units: [], frontier: briefingToFrontier(record) };
        },
        "briefing-plan",
      );
    }
    return respondMaybeStream(c, async (onText, onPerf, signal) => {
      const repUnit = body?.rep_context?.unit_id ? resolveUnit(state, body.rep_context.unit_id) : null;
      const repDepth: Depth =
        body?.rep_context?.depth && ["recall", "rebuild", "explain", "use"].includes(body.rep_context.depth)
          ? body.rep_context.depth
          : repUnit
            ? pickDrillDepth(repUnit, state)
            : "recall";
      const repGrade: Grade =
        body?.rep_context?.grade && ["again", "hard", "good", "easy"].includes(body.rep_context.grade)
          ? body.rep_context.grade
          : "good";

      const isStandaloneExploration = !initial.startsWith("Completed practice on:");
      const preNow = Date.now();
      const standaloneExpId = isStandaloneExploration
        ? typeof body?.exploration_id === "string" && body.exploration_id.trim()
          ? body.exploration_id.trim()
          : uuidv7(preNow)
        : null;
      const decoupleMeta = isStandaloneExploration && !repUnit;

      const res = await judge.explore(
        {
          sessionKey: standaloneExpId ? `explore:${standaloneExpId}` : undefined,
          decoupleMeta,
          initial,
          sketchDataUrl: sketch,
          turns,
          reply: body?.reply?.trim() || undefined,
          existingUnits,
          activeHabits: habits,
          learnerMemory: learnerMemoryOf(store),
          ...(repUnit
            ? {
                repContext: {
                  unitText: repUnit.text,
                  depth: repDepth,
                  prompt: (body?.rep_context?.prompt ?? "").trim(),
                  grade: repGrade,
                },
              }
            : {}),
        },
        onText,
        onPerf,
        signal,
      );

      if (signal?.aborted) {
        return { message: "", added_units: [] };
      }

      // Apply any self-healing rep fixes when the learner gave meta-feedback on a completed drill.
      let rep_fix_applied:
        | { changes: string[]; grade?: Grade; next_in_ms?: number | null; reworded_unit?: string | null }
        | undefined;
      if (repUnit && res.rep_fix && !res.failed) {
        const fixNow = Date.now();
        const changes: string[] = [];
        let effectiveText = repUnit.text;
        let appliedGrade: Grade | undefined;
        let nextInMs: number | null | undefined;

        if (res.rep_fix.reworded_unit && res.rep_fix.reworded_unit.toLowerCase() !== repUnit.text.toLowerCase()) {
          store.append([
            makeEvent(
              "unit.reworded",
              { unit_id: repUnit.id, text: res.rep_fix.reworded_unit, by: "tutor" },
              { id: uuidv7(fixNow), device_id: DRILL_DEVICE, ts: fixNow },
            ),
          ]);
          effectiveText = res.rep_fix.reworded_unit;
          changes.push("Reworded unit on map");
        }
        if (res.rep_fix.recommended_grade && body?.rep_context?.probe_id && res.rep_fix.recommended_grade !== repGrade) {
          store.append([
            makeEvent(
              "unit.probed",
              {
                unit_id: repUnit.id,
                corrects: body.rep_context.probe_id,
                grade: res.rep_fix.recommended_grade,
                note: "Adjusted from learner follow-up feedback",
              },
              { id: uuidv7(fixNow + 2), device_id: DRILL_DEVICE, ts: fixNow + 2 },
            ),
          ]);
          appliedGrade = res.rep_fix.recommended_grade;
          changes.push(`Adjusted grade → ${res.rep_fix.recommended_grade}`);
          const after = scoreAll(store.state, store.scheduler, fixNow + 3);
          nextInMs = after.scores.get(repUnit.id)?.next_in_ms ?? null;
        }
        if (res.rep_fix.improved_prompt) {
          const refreshed = store.state.units[repUnit.id] ?? repUnit;
          const restsOn = refreshed.rests_on.map((id) => store.state.units[id]?.text ?? id);
          const nextDepth = pickDrillDepth(refreshed, store.state);
          const stats = unitExposureStats(store.state, repUnit.id, nextDepth, fixNow + 4);
          judge.overrideCachedPrompt(
            { id: repUnit.id, text: effectiveText },
            nextDepth,
            restsOn,
            stats.depthPasses,
            res.rep_fix.improved_prompt,
          );
          changes.push("Updated prompt for next review");
        }
        if (changes.length > 0) {
          rep_fix_applied = {
            changes,
            ...(appliedGrade ? { grade: appliedGrade } : {}),
            ...(nextInMs !== undefined ? { next_in_ms: nextInMs } : {}),
            ...(effectiveText !== repUnit.text ? { reworded_unit: effectiveText } : {}),
          };
        }
      }

      const willPromotePostFollowUp =
        !isStandaloneExploration && Boolean(body?.promote_on_unit) && !res.failed && res.suggested_units.length > 0;
      const now = Date.now();
      const expId = isStandaloneExploration
        ? standaloneExpId
        : willPromotePostFollowUp
          ? uuidv7(now)
          : null;
      const existingExp = isStandaloneExploration && expId ? store.getExploration(expId) : null;
      const explorationTitle = isStandaloneExploration
        ? existingExp?.title || res.title || fallbackExplorationTitle(initial)
        : willPromotePostFollowUp
          ? res.title || fallbackExplorationTitle(res.suggested_units[0]?.text || body?.reply || initial)
          : null;

      // Optimistically auto-add crystallized units (exact + near-duplicate guard); learner can undo with Remove.
      const activeUnitTexts = Object.values(store.state.units)
        .filter((u) => u.status === "active")
        .map((u) => u.text);
      const added_units: { unit_id: string; text: string; kind: string; observe_only: boolean }[] = [];
      for (const [idx, u] of res.suggested_units.entries()) {
        if (isNearDuplicate(u.text, activeUnitTexts)) continue;
        activeUnitTexts.push(u.text);
        const unit_id = uuidv7(now + idx);
        const ev = makeEvent(
          "unit.found",
          {
            unit_id,
            text: u.text,
            kind: u.kind || (u.observe_only ? "thinking move" : "move"),
            topic: explorationTitle,
            rests_on: [],
            origin: u.observe_only ? "observed" : "need",
            told: Boolean(u.told),
            observe_only: u.observe_only,
            message_id: null,
          },
          { id: uuidv7(now + idx), device_id: DRILL_DEVICE, ts: now + idx },
        );
        store.append([ev]);
        added_units.push({ unit_id, text: u.text, kind: u.kind, observe_only: u.observe_only });
      }
      if (added_units.length > 0) {
        judge.warmPrompts(
          added_units
            .filter((u) => !u.observe_only)
            .map((u) => ({
              unit: { id: u.unit_id, text: u.text, kind: u.kind, topic: explorationTitle },
              restsOn: [],
              depth: "recall" as Depth,
            })),
        );
      }

      // Persist standalone explorations, or auto-promote a post-pass drill follow-up once it adds a map unit.
      let exploration: ExplorationRecord | undefined;
      let savedTurnIndex = 0;
      const userText = (body?.reply?.trim() || initial || "(sketch)").trim();
      if (!res.failed && expId && explorationTitle && (isStandaloneExploration || (willPromotePostFollowUp && added_units.length > 0))) {
        let nextTurns: ExplorationRecord["turns"];
        if (isStandaloneExploration) {
          const prevTurns = existingExp?.turns ?? [];
          nextTurns = [
            ...prevTurns,
            {
              user: userText,
              coach: res.message,
              ...(res.question ? { question: res.question } : {}),
              ...(added_units.length > 0 ? { added: added_units } : {}),
            },
          ].slice(-60);
          savedTurnIndex = nextTurns.length - 1;
        } else {
          const priorPost = Array.isArray(body?.prior_post_turns)
            ? body.prior_post_turns
                .filter((t) => typeof t?.user === "string" && typeof t?.coach === "string")
                .map((t) => ({
                  user: t.user,
                  coach: t.coach,
                  ...(Array.isArray(t.added) && t.added.length > 0 ? { added: t.added } : {}),
                }))
            : [];
          const origin = typeof body?.origin_prompt === "string" ? body.origin_prompt.trim() : "";
          const rawTurns = [
            ...priorPost,
            {
              user: userText,
              coach: res.message,
              ...(res.question ? { question: res.question } : {}),
              ...(added_units.length > 0 ? { added: added_units } : {}),
            },
          ];
          if (origin && rawTurns[0] && !rawTurns[0].user.startsWith("> ")) {
            rawTurns[0] = { ...rawTurns[0], user: `> ${origin.replace(/\n+/g, " ")}\n${rawTurns[0].user}` };
          }
          nextTurns = rawTurns.slice(-60);
          savedTurnIndex = nextTurns.length - 1;
        }
        exploration = {
          id: expId,
          title: explorationTitle,
          turns: nextTurns,
          created_at: existingExp?.created_at ?? now,
          updated_at: now,
        };
        store.saveExploration(exploration);
      }

      // Fire non-blocking post-turn sidecar for standalone explorations so unit crystallization & title
      // refinement add 0ms to foreground TTFT and stream smoothly onto the saved beat once ready.
      let sidecarPending = false;
      if (decoupleMeta && !res.failed && expId && exploration) {
        sidecarPending = true;
        const needsTitle = !existingExp;
        const fallbackTitleUsed = exploration.title;
        const sidecarPromise: Promise<PendingExploreSidecar> = (async () => {
          try {
            const meta = await judge.extractExploreMeta({
              userText,
              coachMessage: res.message,
              coachQuestion: res.question,
              priorTurns: turns,
              existingUnits,
              activeHabits: habits,
              needsTitle,
            });
            const sNow = Date.now();
            const liveExp = store.getExploration(expId);
            const finalTitle =
              needsTitle && meta.title && liveExp && liveExp.title === fallbackTitleUsed ? meta.title : liveExp?.title ?? fallbackTitleUsed;

            const currentActiveTexts = Object.values(store.state.units)
              .filter((u) => u.status === "active")
              .map((u) => u.text);
            const sidecarAdded: { unit_id: string; text: string; kind: string; observe_only: boolean }[] = [];
            for (const [idx, u] of meta.suggested_units.entries()) {
              if (isNearDuplicate(u.text, currentActiveTexts)) continue;
              currentActiveTexts.push(u.text);
              const unit_id = uuidv7(sNow + idx);
              store.append([
                makeEvent(
                  "unit.found",
                  {
                    unit_id,
                    text: u.text,
                    kind: u.kind || (u.observe_only ? "thinking move" : "move"),
                    topic: finalTitle,
                    rests_on: [],
                    origin: u.observe_only ? "observed" : "need",
                    told: Boolean(u.told),
                    observe_only: u.observe_only,
                    message_id: null,
                  },
                  { id: uuidv7(sNow + idx), device_id: DRILL_DEVICE, ts: sNow + idx },
                ),
              ]);
              sidecarAdded.push({ unit_id, text: u.text, kind: u.kind, observe_only: u.observe_only });
            }
            if (sidecarAdded.length > 0) {
              judge.warmPrompts(
                sidecarAdded
                  .filter((u) => !u.observe_only)
                  .map((u) => ({
                    unit: { id: u.unit_id, text: u.text, kind: u.kind, topic: finalTitle },
                    restsOn: [],
                    depth: "recall" as Depth,
                  })),
              );
            }
            if (liveExp && (sidecarAdded.length > 0 || finalTitle !== liveExp.title)) {
              const updatedTurns = liveExp.turns.map((t, i) =>
                i === savedTurnIndex && sidecarAdded.length > 0
                  ? { ...t, added: [...(t.added ?? []), ...sidecarAdded] }
                  : t,
              );
              store.saveExploration({
                ...liveExp,
                title: finalTitle,
                turns: updatedTurns,
                updated_at: sNow,
              });
            }
            return {
              exploration_id: expId,
              turn_index: savedTurnIndex,
              ...(finalTitle !== fallbackTitleUsed ? { title: finalTitle } : {}),
              added_units: sidecarAdded,
            };
          } catch {
            return { exploration_id: expId, turn_index: savedTurnIndex, added_units: [] };
          } finally {
            setTimeout(() => {
              if (pendingExploreSidecars.get(expId) === sidecarPromise) pendingExploreSidecars.delete(expId);
            }, 30_000);
          }
        })();
        pendingExploreSidecars.set(expId, sidecarPromise);
      }

      if (!res.failed) scheduleIdleDream(user.id, store);

      return {
        message: res.message,
        ...(res.question ? { question: res.question } : {}),
        added_units,
        ...(exploration ? { exploration: { id: exploration.id, title: exploration.title } } : {}),
        ...(sidecarPending ? { sidecar_pending: true } : {}),
        ...(rep_fix_applied ? { rep_fix_applied } : {}),
        ...(res.failed ? { failed: true } : {}),
      };
    }, "explore");
  });

  app.get("/api/drill/next", async (c) => {
    const t0 = Date.now();
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const state = store.state;
    const now = Date.now();
    const requestedId = c.req.query("unit_id");
    const excludeId = c.req.query("exclude");
    const { scheduler, scores } = scoreAll(state, store.scheduler, now);
    const habits = activeHabits(state).map((h) => ({ id: h.id, text: h.text }));

    const candidates = Object.values(state.units).filter((u) => u.status === "active" && !u.observe_only);
    if (candidates.length === 0) {
      return c.json({ rep: null, scheduler, total_units: 0, active_habits: habits, judge_enabled: judge.enabled });
    }

    let picked: Unit | undefined;
    if (requestedId) {
      picked = resolveUnit(state, requestedId);
    } else {
      const pool = candidates.filter((u) => u.id !== excludeId && (u.last_probed_at === null || now - u.last_probed_at > 30_000));
      const list = pool.length > 0 ? pool : candidates.filter((u) => u.id !== excludeId);
      const rankable = list.length > 0 ? list : candidates;
      // Rank foundations first (DAG-aware) and lowest RWKV recall probability first.
      const ranked = rankDrillCandidates(rankable, state, scores);
      picked = ranked[0];
    }

    if (!picked) {
      return c.json({ rep: null, scheduler, total_units: candidates.length, active_habits: habits, judge_enabled: judge.enabled });
    }

    const score = scores.get(picked.id);
    const dueIds = new Set(
      candidates
        .filter((u) => {
          const s = scores.get(u.id);
          const reviews = s?.reviews ?? 0;
          const nextIn = s?.next_in_ms ?? null;
          return reviews === 0 || (nextIn !== null ? nextIn <= 0 : (s?.p_imm ?? 0) < 0.85);
        })
        .map((u) => u.id),
    );
    const depth = pickDrillDepth(picked, state);
    const restsOn = picked.rests_on.map((id) => state.units[id]?.text ?? id);
    const bundledUnits = pickSynthesisCluster(picked, state, dueIds, 2);
    const bundledIds = bundledUnits.map((b) => b.id);
    const modality = pickRepModality(picked, state, depth, bundledUnits);
    const stats = unitExposureStats(state, picked.id, depth, now);
    const cacheHit = judge.peekPromptEntry(picked, depth, restsOn, stats.depthPasses, modality, bundledIds) !== null;
    const promptEntry = await judge.promptEntryFor(picked, restsOn, depth, {
      variant: stats.depthPasses,
      priorPrompts: stats.priorPrompts,
      delayedTransfer: stats.passes >= 1 && stats.daysSinceLastExposure >= 5,
      learnerMemory: learnerMemoryOf(store),
      modality,
      bundledUnits: bundledUnits.map((b) => ({ id: b.id, text: b.text, kind: b.kind })),
    });
    const prompt = promptEntry.prompt;
    const trend = latencyTrend(state, picked);
    const nextRec: PerfRecord = {
      ts: t0,
      op: "next",
      worker: cacheHit ? "cache" : "prompt",
      cache_hit: cacheHit,
      ok: true,
      total_ms: Date.now() - t0,
    };
    perfLog?.record(nextRec);
    c.header("Server-Timing", formatServerTiming(nextRec));

    // Eagerly prefetch the next 4 upcoming cards while the learner works on this one.
    const upcoming = rankDrillCandidates(
      candidates.filter((u) => u.id !== picked.id && !bundledIds.includes(u.id)),
      state,
      scores,
    ).slice(0, 4);
    if (upcoming.length > 0) {
      judge.warmPrompts(
        upcoming.map((u) => {
          const d = pickDrillDepth(u, state);
          const ro = u.rests_on.map((id) => state.units[id]?.text ?? id);
          const st = unitExposureStats(state, u.id, d, now);
          const b = pickSynthesisCluster(u, state, dueIds, 2);
          const m = pickRepModality(u, state, d, b);
          return {
            unit: u,
            restsOn: ro,
            depth: d,
            variant: st.depthPasses,
            priorPrompts: st.priorPrompts,
            delayedTransfer: st.passes >= 1 && st.daysSinceLastExposure >= 5,
            modality: m,
            bundledUnits: b.map((x) => ({ id: x.id, text: x.text, kind: x.kind })),
          };
        }),
      );
    }

    return c.json({
      scheduler,
      total_units: candidates.length,
      active_habits: habits,
      judge_enabled: judge.enabled,
      rep: {
        unit_id: picked.id,
        text: picked.text,
        kind: picked.kind,
        topic: picked.topic,
        depth,
        prompt,
        modality: promptEntry.modality ?? modality,
        ...(promptEntry.starter ? { starter: promptEntry.starter } : {}),
        ...(bundledIds.length > 0 ? { bundled_unit_ids: bundledIds } : {}),
        rests_on: restsOn,
        p_imm: score?.p_imm ?? 0,
        reviews: score?.reviews ?? 0,
        prev_latency_ms: trend.prev_ms,
        first_latency_ms: trend.first_ms,
      },
    });
  });

  app.post("/api/drill/check", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const body = (await c.req.json().catch(() => null)) as {
      attempt_id?: string;
      unit_id?: string;
      depth?: Depth;
      prompt?: string;
      attempt?: string;
      sketch_data_url?: string | null;
      history?: { attempt: string; feedback: string }[];
      latency_ms?: number | null;
      hints_used?: number;
      hint_only?: boolean;
      show_pivot?: boolean;
      modality?: RepModality;
      bundled_unit_ids?: string[];
      rung?: number;
    } | null;

    if (!body?.unit_id) return c.json({ error: "unit_id required" }, 400);
    const state = store.state;
    const u = resolveUnit(state, body.unit_id);
    if (!u) return c.json({ error: "unknown unit" }, 404);
    const restsOn = u.rests_on.map((id) => state.units[id]?.text ?? id);
    const depth: Depth = body.depth && ["recall", "rebuild", "explain", "use"].includes(body.depth) ? body.depth : pickDrillDepth(u, state);
    const preStats = unitExposureStats(state, u.id, depth, Date.now());
    const bundledIds = Array.isArray(body.bundled_unit_ids)
      ? body.bundled_unit_ids.filter((id): id is string => typeof id === "string" && id !== u.id).slice(0, 3)
      : [];
    const bundledUnits = bundledIds
      .map((id) => resolveUnit(state, id))
      .filter((x): x is Unit => Boolean(x && x.status === "active" && !x.observe_only && x.id !== u.id));
    const reqModality: RepModality =
      body.modality && ["direct", "fix_bug", "faded_skeleton", "contrast", "synthesis"].includes(body.modality)
        ? body.modality
        : pickRepModality(u, state, depth, bundledUnits);
    const cachedPromptEntry =
      judge.peekPromptEntry(u, depth, restsOn, preStats.depthPasses, reqModality, bundledIds) ??
      judge.peekPromptEntry(u, depth, restsOn, preStats.depthPasses);
    const prompt = body.prompt?.trim() || cachedPromptEntry?.prompt || (await judge.promptFor(u, restsOn, depth));
    const expectedCrux = cachedPromptEntry?.crux;
    const firstContact = u.told && preStats.passes === 0;
    const showPivot = Boolean(body.show_pivot);

    if (body.hint_only) {
      const t0 = Date.now();
      let hintRec: PerfRecord | undefined;
      const h = await judge.hint(
        {
          prompt,
          unitText: u.text,
          restsOn,
          attempt: body.attempt ?? "",
          rung: body.rung ?? 1,
        },
        (r) => {
          hintRec = r;
        },
      );
      const finalRec: PerfRecord = { ...(hintRec ?? { ts: t0, op: "hint", ok: true }), total_ms: Date.now() - t0 };
      perfLog?.record(finalRec);
      c.header("Server-Timing", formatServerTiming(finalRec));
      return c.json(h);
    }

    const attempt = (body.attempt ?? "").trim();
    const sketch = typeof body.sketch_data_url === "string" && body.sketch_data_url.startsWith("data:image/") ? body.sketch_data_url : null;
    if (!attempt && !sketch && !showPivot) return c.json({ error: "write an attempt or sketch first" }, 400);

    const attemptId = typeof body.attempt_id === "string" && body.attempt_id.trim() ? body.attempt_id.trim() : uuidv7();
    const existingAttempt = store.getAttempt(attemptId);
    if (existingAttempt?.status === "passed" && existingAttempt.result) {
      return c.json(existingAttempt.result);
    }

    const now = Date.now();
    const { scheduler, scores } = scoreAll(state, store.scheduler, now);
    const preScore = scores.get(u.id);
    const trend = latencyTrend(state, u);
    const habits = activeHabits(state);
    const latencyMs = typeof body.latency_ms === "number" && body.latency_ms >= 0 ? Math.round(body.latency_ms) : null;
    const hintsUsed = Math.max(0, Math.round(body.hints_used ?? 0));

    const history = Array.isArray(body.history)
      ? body.history
          .filter((h): h is { attempt: string; feedback: string } => typeof h?.attempt === "string" && typeof h?.feedback === "string")
          .slice(-4)
      : undefined;

    const existingUnits = Object.values(state.units)
      .filter((u2) => u2.status === "active" && !u2.observe_only)
      .map((u2) => u2.text);

    return respondMaybeStream(c, async (onText, onPerf, signal) => {
      const verdict = await judge.check(
        {
          sessionKey: `drill:${attemptId}`,
          prompt,
          expectedCrux,
          firstContact,
          showPivot,
          ...(bundledUnits.length > 0 ? { bundledUnits: bundledUnits.map((b) => b.text) } : {}),
          unitText: u.text,
          unitKind: u.kind,
          depth,
          restsOn,
          existingUnits,
          attempt,
          sketchDataUrl: sketch,
          history,
          activeHabits: habits.map((h) => h.text),
          learnerMemory: learnerMemoryOf(store),
          latencyMs,
          hintsUsed: showPivot ? Math.max(1, hintsUsed) : hintsUsed,
        },
        onText,
        onPerf,
        signal,
      );

      if (signal?.aborted) {
        return { ...verdict, attempt_id: attemptId, added_units: [], probe_id: null, latency_ms: latencyMs, prev_latency_ms: trend.prev_ms, next_in_ms: null, scheduler };
      }

      const addedUnits = autoAddPrereqs(store, u, verdict.missing_prereqs, now);

      let probeId: string | null = null;
      let nextInMs: number | null = null;
      const creditedUnitIds: string[] = [];
      if (verdict.ok && !verdict.failed) {
        const ev = makeEvent(
          "unit.probed",
          {
            unit_id: u.id,
            depth,
            slot: "seam",
            prompt: prompt.slice(0, 1000),
            answer_message_id: null,
            grade: verdict.grade,
            corrected_grade: null,
            hints: showPivot ? Math.max(1, hintsUsed) : hintsUsed,
            latency_ms: latencyMs,
            scheduler,
            predicted_recall: preScore ? preScore.p_imm : null,
          },
          { id: uuidv7(now), device_id: DRILL_DEVICE, ts: now },
        );
        store.append([ev]);
        probeId = ev.id;

        // Synthesis multiplier: passing a bundled multi-unit rep cleanly credits companion units in context.
        if (verdict.grade !== "again" && !showPivot && bundledUnits.length > 0) {
          let offset = 2;
          for (const companion of bundledUnits) {
            const cPre = scores.get(companion.id);
            store.append([
              makeEvent(
                "unit.probed",
                {
                  unit_id: companion.id,
                  depth: pickDrillDepth(companion, store.state),
                  slot: "in_context",
                  prompt: prompt.slice(0, 1000),
                  answer_message_id: null,
                  grade: "good",
                  corrected_grade: null,
                  hints: 0,
                  latency_ms: latencyMs,
                  scheduler,
                  predicted_recall: cPre ? cPre.p_imm : null,
                },
                { id: uuidv7(now + offset++), device_id: DRILL_DEVICE, ts: now + offset },
              ),
            ]);
            creditedUnitIds.push(companion.id);
          }
        }

        // If a personal Thinking Move appeared unprompted, log it automatically.
        if (verdict.habit_observed) {
          const matched = habits.find((h) => h.text.toLowerCase() === verdict.habit_observed!.toLowerCase());
          if (matched) {
            store.append([
              makeEvent(
                "unit.observed",
                { unit_id: matched.id, present: true, note: `Appeared during drill on "${u.text.slice(0, 80)}"`, page_id: null, message_id: null, elapsed_ms: latencyMs },
                { id: uuidv7(now + 10), device_id: DRILL_DEVICE, ts: now + 10 },
              ),
            ]);
          }
        }

        const after = scoreAll(store.state, store.scheduler, now + 12);
        nextInMs = after.scores.get(u.id)?.next_in_ms ?? null;
        // Include any due rests_on prerequisites that became non-due via downward DAG credit.
        for (const pid of u.rests_on) {
          const beforeScore = scores.get(pid);
          const afterScore = after.scores.get(pid);
          const wasDue = beforeScore ? beforeScore.reviews === 0 || (beforeScore.next_in_ms ?? 0) <= 0 : false;
          const nowNotDue = afterScore ? (afterScore.next_in_ms ?? 0) > 0 : false;
          if (wasDue && nowNotDue && !creditedUnitIds.includes(pid)) creditedUnitIds.push(pid);
        }
        // Pre-warm this unit's next variant/depth plus top upcoming due cards so the next load is ~80ms.
        const postState = store.state;
        const refreshedU = postState.units[u.id] ?? u;
        const postCandidates = rankDrillCandidates(
          Object.values(postState.units).filter((x) => x.status === "active" && !x.observe_only && x.id !== u.id),
          postState,
          after.scores,
        ).slice(0, 3);
        const warmTargets = [refreshedU, ...postCandidates];
        judge.warmPrompts(
          warmTargets.map((item) => {
            const d = pickDrillDepth(item, postState);
            const ro = item.rests_on.map((id) => postState.units[id]?.text ?? id);
            const st = unitExposureStats(postState, item.id, d, now + 2);
            return {
              unit: item,
              restsOn: ro,
              depth: d,
              variant: st.depthPasses,
              priorPrompts: st.priorPrompts,
              delayedTransfer: st.passes >= 1 && st.daysSinceLastExposure >= 5,
            };
          }),
        );
        scheduleIdleDream(user.id, store);
      }

      const payload = {
        ...verdict,
        attempt_id: attemptId,
        added_units: addedUnits,
        ...(creditedUnitIds.length > 0 ? { credited_unit_ids: creditedUnitIds } : {}),
        probe_id: probeId,
        latency_ms: latencyMs,
        prev_latency_ms: trend.prev_ms,
        next_in_ms: nextInMs,
        scheduler,
      };

      store.abandonActiveAttempts(u.id, attemptId, now);
      store.upsertAttempt({
        attempt_id: attemptId,
        unit_id: u.id,
        depth,
        prompt,
        first_attempt: existingAttempt?.first_attempt || attempt || "(sketch)",
        turns: [
          {
            user: attempt,
            coach: verdict.message,
            ...(verdict.failed ? { failed: true } : {}),
            ...(verdict.annotations && verdict.annotations.length > 0 ? { annotations: verdict.annotations } : {}),
            ...(addedUnits.length > 0 ? { added: addedUnits } : {}),
          },
        ],
        status: verdict.ok && !verdict.failed ? "passed" : "active",
        assistance_count: hintsUsed,
        active_ms: latencyMs,
        probe_id: probeId,
        grade: verdict.ok && !verdict.failed ? verdict.grade : null,
        result: verdict.ok && !verdict.failed ? payload : null,
        created_at: existingAttempt?.created_at ?? now,
        updated_at: now,
      });

      return payload;
    }, "check");
  });

  app.post("/api/drill/followup", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const body = (await c.req.json().catch(() => null)) as {
      attempt_id?: string;
      unit_id?: string;
      depth?: Depth;
      prompt?: string;
      attempt?: string;
      feedback?: string;
      turns?: { role: "user" | "assistant"; text: string }[];
      question?: string;
      revised_attempt?: boolean;
      show_pivot?: boolean;
      modality?: RepModality;
      bundled_unit_ids?: string[];
      sketch_data_url?: string | null;
      latency_ms?: number | null;
      hints_used?: number;
    } | null;
    const sketch = typeof body?.sketch_data_url === "string" && body.sketch_data_url.startsWith("data:image/") ? body.sketch_data_url : null;
    const showPivot = Boolean(body?.show_pivot);
    if (!body?.unit_id || (!body.question?.trim() && !sketch && !showPivot)) return c.json({ error: "unit_id and reply or sketch required" }, 400);
    const state = store.state;
    const u = resolveUnit(state, body.unit_id);
    if (!u) return c.json({ error: "unknown unit" }, 404);
    const restsOn = u.rests_on.map((id) => state.units[id]?.text ?? id);
    const depth: Depth = body.depth && ["recall", "rebuild", "explain", "use"].includes(body.depth) ? body.depth : pickDrillDepth(u, state);
    const preStats = unitExposureStats(state, u.id, depth, Date.now());
    const bundledIds = Array.isArray(body.bundled_unit_ids)
      ? body.bundled_unit_ids.filter((id): id is string => typeof id === "string" && id !== u.id).slice(0, 3)
      : [];
    const bundledUnits = bundledIds
      .map((id) => resolveUnit(state, id))
      .filter((x): x is Unit => Boolean(x && x.status === "active" && !x.observe_only && x.id !== u.id));
    const reqModality: RepModality =
      body.modality && ["direct", "fix_bug", "faded_skeleton", "contrast", "synthesis"].includes(body.modality)
        ? body.modality
        : pickRepModality(u, state, depth, bundledUnits);
    const expectedCrux =
      judge.peekPromptEntry(u, depth, restsOn, preStats.depthPasses, reqModality, bundledIds)?.crux ??
      judge.peekPromptEntry(u, depth, restsOn, preStats.depthPasses)?.crux;
    const firstContact = u.told && preStats.passes === 0;
    const turns = Array.isArray(body.turns)
      ? body.turns.filter((t): t is { role: "user" | "assistant"; text: string } => (t?.role === "user" || t?.role === "assistant") && typeof t?.text === "string").slice(-20)
      : [];
    const attemptId = typeof body.attempt_id === "string" && body.attempt_id.trim() ? body.attempt_id.trim() : uuidv7();
    const existingAttempt = store.getAttempt(attemptId);
    if (existingAttempt?.status === "passed" && existingAttempt.result) {
      return c.json(existingAttempt.result);
    }

    const now = Date.now();
    const { scheduler, scores } = scoreAll(state, store.scheduler, now);
    const preScore = scores.get(u.id);
    const trend = latencyTrend(state, u);
    const habits = activeHabits(state);
    const latencyMs = typeof body.latency_ms === "number" && body.latency_ms >= 0 ? Math.round(body.latency_ms) : null;
    const assistanceCount = Math.max(1, Math.round(body.hints_used ?? 0), 1 + Math.floor(turns.length / 2));

    const existingUnits = Object.values(state.units)
      .filter((u2) => u2.status === "active" && !u2.observe_only)
      .map((u2) => u2.text);

    const questionText = (body.question ?? "").trim();

    return respondMaybeStream(c, async (onText, onPerf, signal) => {
      const verdict = await judge.continueRep(
        {
          sessionKey: `drill:${attemptId}`,
          prompt: body.prompt ?? "",
          expectedCrux,
          firstContact,
          showPivot,
          ...(bundledUnits.length > 0 ? { bundledUnits: bundledUnits.map((b) => b.text) } : {}),
          unitText: u.text,
          unitKind: u.kind,
          depth,
          restsOn,
          existingUnits,
          activeHabits: habits.map((h) => h.text),
          learnerMemory: learnerMemoryOf(store),
          attempt: body.attempt ?? "",
          feedback: body.feedback ?? "",
          turns,
          reply: questionText,
          revisedAttempt: Boolean(body.revised_attempt),
          sketchDataUrl: sketch,
          latencyMs,
          hintsUsed: assistanceCount,
        },
        onText,
        onPerf,
        signal,
      );

      if (signal?.aborted) {
        return { ...verdict, attempt_id: attemptId, added_units: [], probe_id: null, latency_ms: latencyMs, prev_latency_ms: trend.prev_ms, next_in_ms: null, scheduler };
      }

      const addedUnits = autoAddPrereqs(store, u, verdict.missing_prereqs, now);

      let probeId: string | null = null;
      let nextInMs: number | null = null;
      const creditedUnitIds: string[] = [];
      if (verdict.ok && !verdict.failed) {
        const ev = makeEvent(
          "unit.probed",
          {
            unit_id: u.id,
            depth,
            slot: "seam",
            prompt: (body.prompt ?? "").slice(0, 1000),
            answer_message_id: null,
            grade: verdict.grade,
            corrected_grade: null,
            hints: assistanceCount,
            latency_ms: latencyMs,
            scheduler,
            predicted_recall: preScore ? preScore.p_imm : null,
          },
          { id: uuidv7(now), device_id: DRILL_DEVICE, ts: now },
        );
        store.append([ev]);
        probeId = ev.id;

        if (verdict.grade !== "again" && !showPivot && bundledUnits.length > 0) {
          let offset = 2;
          for (const companion of bundledUnits) {
            const cPre = scores.get(companion.id);
            store.append([
              makeEvent(
                "unit.probed",
                {
                  unit_id: companion.id,
                  depth: pickDrillDepth(companion, store.state),
                  slot: "in_context",
                  prompt: (body.prompt ?? "").slice(0, 1000),
                  answer_message_id: null,
                  grade: "good",
                  corrected_grade: null,
                  hints: 0,
                  latency_ms: latencyMs,
                  scheduler,
                  predicted_recall: cPre ? cPre.p_imm : null,
                },
                { id: uuidv7(now + offset++), device_id: DRILL_DEVICE, ts: now + offset },
              ),
            ]);
            creditedUnitIds.push(companion.id);
          }
        }

        if (verdict.habit_observed) {
          const matched = habits.find((h) => h.text.toLowerCase() === verdict.habit_observed!.toLowerCase());
          if (matched) {
            store.append([
              makeEvent(
                "unit.observed",
                { unit_id: matched.id, present: true, note: `Appeared during drill on "${u.text.slice(0, 80)}"`, page_id: null, message_id: null, elapsed_ms: latencyMs },
                { id: uuidv7(now + 10), device_id: DRILL_DEVICE, ts: now + 10 },
              ),
            ]);
          }
        }
        const after = scoreAll(store.state, store.scheduler, now + 12);
        nextInMs = after.scores.get(u.id)?.next_in_ms ?? null;
        for (const pid of u.rests_on) {
          const beforeScore = scores.get(pid);
          const afterScore = after.scores.get(pid);
          const wasDue = beforeScore ? beforeScore.reviews === 0 || (beforeScore.next_in_ms ?? 0) <= 0 : false;
          const nowNotDue = afterScore ? (afterScore.next_in_ms ?? 0) > 0 : false;
          if (wasDue && nowNotDue && !creditedUnitIds.includes(pid)) creditedUnitIds.push(pid);
        }
        // Pre-warm this unit's next variant/depth plus top upcoming due cards so the next load is ~80ms.
        const postState = store.state;
        const refreshedU = postState.units[u.id] ?? u;
        const postCandidates = rankDrillCandidates(
          Object.values(postState.units).filter((x) => x.status === "active" && !x.observe_only && x.id !== u.id),
          postState,
          after.scores,
        ).slice(0, 3);
        const warmTargets = [refreshedU, ...postCandidates];
        judge.warmPrompts(
          warmTargets.map((item) => {
            const d = pickDrillDepth(item, postState);
            const ro = item.rests_on.map((id) => postState.units[id]?.text ?? id);
            const st = unitExposureStats(postState, item.id, d, now + 2);
            return {
              unit: item,
              restsOn: ro,
              depth: d,
              variant: st.depthPasses,
              priorPrompts: st.priorPrompts,
              delayedTransfer: st.passes >= 1 && st.daysSinceLastExposure >= 5,
            };
          }),
        );
        scheduleIdleDream(user.id, store);
      }

      const payload = {
        ...verdict,
        attempt_id: attemptId,
        added_units: addedUnits,
        ...(creditedUnitIds.length > 0 ? { credited_unit_ids: creditedUnitIds } : {}),
        probe_id: probeId,
        latency_ms: latencyMs,
        prev_latency_ms: trend.prev_ms,
        next_in_ms: nextInMs,
        scheduler,
      };

      const prevStoredTurns =
        existingAttempt?.turns && existingAttempt.turns.length > 0
          ? existingAttempt.turns.filter((t) => !t.failed)
          : [{ user: body.attempt ?? "", coach: body.feedback ?? "" }];

      store.upsertAttempt({
        attempt_id: attemptId,
        unit_id: u.id,
        depth,
        prompt: body.prompt ?? "",
        first_attempt: existingAttempt?.first_attempt || (body.attempt ?? ""),
        turns: [
          ...prevStoredTurns,
          {
            user: questionText,
            coach: verdict.message,
            ...(verdict.failed ? { failed: true } : {}),
            ...(verdict.annotations && verdict.annotations.length > 0 ? { annotations: verdict.annotations } : {}),
            ...(addedUnits.length > 0 ? { added: addedUnits } : {}),
          },
        ],
        status: verdict.ok && !verdict.failed ? "passed" : "active",
        assistance_count: assistanceCount,
        active_ms: latencyMs,
        probe_id: probeId,
        grade: verdict.ok && !verdict.failed ? verdict.grade : null,
        result: verdict.ok && !verdict.failed ? payload : null,
        created_at: existingAttempt?.created_at ?? now,
        updated_at: now,
      });

      return payload;
    }, "follow-up");
  });

  app.post("/api/drill/attempts/:id/abandon", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    const id = c.req.param("id");
    const existing = store.getAttempt(id);
    if (existing && existing.status === "active") {
      store.upsertAttempt({ ...existing, status: "abandoned", updated_at: Date.now() });
    }
    judge.closeSession(`drill:${id}`);
    return c.json({ ok: true, attempt_id: id });
  });

  app.post("/api/drill/miss", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const body = (await c.req.json().catch(() => null)) as {
      unit_id?: string;
      depth?: Depth;
      prompt?: string;
      latency_ms?: number | null;
      hints_used?: number;
    } | null;
    if (!body?.unit_id) return c.json({ error: "unit_id required" }, 400);
    const state = store.state;
    const u = resolveUnit(state, body.unit_id);
    if (!u) return c.json({ error: "unknown unit" }, 404);
    const now = Date.now();
    const { scheduler, scores } = scoreAll(state, store.scheduler, now);
    const preScore = scores.get(u.id);
    const depth: Depth = body.depth && ["recall", "rebuild", "explain", "use"].includes(body.depth) ? body.depth : pickDrillDepth(u, state);
    const ev = makeEvent(
      "unit.probed",
      {
        unit_id: u.id,
        depth,
        slot: "seam",
        prompt: (body.prompt ?? "").slice(0, 1000),
        answer_message_id: null,
        grade: "again",
        corrected_grade: null,
        hints: Math.max(0, Math.round(body.hints_used ?? 0)),
        latency_ms: typeof body.latency_ms === "number" && body.latency_ms >= 0 ? Math.round(body.latency_ms) : null,
        scheduler,
        predicted_recall: preScore ? preScore.p_imm : null,
      },
      { id: uuidv7(now), device_id: DRILL_DEVICE, ts: now },
    );
    store.append([ev]);
    const after = scoreAll(store.state, store.scheduler, now + 1);
    return c.json({ ok: true, probe_id: ev.id, next_in_ms: after.scores.get(u.id)?.next_in_ms ?? null });
  });

  app.post("/api/drill/override", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const body = (await c.req.json().catch(() => null)) as { unit_id?: string; probe_id?: string; grade?: Grade; note?: string } | null;
    if (!body?.unit_id || !body?.probe_id) return c.json({ error: "unit_id and probe_id required" }, 400);
    const grade: Grade = body.grade && ["again", "hard", "good", "easy"].includes(body.grade) ? body.grade : "again";
    const now = Date.now();
    const ev = makeEvent(
      "unit.probed",
      { unit_id: body.unit_id, corrects: body.probe_id, grade, note: body.note ?? "Marked fragile by learner" },
      { id: uuidv7(now), device_id: DRILL_DEVICE, ts: now },
    );
    store.append([ev]);
    const after = scoreAll(store.state, store.scheduler, now + 1);
    scheduleIdleDream(user.id, store);
    return c.json({ ok: true, grade, next_in_ms: after.scores.get(body.unit_id)?.next_in_ms ?? null });
  });

  app.post("/api/drill/audit", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const body = (await c.req.json().catch(() => null)) as {
      unit_id?: string;
      depth?: Depth;
      prompt?: string;
      probe_id?: string | null;
      grade?: Grade;
      beats?: { user: string; coach: string }[];
    } | null;
    if (!body?.unit_id) return c.json({ error: "unit_id required" }, 400);
    const state = store.state;
    const u = resolveUnit(state, body.unit_id);
    if (!u) return c.json({ error: "unknown unit" }, 404);
    const depth: Depth = body.depth && ["recall", "rebuild", "explain", "use"].includes(body.depth) ? body.depth : pickDrillDepth(u, state);
    const grade: Grade = body.grade && ["again", "hard", "good", "easy"].includes(body.grade) ? body.grade : "good";
    const beats = Array.isArray(body.beats)
      ? body.beats.filter((b): b is { user: string; coach: string } => typeof b?.user === "string" && typeof b?.coach === "string").slice(-12)
      : [];
    const existingUnits = Object.values(state.units)
      .filter((x) => x.status === "active" && !x.observe_only)
      .map((x) => x.text);

    const t0 = Date.now();
    let auditRec: PerfRecord | undefined;
    try {
      const audit = await judge.auditRep(
        {
          unitText: u.text,
          unitKind: u.kind,
          depth,
          prompt: (body.prompt ?? "").trim(),
          grade,
          beats,
          existingUnits,
          learnerMemory: learnerMemoryOf(store),
        },
        (r) => {
          auditRec = r;
        },
      );

      const now = Date.now();
      const changes: string[] = [];
      let effectiveText = u.text;
      let appliedGrade: Grade = grade;

      if (audit.reworded_unit && audit.reworded_unit.toLowerCase() !== u.text.toLowerCase()) {
        store.append([
          makeEvent(
            "unit.reworded",
            { unit_id: u.id, text: audit.reworded_unit, by: "tutor" },
            { id: uuidv7(now), device_id: DRILL_DEVICE, ts: now },
          ),
        ]);
        effectiveText = audit.reworded_unit;
        changes.push("Reworded unit on map");
      }

      const addedUnits = autoAddPrereqs(store, store.state.units[u.id] ?? u, audit.missing_prereqs, now + 2);
      if (addedUnits.length > 0) {
        changes.push(`Added ${addedUnits.length} prerequisite${addedUnits.length === 1 ? "" : "s"} to map`);
      }

      if (audit.recommended_grade && body.probe_id && audit.recommended_grade !== grade) {
        store.append([
          makeEvent(
            "unit.probed",
            { unit_id: u.id, corrects: body.probe_id, grade: audit.recommended_grade, note: "Adjusted by rep audit" },
            { id: uuidv7(now + 4), device_id: DRILL_DEVICE, ts: now + 4 },
          ),
        ]);
        appliedGrade = audit.recommended_grade;
        changes.push(`Adjusted grade → ${audit.recommended_grade}`);
      }

      if (audit.improved_prompt) {
        const refreshedUnit = store.state.units[u.id] ?? u;
        const restsOn = refreshedUnit.rests_on.map((id) => store.state.units[id]?.text ?? id);
        const nextDepth = pickDrillDepth(refreshedUnit, store.state);
        const stats = unitExposureStats(store.state, u.id, nextDepth, now + 5);
        judge.overrideCachedPrompt(
          { id: u.id, text: effectiveText },
          nextDepth,
          restsOn,
          stats.depthPasses,
          audit.improved_prompt,
        );
        changes.push("Updated prompt for next review");
      }

      const after = scoreAll(store.state, store.scheduler, now + 6);
      const nextInMs = after.scores.get(u.id)?.next_in_ms ?? null;
      scheduleIdleDream(user.id, store);

      const finalRec: PerfRecord = { ...(auditRec ?? { ts: t0, op: "audit", ok: true }), total_ms: Date.now() - t0 };
      perfLog?.record(finalRec);
      c.header("Server-Timing", formatServerTiming(finalRec));

      return c.json({
        analysis: audit.analysis,
        changes,
        added_units: addedUnits,
        grade: appliedGrade,
        next_in_ms: nextInMs,
        ...(audit.reworded_unit ? { reworded_unit: effectiveText } : {}),
        ...(audit.improved_prompt ? { improved_prompt: audit.improved_prompt } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not audit this rep.";
      perfLog?.record({ ...(auditRec ?? { ts: t0, op: "audit", ok: false }), ok: false, total_ms: Date.now() - t0, error: msg });
      return c.json({ error: msg }, 502);
    }
  });

  app.get("/api/map", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const state = store.state;
    const now = Date.now();
    const { scheduler, scores } = scoreAll(state, store.scheduler, now);

    const units = Object.values(state.units)
      .filter((u) => u.status === "active" && !u.observe_only)
      .map((u) => {
        const s = scores.get(u.id);
        const trend = latencyTrend(state, u);
        return {
          id: u.id,
          text: u.text,
          kind: u.kind,
          topic: u.topic,
          status: u.status,
          rests_on: u.rests_on,
          told: u.told,
          rebuilt_once: u.rebuilt_once,
          p_imm: s?.p_imm ?? 0,
          reviews: s?.reviews ?? 0,
          next_in_ms: s?.next_in_ms ?? null,
          first_latency_ms: trend.first_ms,
          last_latency_ms: trend.prev_ms,
          found_at: u.found_at,
        };
      });

    const habits = activeHabits(state).map((h) => ({
      id: h.id,
      text: h.text,
      kind: h.kind,
      topic: h.topic,
      present: h.observations.present,
      missing: h.observations.missing,
      found_at: h.found_at,
    }));

    const pages = Object.values(state.pages)
      .map((p) => ({ id: p.id, title: p.title, created_at: p.created_at, edited_at: p.edited_at, rev: p.rev }))
      .sort((a, b) => b.edited_at - a.edited_at);

    const goals = Object.values(state.goals).filter((g) => g.active);

    return c.json({ scheduler, units, habits, pages, goals });
  });

  // --- Agent Memory (learner.md) & Offline Dreaming ---

  app.get("/api/memory", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const memory = store.getAgentMemory("learner") ?? {
      key: "learner",
      content: "",
      last_dream_seq: 0,
      last_dream_at: 0,
      dream_count: 0,
      updated_at: 0,
      updated_by: "dream" as const,
    };
    const logs = store.listDreamLogs(8);
    const pending_events = countMeaningfulEventsSince(store, memory.last_dream_seq);
    return c.json({ memory, logs, dreaming: dreamingUsers.has(user.id), pending_events });
  });

  app.put("/api/memory", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const body = (await c.req.json().catch(() => null)) as { content?: string } | null;
    if (typeof body?.content !== "string") return c.json({ error: "content required" }, 400);
    const content = body.content.trim().slice(0, 4000);
    const prev = store.getAgentMemory("learner");
    const now = Date.now();
    const rec: AgentMemoryRecord = {
      key: "learner",
      content,
      last_dream_seq: prev?.last_dream_seq ?? 0,
      last_dream_at: prev?.last_dream_at ?? 0,
      dream_count: prev?.dream_count ?? 0,
      updated_at: now,
      updated_by: "learner",
    };
    store.saveAgentMemory(rec);
    return c.json({ memory: rec });
  });

  app.post("/api/memory/dream", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    try {
      const result = await runDreamForUser(user.id, store, { force: true });
      const logs = store.listDreamLogs(8);
      return c.json({ ...result, logs });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Could not run Dream consolidation." }, 502);
    }
  });

  app.post("/api/units", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const body = (await c.req.json().catch(() => null)) as {
      text?: string;
      kind?: string;
      topic?: string | null;
      rests_on?: string[];
      observe_only?: boolean;
      told?: boolean;
    } | null;
    const text = body?.text?.trim();
    if (!text) return c.json({ error: "text required" }, 400);
    const now = Date.now();
    const unit_id = uuidv7(now);
    const observe_only = Boolean(body?.observe_only);
    const kind = body?.kind?.trim() || (observe_only ? "thinking move" : "move");
    const topic = body?.topic?.trim() || null;
    const ev = makeEvent(
      "unit.found",
      {
        unit_id,
        text,
        kind,
        topic,
        rests_on: Array.isArray(body?.rests_on) ? body.rests_on : [],
        origin: observe_only ? "observed" : "need",
        told: Boolean(body?.told),
        observe_only,
        message_id: null,
      },
      { id: uuidv7(now), device_id: DRILL_DEVICE, ts: now },
    );
    store.append([ev]);
    if (!observe_only) {
      judge.warmPrompts([{ unit: { id: unit_id, text, kind, topic }, restsOn: [], depth: "recall" as Depth }]);
    }
    return c.json({ unit_id, text, observe_only });
  });

  app.post("/api/units/:id/remove", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    const u = resolveUnit(store.state, c.req.param("id"));
    if (!u) return c.json({ error: "unknown unit" }, 404);
    if (u.status === "retired") return c.json({ ok: true, unit_id: u.id });
    const now = Date.now();
    const ev = makeEvent("unit.retired", { unit_id: u.id, reason: "Removed by learner" }, { id: uuidv7(now), device_id: DRILL_DEVICE, ts: now });
    store.append([ev]);
    return c.json({ ok: true, unit_id: u.id });
  });

  // --- First-Contact Interactive Briefings (SQLite-backed per user, atomic & cross-device) ---

  app.get("/api/frontiers", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    ensureBriefingsMigrated(user.id, store);
    return c.json({ frontiers: store.listBriefings().map(briefingToFrontier) });
  });

  app.post("/api/frontiers", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    ensureBriefingsMigrated(user.id, store);
    const body = (await c.req.json().catch(() => null)) as { request?: string } | null;
    const request = (body?.request ?? "").trim();
    if (!request) return c.json({ error: "describe a file, paper, chapter, or topic first" }, 400);

    const state = store.state;
    const now = Date.now();
    const { scores } = scoreAll(state, store.scheduler, now);
    const existingUnits = Object.values(state.units)
      .filter((u) => u.status === "active" && !u.observe_only)
      .map((u) => {
        const s = scores.get(u.id);
        return { text: u.text, p_imm: s?.p_imm ?? 0, reviews: s?.reviews ?? 0 };
      });

    const t0 = Date.now();
    let planRec: PerfRecord | undefined;
    try {
      const planned = await judge.planFrontier(
        {
          request,
          existingUnits,
          learnerMemory: learnerMemoryOf(store),
        },
        (r) => {
          planRec = r;
        },
        c.req.raw.signal,
      );
      const record: BriefingRecord = {
        id: uuidv7(now),
        title: planned.title,
        source: request,
        body: planned.body,
        skipped_known: planned.skipped_known,
        cruxes: planned.cruxes,
        demonstrated_cruxes: [],
        turns: [],
        created_at: now,
        updated_at: now,
      };
      store.saveBriefing(record);
      const finalRec: PerfRecord = { ...(planRec ?? { ts: t0, op: "briefing-plan", ok: true }), total_ms: Date.now() - t0 };
      perfLog?.record(finalRec);
      c.header("Server-Timing", formatServerTiming(finalRec));
      return c.json({ frontier: briefingToFrontier(record) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not generate briefing.";
      perfLog?.record({ ...(planRec ?? { ts: t0, op: "briefing-plan", ok: false }), ok: false, total_ms: Date.now() - t0, error: msg });
      return c.json({ error: msg }, 502);
    }
  });

  app.delete("/api/frontiers/:id", (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    ensureBriefingsMigrated(user.id, store);
    const id = c.req.param("id");
    store.deleteBriefing(id);
    frontiers.remove(user.id, id);
    judge.closeSession(`briefing:${id}`);
    return c.json({ ok: true, id });
  });

  app.post("/api/frontiers/:id/respond", async (c) => {
    const { user } = c.get("session");
    const store = stores.get(user.id);
    store.catchUp();
    ensureBriefingsMigrated(user.id, store);
    const frontierId = c.req.param("id");
    const frontier = store.getBriefing(frontierId);
    if (!frontier) return c.json({ error: "unknown briefing" }, 404);

    const body = (await c.req.json().catch(() => null)) as {
      turns?: { role: "user" | "assistant"; text: string }[];
      reply?: string;
      test_me?: boolean;
      sketch_data_url?: string | null;
    } | null;
    const reply = (body?.reply ?? "").trim();
    const sketch = typeof body?.sketch_data_url === "string" && body.sketch_data_url.startsWith("data:image/") ? body.sketch_data_url : null;
    if (!reply && !sketch && !body?.test_me) return c.json({ error: "write a question or sketch first" }, 400);

    const turns = Array.isArray(body?.turns)
      ? body.turns.filter((t): t is { role: "user" | "assistant"; text: string } => (t?.role === "user" || t?.role === "assistant") && typeof t?.text === "string").slice(-20)
      : [];

    const state = store.state;
    const existingUnits = Object.values(state.units)
      .filter((u) => u.status === "active" && !u.observe_only)
      .map((u) => u.text);
    const habits = activeHabits(state).map((h) => h.text);

    return respondMaybeStream(
      c,
      async (onText, onPerf, signal) => {
        const res = await judge.discussBriefing(
          {
            sessionKey: `briefing:${frontier.id}`,
            title: frontier.title,
            source: frontier.source,
            body: frontier.body,
            cruxes: frontier.cruxes,
            demonstratedCruxes: frontier.demonstrated_cruxes,
            turns,
            reply,
            testMe: Boolean(body?.test_me),
            sketchDataUrl: sketch,
            existingUnits,
            activeHabits: habits,
            learnerMemory: learnerMemoryOf(store),
          },
          onText,
          onPerf,
          signal,
        );

        if (signal?.aborted) {
          return { message: "", added_units: [], demonstrated_cruxes: frontier.demonstrated_cruxes };
        }

        const activeUnitTexts = Object.values(store.state.units)
          .filter((u) => u.status === "active")
          .map((u) => u.text);
        const added_units: { unit_id: string; text: string; kind: string; observe_only: boolean }[] = [];
        const now = Date.now();
        for (const [idx, u] of res.suggested_units.entries()) {
          if (isNearDuplicate(u.text, activeUnitTexts)) continue;
          activeUnitTexts.push(u.text);
          const unit_id = uuidv7(now + idx);
          store.append([
            makeEvent(
              "unit.found",
              {
                unit_id,
                text: u.text,
                kind: u.kind || (u.observe_only ? "thinking move" : "result"),
                topic: frontier.title,
                rests_on: [],
                origin: u.observe_only ? "observed" : "need",
                told: !Boolean(body?.test_me) && res.demonstrated_crux_index == null,
                observe_only: u.observe_only,
                message_id: null,
              },
              { id: uuidv7(now + idx), device_id: DRILL_DEVICE, ts: now + idx },
            ),
          ]);
          added_units.push({ unit_id, text: u.text, kind: u.kind, observe_only: u.observe_only });
        }
        if (added_units.length > 0) {
          judge.warmPrompts(
            added_units
              .filter((u) => !u.observe_only)
              .map((u) => ({ unit: { id: u.unit_id, text: u.text, kind: u.kind, topic: frontier.title }, restsOn: [], depth: "recall" as Depth })),
          );
        }

        const nextDemo = new Set(frontier.demonstrated_cruxes);
        if (typeof res.demonstrated_crux_index === "number") nextDemo.add(res.demonstrated_crux_index);
        const nextTurns = res.failed
          ? frontier.turns
          : [
              ...frontier.turns,
              {
                user: body?.test_me ? "Test me" : reply,
                coach: res.message,
                ...(added_units.length > 0 ? { added: added_units } : {}),
              },
            ].slice(-40);
        store.updateBriefingProgress(frontier.id, nextTurns, [...nextDemo].sort((a, b) => a - b), now);

        return {
          message: res.message,
          added_units,
          demonstrated_cruxes: [...nextDemo].sort((a, b) => a - b),
          ...(res.failed ? { failed: true } : {}),
        };
      },
      "briefing",
    );
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (webRoot && existsSync(join(webRoot, "index.html"))) {
    // Read on each request, so a rebuild is picked up without a restart.
    const index = join(webRoot, "index.html");
    app.get("/", (c) => {
      c.header("Cache-Control", "no-store");
      return c.html(readFileSync(index, "utf8"));
    });
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
    });
    app.use("*", serveStatic({ root: webRoot }));
    // Everything else is the app. /login/<token> lands here too: the page spends the token with a
    // POST, so a link preview that fetches the URL cannot use it up.
    app.get("*", (c) => {
      c.header("Cache-Control", "no-store");
      return c.html(readFileSync(index, "utf8"));
    });
  }

  return app;
}
