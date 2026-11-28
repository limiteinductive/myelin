import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgyJudgeWorker, extractStreamingJsonMessage, FastJudge, parseJudgeJson } from "../src/judge.js";

describe("FastJudge System 1 (Jev) -> System 2 cascade", () => {
  it("fast-passes on high-confidence Jev decision without calling System 2", async () => {
    const calls: string[] = [];
    const mockFetch: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          model: "typesafe/jev-1.14",
          answers: {
            demonstrated: { type: "noul", noul: 0.94 },
            cot_gap: { type: "noul", noul: 0.12 },
            clarity: { type: "score", score: 0.85 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const judge = new FastJudge({ apiKey: "test-key", fetchFn: mockFetch });
    const res = await judge.check({
      prompt: "Explain when to use ser vs estar.",
      unitText: "Use ser for defining traits, estar for temporary states.",
      unitKind: "distinction",
      depth: "recall",
      restsOn: [],
      attempt: "ser is for permanent/inherent traits, estar is for states or conditions",
      latencyMs: 9000,
      hintsUsed: 0,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/decisions");
    expect(res.ok).toBe(true);
    expect(res.tier).toBe("system1");
    expect(res.grade).toBe("easy");
  });

  it("escalates to System 2 when Jev detects a reasoning gap", async () => {
    const calls: string[] = [];
    const mockFetch: typeof fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/decisions")) {
        return new Response(
          JSON.stringify({
            model: "typesafe/jev-1.14",
            answers: {
              demonstrated: { type: "noul", noul: 0.42 },
              cot_gap: { type: "noul", noul: 0.88 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ok: false,
                  grade: "again",
                  diagnosis: "Calling np.exp(x) directly overflows to inf for large values like 1000, yielding NaN.",
                  next: "Shift x by a constant that leaves the ratio unchanged before exponentiating.",
                  habit_observed: null,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const judge = new FastJudge({ apiKey: "test-key", fetchFn: mockFetch });
    const res = await judge.check({
      prompt: "Write numerically stable softmax.",
      unitText: "Subtract max(x) before exp to prevent overflow.",
      unitKind: "move",
      depth: "use",
      restsOn: [],
      attempt: "np.exp(x) / np.sum(np.exp(x))",
      latencyMs: 12000,
      hintsUsed: 0,
    });

    expect(calls).toHaveLength(2);
    expect(res.ok).toBe(false);
    expect(res.tier).toBe("system2");
    expect(res.message).toContain("1000");
  });

  it("runs System 2 and inline completion via warm persistent agy CLI worker when llmModel is agy/*", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myelin-agy-judge-test-"));
    const fakeBin = join(dir, "fake-agy.mjs");
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
let n = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  n++;
  const resp = n === 1
    ? JSON.stringify({
        ok: false,
        grade: "again",
        message: "Clean algebra, but state whether independence is required.",
        habit_observed: null
      })
    : JSON.stringify({
        ok: true,
        grade: "good",
        message: "Clean—no independence needed."
      });
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: resp } }) + "\\n");
}
`,
      "utf8",
    );
    chmodSync(fakeBin, 0o755);

    const judge = new FastJudge({ apiKey: "", llmModel: "agy/gemini-4-neon-medium", agyBinary: fakeBin });
    try {
      const res = await judge.check({
        prompt: "Derive E[X+Y] and state whether independence is required.",
        unitText: "Linearity of expectation.",
        unitKind: "move",
        depth: "rebuild",
        restsOn: [],
        attempt: "E[X+Y] = sum (X+Y)P = E[X] + E[Y]",
        latencyMs: 20000,
        hintsUsed: 0,
      });
      expect(res.ok).toBe(false);
      expect(res.tier).toBe("system2");
      expect(res.message).toContain("independence");

      const done = await judge.continueRep({
        prompt: "Derive E[X+Y] and state whether independence is required.",
        unitText: "Linearity of expectation.",
        unitKind: "move",
        depth: "rebuild",
        restsOn: [],
        attempt: "E[X+Y] = sum (X+Y)P = E[X] + E[Y]",
        feedback: res.message,
        turns: [],
        reply: "clearly we didnt and it doesnt require independence",
        latencyMs: 28000,
        hintsUsed: 0,
      });
      expect(done.ok).toBe(true);
      expect(done.grade).toBe("good");
      expect(done.message).toContain("no independence needed");
    } finally {
      judge.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips Jev on obvious non-attempts and questions so System 2 starts immediately", async () => {
    const calls: string[] = [];
    const mockFetch: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ok: false,
                  grade: "again",
                  message: "Start tiny: for two numbers 2 and 6, what is their average?",
                  habit_observed: null,
                  missing_prereqs: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const judge = new FastJudge({ apiKey: "test-key", fetchFn: mockFetch });
    for (const input of ["i have no ideas", "what is p here?"]) {
      calls.length = 0;
      const res = await judge.check({
        prompt: "Why divide by n - 1?",
        unitText: "Sample variance divides by n - 1.",
        unitKind: "distinction",
        depth: "recall",
        restsOn: [],
        attempt: input,
        latencyMs: 5000,
        hintsUsed: 0,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).not.toContain("/decisions");
      expect(res.ok).toBe(false);
    }
  });

  it("passes configured resourceDirs via --add-dir to the interactive agy worker only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myelin-agy-res-test-"));
    const notesDir = mkdtempSync(join(tmpdir(), "myelin-notes-"));
    const fakeBin = join(dir, "fake-agy.mjs");
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const resp = JSON.stringify({ message: process.argv.slice(2).join(" "), suggested_units: [] });
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: resp } }) + "\\n");
}
`,
      "utf8",
    );
    chmodSync(fakeBin, 0o755);

    const judge = new FastJudge({ apiKey: "", llmModel: "agy/gemini-4-neon-low", agyBinary: fakeBin, resourceDirs: [notesDir] });
    try {
      const res = await judge.explore({ initial: "find my notes", existingUnits: [], activeHabits: [], turns: [] });
      expect(res.message).toContain(`--add-dir ${notesDir}`);
    } finally {
      judge.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(notesDir, { recursive: true, force: true });
    }
  });

  it("extracts partial message prose cleanly from streaming JSON without leaking keys or grades", () => {
    expect(extractStreamingJsonMessage('{"message": "Nice split')).toBe("Nice split");
    expect(extractStreamingJsonMessage('{"message": "Line 1\\nLine 2 \\"quote\\"',)).toBe('Line 1\nLine 2 "quote"');
    expect(extractStreamingJsonMessage('{"message": "Done.", "ok": true, "grade": "easy"}')).toBe("Done.");
    expect(extractStreamingJsonMessage('{"ok": true')).toBeNull();
  });

  it("survives turn-8 worker rotation even when the retiring child closes late during turn 9", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myelin-agy-rot-"));
    const fakeBin = join(dir, "fake-agy.mjs");
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok:" + process.pid } }) + "\\n");
});
// Delay exit after stdin closes so the old child's close event fires AFTER turn 9 has already started on the new child!
rl.on("close", () => {
  setTimeout(() => process.exit(0), 60);
});
`,
      "utf8",
    );
    chmodSync(fakeBin, 0o755);

    const worker = new AgyJudgeWorker(fakeBin, "gemini-4-neon-medium", false, [], 5000);
    try {
      const results: string[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(await worker.ask(`turn ${i}`));
      }
      expect(results).toHaveLength(10);
      // Turns 1..8 share the first child PID; turns 9..10 rotated to a new child PID cleanly.
      expect(results[0]).toBe(results[7]);
      expect(results[8]).not.toBe(results[7]);
      expect(results[9]).toBe(results[8]);
    } finally {
      worker.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers from a hung child via per-turn timeout and succeeds on the next turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myelin-agy-timeout-"));
    const fakeBin = join(dir, "fake-agy.mjs");
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  if (line.includes("hang me")) {
    // Stay silent until killed by timeout
    await new Promise(() => {});
  }
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "recovered:" + process.pid } }) + "\\n");
}
`,
      "utf8",
    );
    chmodSync(fakeBin, 0o755);

    const worker = new AgyJudgeWorker(fakeBin, "gemini-4-neon-medium", false, [], 1200);
    try {
      await expect(worker.ask("hang me")).rejects.toThrow(/timed out/i);
      const next = await worker.ask("second turn");
      expect(next).toMatch(/^recovered:\d+$/);
    } finally {
      worker.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never auto-passes when judge is unconfigured or when System 2 fails after borderline Jev", async () => {
    const unconfigured = new FastJudge({ apiKey: "", llmModel: "" });
    const r1 = await unconfigured.check({
      prompt: "Explain X",
      unitText: "X",
      unitKind: "move",
      depth: "recall",
      restsOn: [],
      attempt: "my answer",
      latencyMs: 5000,
      hintsUsed: 0,
    });
    expect(r1.ok).toBe(false);
    expect(r1.failed).toBe(true);
    expect(r1.tier).toBe("fallback");

    // Borderline Jev (0.78) + System 2 failure -> must return honest failed=true, NOT ok=true!
    const mockFetch: typeof fetch = async (url) => {
      if (String(url).includes("/decisions")) {
        return new Response(
          JSON.stringify({
            model: "typesafe/jev-1.14",
            answers: {
              demonstrated: { type: "noul", noul: 0.78 },
              cot_gap: { type: "noul", noul: 0.35 },
              clarity: { type: "score", score: 0.7 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("upstream 503", { status: 503 });
    };
    const judge = new FastJudge({ apiKey: "test-key", fetchFn: mockFetch });
    const r2 = await judge.check({
      prompt: "Explain X",
      unitText: "X",
      unitKind: "move",
      depth: "recall",
      restsOn: [],
      attempt: "partial answer",
      latencyMs: 5000,
      hintsUsed: 0,
    });
    expect(r2.ok).toBe(false);
    expect(r2.failed).toBe(true);
    expect(r2.tier).toBe("fallback");
  });

  it("rotates prompt cache by variant and passes priorPrompts + delayedTransfer to prompt writer", async () => {
    const bodies: string[] = [];
    let n = 0;
    const mockFetch: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body ?? ""));
      n++;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  n === 1
                    ? { prompt: "First hat question?", expected_crux: "Sum indicator expectations by linearity." }
                    : { prompt: "Unseen card transfer question?", expected_crux: "Apply linearity of expectation to indicators." },
                ),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const judge = new FastJudge({ apiKey: "test-key", fetchFn: mockFetch });
    const unit = { id: "u_lin", text: "Linearity of expectation with indicator variables", kind: "move" };

    const p0 = await judge.promptFor(unit, [], "recall", { variant: 0 });
    expect(p0).toBe("First hat question?");
    // Same variant hits cache
    expect(await judge.promptFor(unit, [], "recall", { variant: 0 })).toBe("First hat question?");
    expect(bodies).toHaveLength(1);

    // Next variant misses cache and passes priorPrompts + delayedTransfer
    const p1 = await judge.promptFor(unit, [], "use", {
      variant: 1,
      priorPrompts: [p0],
      delayedTransfer: true,
    });
    expect(p1).toBe("Unseen card transfer question?");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("First hat question?");
    expect(bodies[1]).toContain("HELD-OUT TRANSFER CHECK");
  });

  it("validates grounded inline annotations and filters out hallucinated non-matching quotes", async () => {
    const mockFetch: typeof fetch = async (url) => {
      if (String(url).includes("/decisions")) {
        return new Response(
          JSON.stringify({
            model: "typesafe/jev-1.14",
            answers: {
              demonstrated: { type: "noul", noul: 0.3 },
              cot_gap: { type: "noul", noul: 0.9 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  message: "Check the sign on your offset term.",
                  ok: false,
                  grade: "again",
                  annotations: [
                    { quote: "+ sum_i E[(mu - xbar)**2]", note: "Should this be minus?", kind: "slip" },
                    { quote: "this quote does not exist in attempt", note: "Hallucinated pin", kind: "question" },
                  ],
                  habit_observed: null,
                  missing_prereqs: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const judge = new FastJudge({ apiKey: "test-key", fetchFn: mockFetch });
    const res = await judge.check({
      prompt: "Estimate sample variance",
      unitText: "sum(xi - xbar)^2 = sum(xi - mu)^2 - n(xbar - mu)^2",
      unitKind: "move",
      depth: "use",
      restsOn: [],
      attempt: "then E[sigmabar] = 1/4(sum_i E[(xi - mu)**2] + sum_i E[(mu - xbar)**2])",
      latencyMs: 12000,
      hintsUsed: 0,
    });
    expect(res.ok).toBe(false);
    expect(res.annotations).toEqual([
      { quote: "+ sum_i E[(mu - xbar)**2]", note: "Should this be minus?", kind: "slip" },
    ]);
  });

  it("never caches a transient defaultPrompt fallback when prompt generation fails", async () => {
    let attempt = 0;
    const mockFetch: typeof fetch = async () => {
      attempt++;
      if (attempt === 1) return new Response("upstream 503", { status: 503 });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  prompt: "A real generated prompt?",
                  expected_crux: "Dividing by n - 1 corrects sample mean bias.",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const judge = new FastJudge({ apiKey: "test-key", fetchFn: mockFetch });
    const unit = { id: "u_retry", text: "Sample variance divides by n - 1 rather than n", kind: "distinction" };
    const first = await judge.promptFor(unit, [], "use", { variant: 0 });
    expect(first).toContain("Apply this distinction");
    const second = await judge.promptFor(unit, [], "use", { variant: 0 });
    expect(second).toBe("A real generated prompt?");
  });

  it("repairs unescaped LaTeX backslashes and control-char collisions like \\times inside judge JSON", () => {
    const raw = '{"message": "Right — $\\bar{x}$ and $d_k \\times d_v$ and $\\mu$, so $\\frac{1}{10}\\sum(x_i - \\bar{x})^2$ is smaller.", "ok": true}';
    const brokenRaw = raw.replace(/\\\\/g, "\\"); // single backslashes like \mu, \sum, \bar, \frac, \times
    const parsed = parseJudgeJson<{ message: string; ok: boolean }>(brokenRaw);
    expect(parsed?.ok).toBe(true);
    expect(parsed?.message).toContain("\\mu");
    expect(parsed?.message).toContain("\\sum");
    expect(parsed?.message).toContain("\\times");
    expect(parsed?.message).toContain("\\bar{x}");
    expect(parsed?.message).toContain("\\frac{1}{10}");
    // Also repair valid JSON where \times silently became <TAB>imes
    const validJsonWithTab = '{"message": "Shape is $d_k \\times d_v$ and $L \\times L$.", "ok": true}'.replace(/\\\\times/g, "\\times");
    const parsedTab = parseJudgeJson<{ message: string; ok: boolean }>(validJsonWithTab);
    expect(parsedTab?.message).toBe("Shape is $d_k \\times d_v$ and $L \\times L$.");
  });

  it("tidies rough code cosmetically inheriting base model by default, respects explicit tidyModel override, and strips accidental markdown fences", async () => {
    const bodies: string[] = [];
    const mockFetch: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "```python\ndef rms_norm(x):\n    return x / rms\n```" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const judge = new FastJudge({ apiKey: "test-key", fetchFn: mockFetch });
    const out = await judge.tidyInput("def rms_norm(x)\n  ret x/rms");
    expect(out).toEqual({ text: "def rms_norm(x):\n    return x / rms", changed: true });
    expect(bodies[0]).toContain("google/gemini-4-neon");
    expect(bodies[0]).toContain("NEVER complete unfinished code");

    const explicitTidy = new FastJudge({ apiKey: "test-key", tidyModel: "google/gemini-2.5-flash-lite", fetchFn: mockFetch });
    await explicitTidy.tidyInput("def rms_norm(x)\n  ret x/rms");
    expect(bodies[1]).toContain("google/gemini-2.5-flash-lite");
  });

  it("consolidates learner memory in dream() and injects learnerMemory into check() and promptFor()", async () => {
    const bodies: string[] = [];
    const mockFetch: typeof fetch = async (_url, init) => {
      const body = String(init?.body ?? "");
      bodies.push(body);
      if (body.includes("offline memory consolidation")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    memory: "## Baseline & Horizons\n- Strong PyTorch intuition; working toward KDA.\n\n## Active Blind Spots\n- Occasionally flips batch vs feature dims on broadcast.",
                    summary: "Promoted broadcasting blind spot and graduated softmax gradient scaling.",
                    promoted: ["Flips batch vs feature dims on broadcast"],
                    graduated: ["1/sqrt(d_k) variance scaling"],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  prompt: "A calibrated prompt?",
                  expected_crux: "Gamma broadcasts across the trailing feature dimension.",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const judge = new FastJudge({ apiKey: "test-key", fetchFn: mockFetch });
    const res = await judge.dream({
      currentMemory: "",
      updatedBy: "dream",
      masteredUnits: [{ text: "1/sqrt(d_k) scaling prevents softmax saturation", p_imm: 0.94, reviews: 3 }],
      shakyUnits: [{ text: "RMSNorm gamma has shape (d,) not (B,)", p_imm: 0.4, reviews: 1 }],
      recentAttempts: [],
      recentExplorations: [],
      recentOverrides: [],
    });
    expect(res.memory).toContain("Baseline & Horizons");
    expect(res.promoted).toEqual(["Flips batch vs feature dims on broadcast"]);
    expect(res.graduated).toEqual(["1/sqrt(d_k) variance scaling"]);

    const prompt = await judge.promptFor(
      { id: "u_mem", text: "RMSNorm learned scale gamma broadcasts across trailing feature dim", kind: "mechanism" },
      [],
      "recall",
      { variant: 0, learnerMemory: res.memory },
    );
    expect(prompt).toBe("A calibrated prompt?");
    expect(bodies[1]).toContain("Strong PyTorch intuition");
  });

  it("caches expected_crux from promptEntryFor, accepts casual '?' answers, and enforces showPivot & 2-turn cap", async () => {
    const calls: { url: string; body: string }[] = [];
    const mockFetch: typeof fetch = async (url, init) => {
      const u = String(url);
      const b = String(init?.body ?? "");
      calls.push({ url: u, body: b });
      if (u.includes("/decisions")) {
        return new Response(
          JSON.stringify({
            model: "typesafe/jev-1.14",
            answers: {
              demonstrated: { type: "noul", noul: 0.92 },
              cot_gap: { type: "noul", noul: 0.1 },
              clarity: { type: "score", score: 0.8 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (b.includes("expected_crux") && b.includes("Return ONLY valid JSON")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: "What is Var(X_bar) for n i.i.d. draws of variance sigma^2?",
                    expected_crux: "State sigma^2 / n (variances add linearly while 1/n scales variance by 1/n^2).",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ok: false,
                  grade: "again",
                  message: "The pivot is Var(cX) = c^2 Var(X), so Var((1/n) sum X_i) = (1/n^2)(n sigma^2) = sigma^2/n.",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const judge = new FastJudge({ apiKey: "test-key", fetchFn: mockFetch });
    const unit = { id: "u_var", text: "Variance of sample mean of n i.i.d. draws is sigma^2 / n", kind: "move" };

    // 1. promptEntryFor parses & caches { prompt, crux }
    const entry = await judge.promptEntryFor(unit, [], "recall", { variant: 0 });
    expect(entry.prompt).toContain("Var(X_bar)");
    expect(entry.crux).toContain("sigma^2 / n");
    expect(judge.peekPromptEntry(unit, "recall", [], 0)?.crux).toContain("sigma^2 / n");

    // 2. Substantive answer with trailing "?" is NOT blocked as a non-attempt (hits System 1 Jev cleanly)
    calls.length = 0;
    const tentative = await judge.check({
      prompt: entry.prompt,
      expectedCrux: entry.crux,
      unitText: unit.text,
      unitKind: unit.kind,
      depth: "recall",
      restsOn: [],
      attempt: "sigma**2 / n?",
      latencyMs: 8000,
      hintsUsed: 0,
    });
    expect(calls[0]?.url).toContain("/decisions");
    expect(tentative.ok).toBe(true);

    // 3. showPivot closes immediately with ok=true and grade="again" (never fakes a pass)
    const pivotFirst = await judge.check({
      prompt: entry.prompt,
      expectedCrux: entry.crux,
      firstContact: true,
      showPivot: true,
      unitText: unit.text,
      unitKind: unit.kind,
      depth: "recall",
      restsOn: [],
      attempt: "",
      latencyMs: 10000,
      hintsUsed: 0,
    });
    expect(pivotFirst.ok).toBe(true);
    expect(pivotFirst.grade).toBe("again");

    const pivotReview = await judge.check({
      prompt: entry.prompt,
      expectedCrux: entry.crux,
      firstContact: false,
      showPivot: true,
      unitText: unit.text,
      unitKind: unit.kind,
      depth: "recall",
      restsOn: [],
      attempt: "",
      latencyMs: 10000,
      hintsUsed: 0,
    });
    expect(pivotReview.ok).toBe(true);
    expect(pivotReview.grade).toBe("again");

    // 4. Long clarifying/sub-step chains stay open (no blind turn-count spoiler cap); only explicit showPivot forces closure.
    const openSubstep = await judge.continueRep({
      prompt: entry.prompt,
      expectedCrux: entry.crux,
      firstContact: false,
      unitText: unit.text,
      unitKind: unit.kind,
      depth: "recall",
      restsOn: [],
      attempt: "sigma^2 / n^2",
      feedback: "Close — how many terms are in the sum?",
      turns: [
        { role: "user", text: "n terms, so sigma^2?" },
        { role: "assistant", text: "And what happens to the 1/n factor outside Var?" },
      ],
      reply: "wait, does n pull out squared?",
      latencyMs: 25000,
      hintsUsed: 0,
    });
    expect(openSubstep.ok).toBe(false);

    const stillOpen = await judge.continueRep({
      prompt: entry.prompt,
      expectedCrux: entry.crux,
      firstContact: false,
      unitText: unit.text,
      unitKind: unit.kind,
      depth: "recall",
      restsOn: [],
      attempt: "sigma^2 / n^2",
      feedback: "Close — how many terms are in the sum?",
      turns: [
        { role: "user", text: "n terms, so sigma^2?" },
        { role: "assistant", text: "And what happens to the 1/n factor outside Var?" },
        { role: "user", text: "still 1/n?" },
        { role: "assistant", text: "Remember Var(aX) = a^2 Var(X)." },
        { role: "user", text: "hmm" },
        { role: "assistant", text: "Try plugging a = 1/n." },
      ],
      reply: "wait what does a denote here?",
      latencyMs: 25000,
      hintsUsed: 0,
    });
    expect(stillOpen.ok).toBe(false);
    expect(calls[calls.length - 1]?.body).not.toContain("HARD_TURN_CAP");

    const explicitReveal = await judge.continueRep({
      prompt: entry.prompt,
      expectedCrux: entry.crux,
      firstContact: false,
      showPivot: true,
      unitText: unit.text,
      unitKind: unit.kind,
      depth: "recall",
      restsOn: [],
      attempt: "sigma^2 / n^2",
      feedback: "Close — how many terms are in the sum?",
      turns: [
        { role: "user", text: "n terms, so sigma^2?" },
        { role: "assistant", text: "And what happens to the 1/n factor outside Var?" },
      ],
      reply: "",
      latencyMs: 25000,
      hintsUsed: 0,
    });
    expect(explicitReveal.ok).toBe(true);
    expect(explicitReveal.grade).toBe("again");
    expect(calls[calls.length - 1]?.body).toContain("SHOW_ANSWER");
  });

  it("generates adaptive fix_bug starters via promptEntryFor and parses Dream map compaction proposals", async () => {
    const mockFetch: typeof fetch = async (_url, init) => {
      const b = String(init?.body ?? "");
      if (b.includes("FIX THE BUG")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: "This causal linear attention step has one subtle bug — fix it in place.",
                    expected_crux: "Apply feature map phi() to q_t and k_t before updating/reading S.",
                    starter: "S = S + torch.outer(k_t, v_t)\ny_t = q_t @ S",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memory: "## Baseline & Horizons\n- Owns Poisson PMF and linear attention.",
                  summary: "Merged duplicate Poisson PMF cards.",
                  promoted: [],
                  graduated: [],
                  merges: [{ keep_id: "u_p1", merge_ids: ["u_p2"], text: "Poisson PMF: P(Y=y|lambda) = lambda^y e^-lambda / y!" }],
                  retire_ids: ["u_old"],
                  links: [{ unit_id: "u_child", rests_on: ["u_p1"] }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const judge = new FastJudge({ apiKey: "test-key", fetchFn: mockFetch });
    const unit = { id: "u_la", text: "Causal linear attention uses phi(k_t) and phi(q_t)", kind: "mechanism" };
    const entry = await judge.promptEntryFor(unit, [], "use", { variant: 1, modality: "fix_bug" });
    expect(entry.modality).toBe("fix_bug");
    expect(entry.starter).toContain("torch.outer(k_t, v_t)");
    expect(judge.peekPromptEntry(unit, "use", [], 1, "fix_bug")?.starter).toContain("q_t @ S");

    const dreamed = await judge.dream({
      currentMemory: "",
      updatedBy: "dream",
      masteredUnits: [],
      shakyUnits: [],
      allUnits: [
        { id: "u_p1", text: "Poisson PMF with lambda", kind: "result", rests_on: [], p_imm: 0.9, reviews: 2 },
        { id: "u_p2", text: "Poisson PMF with yhat", kind: "result", rests_on: [], p_imm: 0.85, reviews: 1 },
      ],
      recentAttempts: [],
      recentExplorations: [],
      recentOverrides: [],
    });
    expect(dreamed.merges).toEqual([
      { keep_id: "u_p1", merge_ids: ["u_p2"], text: "Poisson PMF: P(Y=y|lambda) = lambda^y e^-lambda / y!" },
    ]);
    expect(dreamed.retire_ids).toEqual(["u_old"]);
    expect(dreamed.links).toEqual([{ unit_id: "u_child", rests_on: ["u_p1"] }]);
  });
});
