// A friend brings their own model key: kept per learner, checked before it is kept, never sent back.
// No model is called: the check is a stub.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelKeys, NeedsKeyError, Registry, startServer, type ModelKeysOptions, type RunningServer } from "../src/index.js";

const SPEC = "google/gemini-4-neon";
const GOOD = "good-key-4567890";
const BAD = "bad-key-4567890";

let dir: string;
let registry: Registry;
let logs: string[];
const check: ModelKeysOptions["check"] = async (_choice, key) => {
  if (key !== GOOD) throw new Error(`API key not valid: ${key}`);
};
const keysFor = (extra: Partial<ModelKeysOptions> = {}) =>
  ModelKeys.create({ registry, agentDir: join(dir, "pi"), spec: SPEC, hostKey: "host-key-1234", check, log: (m) => logs.push(m), ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myelin-keys-"));
  registry = new Registry(dir);
  logs = [];
});
afterEach(() => {
  try {
    registry.close();
  } catch {
    // The server closed it.
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("registry", () => {
  it("keeps one key per learner and provider, in a file only its owner can read", () => {
    const bo = registry.createUser("Bo");
    expect(registry.modelKey(bo.id, "google")).toBeUndefined();
    registry.setModelKey(bo.id, "google", "k1");
    registry.setModelKey(bo.id, "google", "k2");
    expect(registry.modelKey(bo.id, "google")).toBe("k2");
    expect(registry.modelKey(bo.id, "deepseek")).toBeUndefined();
    expect(statSync(join(dir, "registry.sqlite")).mode & 0o777).toBe(0o600);
  });
});

describe("model keys", () => {
  it("runs the first user on the host's key and asks a friend for their own", async () => {
    const me = registry.createUser("me", 1);
    const bo = registry.createUser("Bo", 2);
    const keys = await keysFor();
    expect(keys.needed(me.id)).toBeNull();
    expect(keys.needed(bo.id)).toBe("Gemini");
    expect((await keys.model(me.id)).model.id).toBe("gemini-4-neon");
    await expect(keys.model(bo.id)).rejects.toBeInstanceOf(NeedsKeyError);

    await expect(keys.set(bo.id, "not a key")).rejects.toThrow(/does not look like a Gemini API key/);
    await expect(keys.set(bo.id, BAD)).rejects.toThrow(/Gemini did not accept that key/);
    expect(registry.modelKey(bo.id, "google")).toBeUndefined();
    // Why it failed is logged, without the key.
    expect(logs.join("\n")).toMatch(/did not work: API key not valid: \[key\]/);
    expect(logs.join("\n")).not.toContain(BAD);

    await keys.set(bo.id, `  ${GOOD}\n`);
    expect(registry.modelKey(bo.id, "google")).toBe(GOOD);
    expect(keys.needed(bo.id)).toBeNull();
    const [mine, theirs] = [await keys.model(me.id), await keys.model(bo.id)];
    expect(theirs.runtime).not.toBe(mine.runtime);
    expect(await keys.model(bo.id)).toBe(theirs);
  });

  it("asks everyone, the host too, when the host has no key", async () => {
    const me = registry.createUser("me", 1);
    const keys = await keysFor({ hostKey: undefined });
    expect(keys.needed(me.id)).toBe("Gemini");
  });

  it("uses the triage model only with a key for its provider", async () => {
    const me = registry.createUser("me", 1);
    const bo = registry.createUser("Bo", 2);
    const keys = await keysFor({ triage: { spec: "deepseek/deepseek-flash", hostKey: "host-ds-1234" } });
    expect((await keys.triage(me.id)).model.id).toBe("deepseek-flash");
    await keys.set(bo.id, GOOD);
    expect((await keys.triage(bo.id)).model.id).toBe("gemini-4-neon");
  });

  it("refuses a model Pi does not know, at once", async () => {
    await expect(keysFor({ spec: "google/no-such-model" })).rejects.toThrow(/does not know the model/);
  });
});

describe("the key route", () => {
  let srv: RunningServer;
  afterEach(() => srv.close());

  const signIn = async (userId: string) => {
    const r = await fetch(`${srv.url}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: registry.issueLink(userId) }) });
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    const api = (path: string, init: RequestInit = {}) => fetch(`${srv.url}${path}`, { ...init, headers: { "content-type": "application/json", cookie } });
    return { body: (await r.json()) as { needs_key: string | null }, api };
  };
  /** Opens the stream until the backlog has arrived, as a browser does on load. */
  const open = async (api: (p: string) => Promise<Response>) => {
    const r = await api("/api/stream");
    const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    while (!buf.includes("event: ready")) buf += (await reader.read()).value ?? "";
    await new Promise((res) => setTimeout(res, 50));
    await reader.cancel();
  };
  const messages = async (api: (p: string) => Promise<Response>) =>
    ((await (await api("/api/events")).json()) as { events: { type: string }[] }).events.filter((e) => e.type === "message.added");

  it("asks a friend for a key before the tutor's first words, and never sends it back", async () => {
    const me = registry.createUser("me", 1);
    const bo = registry.createUser("Bo", 2);
    const keys = await keysFor();
    srv = await startServer({
      port: 0,
      dataDir: dir,
      registry,
      keys,
      sandbox: false,
      tutor: { systemPrompt: "test", model: keys.model, triageModel: keys.triage, agentDir: join(dir, "pi"), retry: false, log: (m) => logs.push(m) },
    });

    const host = await signIn(me.id);
    expect(host.body.needs_key).toBeNull();

    const friend = await signIn(bo.id);
    expect(friend.body.needs_key).toBe("Gemini");
    expect(((await (await friend.api("/api/me")).json()) as { needs_key: string }).needs_key).toBe("Gemini");
    await open(friend.api);
    expect(await messages(friend.api)).toEqual([]);

    const refused = await friend.api("/api/key", { method: "POST", body: JSON.stringify({ key: BAD }) });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/did not accept/);

    const kept = await friend.api("/api/key", { method: "POST", body: JSON.stringify({ key: GOOD }) });
    expect(kept.status).toBe(200);
    const me2 = await (await friend.api("/api/me")).text();
    expect(me2).toContain('"needs_key":null');
    expect(me2).not.toContain(GOOD);
    // The tutor's first words follow the key.
    expect(await messages(friend.api)).toHaveLength(1);
    expect(await (await friend.api("/api/events")).text()).not.toContain(GOOD);
    expect(logs.join("\n")).not.toContain(GOOD);
  });
});
