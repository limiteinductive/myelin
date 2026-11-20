// The tutor against Pi's faux provider: scripted replies, real sessions, real tools, real SSE.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeEvent, uuidv7, type MyelinEvent } from "@myelin/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIRST_RUN_TEXT, startServer, TUTOR_DEVICE, type Draft, type RunningServer, type User } from "../src/index.js";

let dir: string;
let srv: RunningServer;
let faux: ReturnType<typeof registerFauxProvider>;
let logs: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myelin-tutor-"));
  logs = [];
  faux = registerFauxProvider({ tokensPerSecond: 400 });
  const agentDir = join(dir, "pi");
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const fm = faux.getModel();
  runtime.registerProvider(fm.provider, {
    apiKey: "test",
    api: fm.api,
    baseUrl: fm.baseUrl,
    models: [{ type: "chat", id: fm.id, name: fm.name, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  } as never);
  const model = runtime.getModel(fm.provider, fm.id) as Model<Api>;
  srv = await startServer({
    port: 0,
    dataDir: dir,
    tutor: { systemPrompt: "You are a test tutor.", model: async () => ({ runtime, model }), agentDir, retry: false, thinkingLevel: "off", log: (m) => logs.push(m) },
  });
});
afterEach(async () => {
  await srv.close();
  faux.unregister();
  rmSync(dir, { recursive: true, force: true });
});

type Seen = MyelinEvent & { seq: number };

class Device {
  cookie = "";
  id = "";
  seen: Seen[] = [];
  drafts: Draft[] = [];
  ready = false;
  private abort = new AbortController();

  async login(user: User): Promise<void> {
    const r = await fetch(`${srv.url}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: srv.registry.issueLink(user.id) }) });
    expect(r.status).toBe(200);
    this.cookie = r.headers.get("set-cookie")!.split(";")[0]!;
    this.id = ((await r.json()) as { device_id: string }).device_id;
  }

  async say(text: string): Promise<void> {
    const e = makeEvent("message.added", { author: "learner", text }, { id: uuidv7(), device_id: this.id, ts: Date.now() });
    const r = await fetch(`${srv.url}/api/events`, { method: "POST", headers: { "content-type": "application/json", cookie: this.cookie }, body: JSON.stringify({ events: [e] }) });
    expect(r.status).toBe(200);
  }

  async listen(): Promise<void> {
    const r = await fetch(`${srv.url}/api/stream`, { headers: { cookie: this.cookie }, signal: this.abort.signal });
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
            if (kind === "tutor" && data) this.drafts.push(JSON.parse(data));
            if (kind === "ready") this.ready = true;
          }
        }
      } catch {
        /* aborted */
      }
    })();
  }

  messages(): { author: string; text: string; id: string; device_id: string }[] {
    return this.seen.filter((e) => e.type === "message.added").map((e) => ({ ...(e.payload as { author: string; text: string }), id: e.id, device_id: e.device_id }));
  }

  stop(): void {
    this.abort.abort();
  }
}

async function until(f: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Everything the model was shown, as one string. */
const shown = (context: unknown) => JSON.stringify(context);
const lastUser = (context: { messages: { role: string; content: unknown }[] }) => JSON.stringify(context.messages.findLast((m) => m.role === "user")?.content);

async function learner(name = "ada"): Promise<[User, Device]> {
  const u = srv.registry.createUser(name);
  const d = new Device();
  await d.login(u);
  return [u, d];
}

describe("tutor", () => {
  it("asks for a goal on the first run, once, without calling the model", async () => {
    const [, a] = await learner();
    await a.listen();
    await until(() => a.messages().length === 1);
    const b = new Device();
    b.cookie = a.cookie;
    await b.listen();
    await until(() => b.ready);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.messages()).toEqual([expect.objectContaining({ author: "tutor", text: FIRST_RUN_TEXT, device_id: TUTOR_DEVICE })]);
    expect(b.messages()).toHaveLength(1);
    expect(faux.state.callCount).toBe(0);
    a.stop();
    b.stop();
  });

  it("streams a draft, records the goal with a tool, then posts the reply with the draft's id", async () => {
    const [, a] = await learner();
    await a.listen();
    await until(() => a.messages().length === 1);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("set_goal", { text: "Learn linear algebra for the exam", due: "2026-12-20", topic: "linear algebra" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Good, three weeks. Start with what you know: what is a vector, in your own words?"),
    ]);
    await a.say("Linear algebra, exam on 20 December");
    await until(() => a.messages().length === 3);

    const goal = a.seen.find((e) => e.type === "goal.set")!;
    expect(goal.device_id).toBe(TUTOR_DEVICE);
    expect(goal.payload).toMatchObject({ text: "Learn linear algebra for the exam", topic: "linear algebra", active: true });
    expect(new Date((goal.payload as { due: number }).due).getDate()).toBe(20);

    const reply = a.messages()[2]!;
    expect(reply).toMatchObject({ author: "tutor", text: "Good, three weeks. Start with what you know: what is a vector, in your own words?" });
    const partial = a.drafts.filter((d) => d.id === reply.id && !d.done);
    expect(partial.length).toBeGreaterThan(0);
    expect(reply.text.startsWith(partial[0]!.text)).toBe(true);
    await until(() => a.drafts.some((d) => d.id === reply.id && d.done));
    expect(a.drafts.find((d) => d.done)).toMatchObject({ id: reply.id, text: reply.text });
    a.stop();
  });

  it("answers a message sent mid-turn in the next turn", async () => {
    const [, a] = await learner();
    await a.listen();
    await until(() => a.messages().length === 1);
    const prompts: string[] = [];
    const reply = (text: string): FauxResponseStep => (context) => {
      prompts.push(lastUser(context as never));
      return fauxAssistantMessage(text);
    };
    faux.setResponses([reply("A long first answer that takes a moment to stream out, word by word, slowly enough to interrupt."), reply("Second answer.")]);
    await a.say("first question");
    await until(() => a.drafts.some((d) => !d.done && d.text.length > 0));
    await a.say("and a second thing");
    await until(() => a.messages().length === 5);
    expect(a.messages().map((m) => m.author)).toEqual(["tutor", "learner", "learner", "tutor", "tutor"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("first question");
    expect(prompts[0]).not.toContain("second thing");
    expect(prompts[1]).toContain("second thing");
    expect(prompts[1]).not.toContain("first question");
    a.stop();
  });

  it("on a model error writes nothing and carries the message into the next turn", async () => {
    const [, a] = await learner();
    await a.listen();
    await until(() => a.messages().length === 1);
    let second = "";
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
      (context) => {
        second = lastUser(context as never);
        return fauxAssistantMessage("Back now. Which of those first?");
      },
    ]);
    await a.say("what is an eigenvector?");
    await until(() => a.drafts.some((d) => d.done && d.error));
    await new Promise((r) => setTimeout(r, 50));
    expect(a.messages()).toHaveLength(2);
    expect(logs.join("\n")).toContain("overloaded");

    await a.say("hello?");
    await until(() => a.messages().length === 4);
    expect(second).toContain("what is an eigenvector?");
    expect(second).toContain("hello?");
    a.stop();
  });

  it("greets a learner back after a break, with the goal and the thread in its context", async () => {
    const [u] = await learner();
    const store = srv.stores.get(u.id);
    const day = 86_400_000;
    const old = Date.now() - 2 * day;
    store.append([
      makeEvent("message.added", { author: "tutor", text: FIRST_RUN_TEXT }, { id: uuidv7(old), device_id: TUTOR_DEVICE, ts: old }),
      makeEvent("message.added", { author: "learner", text: "Group theory, by March" }, { id: uuidv7(old + 1000), device_id: "dev", ts: old + 1000 }),
      makeEvent("goal.set", { goal_id: uuidv7(old + 2000), text: "Group theory basics", due: old + 100 * day, topic: "group theory", unit_ids: [], active: true }, { id: uuidv7(old + 2000), device_id: TUTOR_DEVICE, ts: old + 2000 }),
    ]);
    let context = "";
    let prompt = "";
    faux.setResponses([
      (ctx) => {
        context = shown(ctx);
        prompt = lastUser(ctx as never);
        return fauxAssistantMessage("Welcome back. Shall we pick up subgroups?");
      },
    ]);
    const a = new Device();
    await a.login(u);
    await a.listen();
    await until(() => a.messages().length === 3);
    expect(prompt).toContain("[app: the learner just opened the app");
    expect(context).toContain("Group theory basics");
    expect(context).toContain("Group theory, by March");
    expect(context).toContain("The learner is ada.");
    expect(context).toContain("You are a test tutor.");
    expect(faux.state.callCount).toBe(1);
    a.stop();
  });

  it("stays quiet when the model calls stay_quiet", async () => {
    const [, a] = await learner();
    await a.listen();
    await until(() => a.messages().length === 1);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("stay_quiet", { reason: "nothing to add" }), { stopReason: "toolUse" }), fauxAssistantMessage("")]);
    await a.say("ok");
    await until(() => a.drafts.some((d) => d.done));
    await new Promise((r) => setTimeout(r, 50));
    expect(a.messages()).toHaveLength(2);
    a.stop();
  });
});
