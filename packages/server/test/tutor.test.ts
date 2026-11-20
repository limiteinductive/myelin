// The tutor against Pi's faux provider: scripted replies, real sessions, real tools, real SSE.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { groupAsides, makeEvent, mapRange, pageDoc, pageSchema, passageText, uuidv7, type Anchor, type AnchoredMessage, type MyelinEvent } from "@myelin/core";
import { Transform } from "prosemirror-transform";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIRST_RUN_TEXT, startServer, TUTOR_DEVICE, type Draft, type RunningServer, type TutorOptions, type User } from "../src/index.js";

let dir: string;
let srv: RunningServer;
let faux: ReturnType<typeof registerFauxProvider>;
let logs: string[];
/** The tutor's clock. Null means real time. */
let clock: number | null;
/** Starts the server, with tutor options on top of the test defaults. */
let serve: (extra?: Partial<TutorOptions>) => Promise<void>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myelin-tutor-"));
  logs = [];
  clock = null;
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
  serve = async (extra = {}) => {
    srv = await startServer({
      port: 0,
      dataDir: dir,
      tutor: {
        systemPrompt: "You are a test tutor.",
        model: async () => ({ runtime, model }),
        agentDir,
        retry: false,
        thinkingLevel: "off",
        log: (m) => logs.push(m),
        now: () => clock ?? Date.now(),
        observePauseMs: 60_000,
        ...extra,
      },
    });
  };
  await serve();
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

  async say(text: string, timing?: { shown_at: number; input_started_at: number; sent_at: number }): Promise<string> {
    const ts = timing?.sent_at ?? Date.now();
    const e = makeEvent("message.added", { author: "learner", text, ...(timing ? { timing } : {}) }, { id: uuidv7(ts), device_id: this.id, ts });
    await this.post(e);
    return e.id;
  }

  async post(e: MyelinEvent): Promise<void> {
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

  messages(): { author: string; text: string; id: string; device_id: string; cards: { kind: string; [k: string]: unknown }[] }[] {
    return this.seen.filter((e) => e.type === "message.added").map((e) => ({ ...(e.payload as { author: string; text: string; cards: { kind: string; [k: string]: unknown }[] }), id: e.id, device_id: e.device_id }));
  }

  of<T extends MyelinEvent["type"]>(type: T): (Seen & { type: T })[] {
    return this.seen.filter((e): e is Seen & { type: T } => e.type === type);
  }

  stop(): void {
    this.abort.abort();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(f: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Everything the model was shown, as one string. */
const shown = (context: unknown) => JSON.stringify(context);
const lastToolResult = (context: unknown) => JSON.stringify((context as { messages: { role: string; content: unknown }[] }).messages.findLast((m) => m.role === "toolResult")?.content);
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

  it("asks on Tuesday for a unit found on Monday, with no queue involved", async () => {
    const [u, a] = await learner();
    await a.listen();
    await until(() => a.messages().length === 1);

    // Monday: a hint unblocks the learner, and the tutor records the unit.
    clock = Date.now();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("find_unit", { text: "Multiply and divide by the density", kind: "move", origin: "hint", note: "The nudge that unblocked you" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("That is the move. Carry on with the next line."),
    ]);
    await a.say("oh, multiply and divide by p(x)!");
    await until(() => a.messages().length === 3);
    const found = a.of("unit.found")[0]!;
    const unitId = found.payload.unit_id;
    const monday = a.messages()[2]!;
    expect(found.payload).toMatchObject({ text: "Multiply and divide by the density", kind: "move", origin: "hint", told: false, rests_on: [], message_id: monday.id });
    expect(monday.cards).toEqual([{ kind: "unit", unit_id: unitId, how: "Found", note: "The nudge that unblocked you. It rests on nothing, so it is one to memorize." }]);
    a.stop();

    // Tuesday: the learner opens the app. The greeting carries the probe; nothing else asks for it.
    clock += 26 * 3_600_000;
    let greeting = "";
    faux.setResponses([
      (ctx) => {
        greeting = lastUser(ctx as never);
        return fauxAssistantMessage("Morning. Quick one first: how do you turn the gradient of an expectation into something you can sample?");
      },
      fauxAssistantMessage(fauxToolCall("record_probe", { unit_id: unitId, depth: "recall", grade: "good" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Yes. What do you want to work on now?"),
    ]);
    const b = new Device();
    await b.login(u);
    await b.listen();
    await until(() => b.messages().length === 4);
    expect(greeting).toContain("the learner just opened the app");
    expect(greeting).toContain(`Probe unit ${unitId} at depth recall`);
    expect(greeting).toContain("Multiply and divide by the density");

    const shownAt = clock + 1_000;
    clock = shownAt + 5_000;
    const answerId = await b.say("multiply and divide by the density", { shown_at: shownAt, input_started_at: shownAt + 1_500, sent_at: shownAt + 4_000 });
    await until(() => b.messages().length === 6);

    const probe = b.of("unit.probed")[0]!;
    expect(probe.device_id).toBe(TUTOR_DEVICE);
    expect(probe.payload).toMatchObject({
      unit_id: unitId,
      depth: "recall",
      slot: "greeting",
      grade: "good",
      latency_ms: 4_000,
      answer_message_id: answerId,
      scheduler: "fsrs-6",
      prompt: b.messages()[3]!.text,
    });
    expect(b.messages()[5]!.cards).toEqual([{ kind: "trace", text: "Recalled in 4 seconds." }]);
    const unit = srv.stores.get(u.id).state.units[unitId]!;
    expect(unit.memory_reviews).toBe(1);
    expect(unit.last_probed_at).toBe(probe.ts);
    b.stop();
  });

  it("offers a seam probe, takes a later correction, and hears about a learner's rewording", async () => {
    const [u, a] = await learner();
    const store = srv.stores.get(u.id);
    const day = 86_400_000;
    const old = Date.now() - 3 * day;
    const unitId = uuidv7(old);
    store.append([
      makeEvent("message.added", { author: "tutor", text: FIRST_RUN_TEXT }, { id: uuidv7(old - 1000), device_id: TUTOR_DEVICE, ts: old - 1000 }),
      makeEvent("unit.found", { unit_id: unitId, text: "madrugar: to get up early", kind: "word", origin: "need" }, { id: uuidv7(old), device_id: TUTOR_DEVICE, ts: old }),
    ]);
    await a.listen();
    await until(() => a.ready);

    let seamResult = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("next_probe", { slot: "seam" }), { stopReason: "toolUse" }),
      (ctx) => {
        seamResult = shown(ctx);
        return fauxAssistantMessage("Before the next one: how do you say 'to get up early'?");
      },
      fauxAssistantMessage(fauxToolCall("record_probe", { unit_id: unitId, depth: "recall", grade: "easy" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Instant. On we go."),
    ]);
    await a.say("next");
    await until(() => a.messages().length === 3);
    expect(seamResult).toContain(`Probe unit ${unitId} at depth recall`);
    await a.say("madrugar");
    await until(() => a.messages().length === 5);
    const first = a.of("unit.probed")[0]!;
    expect(first.payload).toMatchObject({ unit_id: unitId, slot: "seam", grade: "easy", latency_ms: null });
    expect(a.messages()[4]!.cards).toEqual([{ kind: "trace", text: expect.stringMatching(/^Recalled\. Back in about \d+ days\.$/) }]);

    // The learner rewords the unit from its card, then says the last answer was a guess.
    await a.post(makeEvent("unit.reworded", { unit_id: unitId, text: "madrugar: to get up at dawn", by: "learner" }, { id: uuidv7(), device_id: a.id, ts: Date.now() }));
    let prompt = "";
    faux.setResponses([
      (ctx) => {
        prompt = lastUser(ctx as never);
        return fauxAssistantMessage(fauxToolCall("record_probe", { unit_id: unitId, depth: "recall", grade: "again", corrects: first.id, note: "a guess" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Noted, it counts as a miss."),
    ]);
    await a.say("honestly that was a guess");
    await until(() => a.messages().length === 7);
    expect(prompt).toContain(`the learner reworded unit ${unitId} to \\"madrugar: to get up at dawn\\"`);
    expect(a.of("unit.probed")[1]!.payload).toMatchObject({ unit_id: unitId, corrects: first.id, grade: "again" });
    expect(store.state.evidence[first.id]!.grade).toBe("again");
    expect(store.state.units[unitId]!.text).toBe("madrugar: to get up at dawn");
    expect(a.messages()[6]!.cards).toEqual([]);
    a.stop();
  });

  it("refuses a duplicate unit and a device writing tutor events", async () => {
    const [u, a] = await learner();
    await a.listen();
    await until(() => a.messages().length === 1);
    let second = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("find_unit", { text: "A baseline must not depend on the sample", kind: "distinction", origin: "error" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("find_unit", { text: "a baseline must not depend on the sample.", kind: "distinction", origin: "error" }), { stopReason: "toolUse" }),
      (ctx) => {
        second = shown(ctx);
        return fauxAssistantMessage("That miss was useful.");
      },
    ]);
    await a.say("I subtracted a baseline that used the sample");
    await until(() => a.messages().length === 3);
    expect(a.of("unit.found")).toHaveLength(1);
    expect(second).toContain("That is already unit");
    expect(a.messages()[2]!.cards).toEqual([expect.objectContaining({ kind: "unit", how: "Found by this miss" })]);
    const forged = makeEvent("unit.found", { unit_id: uuidv7(), text: "x", kind: "y", origin: "told" }, { id: uuidv7(), device_id: a.id, ts: Date.now() });
    const r = await fetch(`${srv.url}/api/events`, { method: "POST", headers: { "content-type": "application/json", cookie: a.cookie }, body: JSON.stringify({ events: [forged] }) });
    expect(r.status).toBe(403);
    expect(Object.keys(srv.stores.get(u.id).state.units)).toHaveLength(1);
    a.stop();
  });
});

describe("pages", () => {
  it("opens a page, asks a question at a line, and keeps the aside on its passage through edits", async () => {
    const [u, a] = await learner();
    await a.listen();
    await until(() => a.messages().length === 1);
    const store = srv.stores.get(u.id);

    // The tutor opens a page with the problem statement.
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("open_page", { title: "Bayes", starter: "A test is 99% accurate and 1% have the disease. Find P(sick | +)." }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Work it out on the page."),
    ]);
    await a.say("give me a Bayes problem");
    await until(() => a.messages().length === 3);
    const pageId = a.of("page.created")[0]!.payload.page_id;
    expect(a.messages()[2]!.cards).toEqual([{ kind: "page", page_id: pageId }]);
    const page = () => store.state.pages[pageId]!;

    // The learner writes. Each batch names the revision it was made against.
    const edit = async (fn: (tr: Transform) => void, base = page().rev) => {
      const tr = new Transform(pageDoc(page()));
      fn(tr);
      const steps = tr.steps.map((st) => st.toJSON());
      const e = makeEvent("page.edited", { page_id: pageId, base_rev: base, steps, started_at: Date.now() - 5000, ended_at: Date.now() }, { id: uuidv7(), device_id: a.id, ts: Date.now() });
      return fetch(`${srv.url}/api/events`, { method: "POST", headers: { "content-type": "application/json", cookie: a.cookie }, body: JSON.stringify({ events: [e] }) });
    };
    const S = pageSchema;
    const body = pageDoc(page()).child(0).nodeSize + 1;
    let r = await edit((tr) => {
      tr.insert(body, S.text("P(sick | +) = P(+ | sick) P(sick) / P(+)"));
      tr.insert(tr.doc.content.size, S.node("paragraph", null, S.text("P(+) = 0.99 · 0.01 = 0.0099")));
      tr.insert(tr.doc.content.size, S.node("paragraph", null, S.text("so the answer is $1$")));
    });
    expect(r.status).toBe(200);
    // A stale batch is refused, and says so, so the device can reload.
    r = await edit((tr) => tr.insert(body, S.text("x")), 0);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ stale: true });

    // Asked to check, the tutor reads the page with line numbers and asks at the line.
    let context = "";
    let retry = "";
    faux.setResponses([
      // While a page is being worked on, a thread message goes through triage first.
      fauxAssistantMessage('{"raise": false, "addressed": true}'),
      (ctx) => {
        context = shown(ctx);
        return fauxAssistantMessage(fauxToolCall("open_aside", { passage: "0.99 · 0.01", line: 3, text: Array(101).fill("word").join(" ") }), { stopReason: "toolUse" });
      },
      (ctx) => {
        retry = lastToolResult(ctx);
        return fauxAssistantMessage(fauxToolCall("open_aside", { passage: "0.99 · 0.01", line: 3, text: "Who else tests positive, besides the sick?" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(""),
    ]);
    await a.say("can you check my working?");
    await until(() => a.drafts.filter((d) => d.done).length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(context).toContain("3: P(+) = 0.99 · 0.01 = 0.0099");
    expect(retry).toContain("That is 101 words");
    const asked = a.of("message.added").at(-1)!;
    expect(asked.payload).toMatchObject({ author: "tutor", text: "Who else tests positive, besides the sick?", anchor: { page_id: pageId, rev: 3, quote: "0.99 · 0.01" } });
    expect(a.messages()).toHaveLength(5);
    const anchor = asked.payload.anchor!;
    expect(passageText(page(), anchor.from, anchor.to)).toBe("0.99 · 0.01");

    // An edit above the line moves the passage; the anchor follows it.
    r = await edit((tr) => tr.insert(body - 1, S.node("paragraph", null, S.text("By Bayes:"))));
    expect(r.status).toBe(200);
    const moved = mapRange(page(), anchor.rev, anchor.from, anchor.to)!;
    expect(passageText(page(), moved.from, moved.to)).toBe("0.99 · 0.01");

    // The learner answers in the aside. The tutor hears where, sees the new page, and replies there.
    let prompt = "";
    faux.setResponses([
      (ctx) => {
        prompt = lastUser(ctx as never);
        return fauxAssistantMessage("Yes. So what is P(+)?");
      },
    ]);
    const reply = makeEvent("message.added", { author: "learner", text: "oh, the false positives", anchor }, { id: uuidv7(), device_id: a.id, ts: Date.now() });
    await a.post(reply);
    await until(() => a.messages().length === 7);
    expect(prompt).toContain('in an aside on page \\"Bayes\\"');
    expect(prompt).toContain('at line 4: \\"0.99 · 0.01\\"');
    expect(prompt).toContain("the open page now reads");
    const answer = a.of("message.added").at(-1)!;
    expect(answer.payload.anchor).toMatchObject({ page_id: pageId, rev: page().rev, from: moved.from, to: moved.to, quote: "0.99 · 0.01" });
    const anchored = a
      .of("message.added")
      .filter((e) => e.payload.anchor)
      .map((e): AnchoredMessage => ({ id: e.id, author: e.payload.author, text: e.payload.text, ts: e.ts, anchor: e.payload.anchor as Anchor }));
    const asides = groupAsides(anchored, store.state.pages);
    expect(asides).toHaveLength(1);
    expect(asides[0]!.messages.map((m) => m.author)).toEqual(["tutor", "learner", "tutor"]);
    a.stop();
  });
});

describe("observer", () => {
  /** A page the learner made, and a way to write lines on it. */
  async function workPage(u: User, a: Device) {
    const store = srv.stores.get(u.id);
    const page_id = uuidv7();
    await a.post(makeEvent("page.created", { page_id, title: "Bayes", starter: "A test is 99% accurate and 1% have the disease. Find P(sick | +)." }, { id: uuidv7(), device_id: a.id, ts: Date.now() }));
    const page = () => store.state.pages[page_id]!;
    const S = pageSchema;
    const write = async (...lines: string[]) => {
      const tr = new Transform(pageDoc(page()));
      for (const l of lines) {
        const last = tr.doc.lastChild!;
        if (last.type.name === "paragraph" && last.content.size === 0) tr.insert(tr.doc.content.size - 1, S.text(l));
        else tr.insert(tr.doc.content.size, S.node("paragraph", null, S.text(l)));
      }
      const steps = tr.steps.map((st) => st.toJSON());
      await a.post(makeEvent("page.edited", { page_id, base_rev: page().rev, steps, started_at: Date.now() - 2000, ended_at: Date.now() }, { id: uuidv7(), device_id: a.id, ts: Date.now() }));
    };
    return { page_id, page, write };
  }

  it("stays silent through correct work and speaks at a planted error", async () => {
    await srv.close();
    await serve({ observePauseMs: 80 });
    const [u, a] = await learner();
    await a.listen();
    await until(() => a.messages().length === 1);
    const { page_id, write } = await workPage(u, a);
    const triaged: string[] = [];
    const triage = (verdict: object) => (ctx: unknown) => {
      triaged.push(shown(ctx));
      return fauxAssistantMessage(JSON.stringify(verdict));
    };

    // Correct work in two quick batches: one look after the pause, and silence.
    faux.setResponses([triage({ raise: false })]);
    await write("P(sick | +) = P(+ | sick) P(sick) / P(+)");
    await write("P(+ | sick) P(sick) = 0.99 · 0.01 = 0.0099");
    await until(() => triaged.length === 1);
    await sleep(200);
    expect(triaged).toHaveLength(1);
    expect(triaged[0]).toContain("first look");
    expect(triaged[0]).toContain("3: P(+ | sick) P(sick) = 0.99 · 0.01 = 0.0099");
    expect(a.messages()).toHaveLength(1);

    // A planted error: triage flags it, and the tutor asks at the line. No draft, nothing in the thread.
    let observed = "";
    let seen = "";
    faux.setResponses([
      triage({ raise: true, line: 4, why: "P(+) leaves out the false positives" }),
      (ctx) => {
        observed = lastUser(ctx as never);
        seen = shown(ctx);
        return fauxAssistantMessage(fauxToolCall("open_aside", { passage: "P(+) = 0.0099", line: 4, text: "Who else tests positive, besides the sick?" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("I asked about the false positives."),
    ]);
    await write("P(+) = 0.0099, so P(sick | +) = 1");
    await until(() => a.messages().length === 2);
    await sleep(100);
    expect(triaged[1]).toContain("Lines new or changed since the last look: 4.");
    expect(observed).toContain("this is an observation");
    expect(observed).toContain("line 4 (P(+) leaves out the false positives)");
    expect(seen).toContain("4: P(+) = 0.0099, so P(sick | +) = 1");
    expect(a.messages()[1]).toMatchObject({ author: "tutor", text: "Who else tests positive, besides the sick?" });
    expect(a.of("message.added")[1]!.payload.anchor).toMatchObject({ page_id, quote: "P(+) = 0.0099" });
    expect(a.drafts).toHaveLength(0);
    expect(logs.join("\n")).toContain("observation text not posted");

    // The next look knows about the aside, so the same flaw is not raised twice.
    faux.setResponses([triage({ raise: false })]);
    await write("hmm");
    await until(() => triaged.length === 3);
    await sleep(100);
    expect(triaged[2]).toContain('the tutor wrote \\"Who else tests positive, besides the sick?\\"; the learner has not answered yet');
    expect(a.messages()).toHaveLength(2);
    expect(faux.getPendingResponseCount()).toBe(0);
    a.stop();
  });

  it("hears thinking aloud without answering it, and answers what is addressed to it", async () => {
    const [u, a] = await learner();
    await a.listen();
    await until(() => a.messages().length === 1);
    const { write } = await workPage(u, a);
    await write("P(sick | +) = P(+ | sick) P(sick) / P(+)");

    // Narration: no reply, no draft.
    let triaged = "";
    faux.setResponses([
      (ctx) => {
        triaged = shown(ctx);
        return fauxAssistantMessage('{"raise": false, "addressed": false}');
      },
    ]);
    await a.say("so first I need P(+)");
    await until(() => triaged !== "");
    await sleep(100);
    expect(triaged).toContain("so first I need P(+)");
    expect(triaged).toContain("The tutor's last message in the thread");
    expect(a.messages()).toHaveLength(2);
    expect(a.drafts).toHaveLength(0);

    // A question is answered, and the tutor hears what was said aloud before it.
    let prompt = "";
    faux.setResponses([
      fauxAssistantMessage('```json\n{"raise": false, "addressed": true}\n```'),
      (ctx) => {
        prompt = lastUser(ctx as never);
        return fauxAssistantMessage("Yes: both groups test positive.");
      },
    ]);
    await a.say("does P(+) include the healthy people too?");
    await until(() => a.messages().length === 4);
    expect(prompt).toContain("thought aloud");
    expect(prompt).toContain("so first I need P(+)");
    expect(prompt).toContain("does P(+) include the healthy people too?");

    // A slip said aloud gets an aside at the line it touches.
    faux.setResponses([
      fauxAssistantMessage('{"raise": true, "line": 2, "why": "P(+) is not P(+ | sick)", "addressed": false}'),
      fauxAssistantMessage(fauxToolCall("open_aside", { passage: "P(+)", line: 2, text: "Is P(+) the same as P(+ | sick)?" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(""),
    ]);
    await a.say("P(+) is just 0.99 then");
    await until(() => a.messages().length === 6);
    expect(a.of("message.added")[5]!.payload).toMatchObject({ author: "tutor", text: "Is P(+) the same as P(+ | sick)?", anchor: { quote: "P(+)" } });

    // When triage fails, the message is answered as usual.
    faux.setResponses([fauxAssistantMessage("not json"), fauxAssistantMessage("Sure.")]);
    await a.say("ok what next");
    await until(() => a.messages().length === 8);
    expect(logs.join("\n")).toContain("no verdict");
    expect(faux.getPendingResponseCount()).toBe(0);
    a.stop();
  });
});
