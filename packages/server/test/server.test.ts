import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeEvent, uuidv7, type MyelinEvent } from "@myelin/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Stores, startServer, type RunningServer } from "../src/index.js";

let dir: string;
let srv: RunningServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myelin-test-"));
  srv = await startServer({ port: 0, dataDir: dir });
});
afterEach(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A signed-in browser: a cookie jar of one, and an SSE reader. */
class Device {
  cookie = "";
  id = "";
  seen: (MyelinEvent & { seq: number })[] = [];
  ready = false;
  private abort = new AbortController();

  async login(link: string): Promise<Response> {
    const r = await fetch(`${srv.url}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: link }) });
    if (r.ok) {
      this.cookie = r.headers.get("set-cookie")!.split(";")[0]!;
      this.id = ((await r.clone().json()) as { device_id: string }).device_id;
    }
    return r;
  }

  api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${srv.url}${path}`, { ...init, headers: { "content-type": "application/json", cookie: this.cookie, ...(init.headers ?? {}) } });
  }

  message(text: string, id = uuidv7()): MyelinEvent {
    return makeEvent("message.added", { author: "learner", text }, { id, device_id: this.id, ts: Date.now() });
  }

  send(...events: unknown[]): Promise<Response> {
    return this.api("/api/events", { method: "POST", body: JSON.stringify({ events }) });
  }

  /** Opens the stream and parses events as they arrive. */
  async listen(lastEventId?: number): Promise<void> {
    this.abort = new AbortController();
    const headers: Record<string, string> = { cookie: this.cookie };
    if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
    const r = await fetch(`${srv.url}/api/stream`, { headers, signal: this.abort.signal });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
    void (async () => {
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += value;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const kind = block.match(/^event: (.*)$/m)?.[1];
            const data = block.match(/^data: (.*)$/m)?.[1];
            if (kind === "event" && data) this.seen.push(JSON.parse(data));
            if (kind === "ready") this.ready = true;
          }
        }
      } catch {
        /* aborted */
      }
    })();
  }

  stop(): void {
    this.abort.abort();
  }
}

async function until(f: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function twoDevices(): Promise<[Device, Device]> {
  const u = srv.registry.createUser("ada");
  const a = new Device();
  const b = new Device();
  expect((await a.login(`${srv.url}/login/${srv.registry.issueLink(u.id)}`)).status).toBe(200);
  expect((await b.login(srv.registry.issueLink(u.id))).status).toBe(200);
  return [a, b];
}

describe("server", () => {
  it("keeps two devices on one account in step", async () => {
    const [a, b] = await twoDevices();
    expect(a.id).not.toBe(b.id);
    await a.listen();
    await b.listen();
    await until(() => a.ready && b.ready);

    expect((await a.send(a.message("hello from the desk"))).status).toBe(200);
    expect((await b.send(b.message("hello from the phone"))).status).toBe(200);
    await Promise.all([a.send(a.message("one")), b.send(b.message("two")), a.send(a.message("three"))]);

    await until(() => a.seen.length === 5 && b.seen.length === 5);
    expect(a.seen).toEqual(b.seen);
    expect(a.seen.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(a.seen.slice(0, 2).map((e) => (e.payload as { text: string }).text)).toEqual(["hello from the desk", "hello from the phone"]);
    a.stop();
    b.stop();
  });

  it("resumes a stream from Last-Event-ID", async () => {
    const [a, b] = await twoDevices();
    for (const t of ["1", "2", "3"]) await a.send(a.message(t));
    await b.listen(2);
    await until(() => b.ready);
    expect(b.seen.map((e) => e.seq)).toEqual([3]);
    await a.send(a.message("4"));
    await until(() => b.seen.length === 2);
    expect(b.seen.map((e) => e.seq)).toEqual([3, 4]);
    b.stop();
  });

  it("treats a retry as a no-op and a reused id as a conflict", async () => {
    const [a] = await twoDevices();
    const m = a.message("once");
    const first = (await (await a.send(m)).json()) as { results: { seq: number; duplicate: boolean }[] };
    const again = (await (await a.send(m)).json()) as { results: { seq: number; duplicate: boolean }[] };
    expect(again.results[0]).toEqual({ ...first.results[0], duplicate: true });
    expect((await a.send({ ...m, payload: { ...m.payload, text: "changed" } })).status).toBe(409);
    const all = (await (await a.api("/api/events")).json()) as { events: unknown[]; head: number };
    expect(all.head).toBe(1);
  });

  it("rejects what a device may not write", async () => {
    const [a, b] = await twoDevices();
    expect((await a.send(b.message("as someone else"))).status).toBe(400);
    const tutor = makeEvent("message.added", { author: "tutor", text: "forged" }, { id: uuidv7(), device_id: a.id, ts: Date.now() });
    expect((await a.send(tutor)).status).toBe(403);
    const probe = { ...a.message("x"), type: "unit.probed" };
    expect((await a.send(probe)).status).toBe(403);
    // One bad event rejects the whole batch.
    expect((await a.send(a.message("fine"), { ...a.message("bad"), payload: { author: "learner" } })).status).toBe(400);
    expect((await a.api("/api/events").then((r) => r.json())) as { head: number }).toMatchObject({ head: 0 });
    // Writes must be JSON from this origin.
    expect((await a.api("/api/events", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await a.api("/api/events", { method: "POST", body: "{}", headers: { origin: "https://evil.example" } })).status).toBe(403);
  });

  it("signs in once per link and keeps users apart", async () => {
    const ada = srv.registry.createUser("ada");
    const bo = srv.registry.createUser("bo");
    const link = srv.registry.issueLink(ada.id);
    const a = new Device();
    expect((await a.login(link)).status).toBe(200);
    const thief = new Device();
    const r = await thief.login(link);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "That link has already been used or is not valid." });
    expect((await thief.api("/api/me")).status).toBe(401);

    const b = new Device();
    await b.login(srv.registry.issueLink(bo.id));
    await a.send(a.message("private"));
    expect(((await (await b.api("/api/events")).json()) as { events: unknown[] }).events).toEqual([]);
    expect(await (await b.api("/api/me")).json()).toMatchObject({ user: { name: "bo" }, head: 0 });
  });

  it("pushes events another process appends", async () => {
    const [a] = await twoDevices();
    await a.listen();
    await until(() => a.ready);
    const user = srv.registry.userByName("ada")!;
    const other = new Stores(dir);
    other.get(user.id).append([makeEvent("message.added", { author: "tutor", text: "from the CLI" }, { id: uuidv7(), device_id: "cli", ts: Date.now() })]);
    other.close();
    await until(() => a.seen.length === 1);
    expect(a.seen[0]!.device_id).toBe("cli");
    a.stop();
  });

  it("refuses to update or delete an event", async () => {
    const [a] = await twoDevices();
    await a.send(a.message("permanent"));
    const db = new DatabaseSync(Stores.pathFor(dir, srv.registry.userByName("ada")!.id));
    expect(() => db.exec("UPDATE events SET payload = '{}'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM events")).toThrow(/append-only/);
    db.close();
  });
});
