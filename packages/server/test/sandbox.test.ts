import { describe, expect, it } from "vitest";
import { Sandbox } from "../src/sandbox.js";

describe("sandbox", () => {
  const box = new Sandbox({ timeoutMs: 5_000 });

  it("runs blocks top to bottom in one interpreter, showing prints and the last value", async () => {
    const r = await box.run(["x = 21\nprint('hello')", "x * 2", "def f(n):\n    return n + 1\nf(x)"]);
    expect(r.timed_out).toBe(false);
    expect(r.blocks).toEqual([
      { output: "hello\n", failed: false },
      { output: "42\n", failed: false },
      { output: "22\n", failed: false },
    ]);
  });

  it("stops at the first block that fails, with a traceback in the block's own lines", async () => {
    const r = await box.run(["a = 1", "print('before')\nb = a + g_b", "print('never')"]);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[1]!.failed).toBe(true);
    expect(r.blocks[1]!.output).toContain("before");
    expect(r.blocks[1]!.output).toContain("NameError: name 'g_b' is not defined");
    expect(r.blocks[1]!.output).toContain('File "<block 2>", line 2');
    expect(r.blocks[1]!.output).toContain("b = a + g_b");
    expect(r.blocks[1]!.output).not.toContain(".driver.py");
  });

  it("reports a syntax error at its block", async () => {
    const r = await box.run(["def broken(:\n  pass"]);
    expect(r.blocks[0]!.failed).toBe(true);
    expect(r.blocks[0]!.output).toContain("SyntaxError");
  });

  it("keeps no state between runs and none of the server's secrets", async () => {
    process.env.GEMINI_API_KEY_TEST_ONLY = "not-for-code";
    await box.run(["leak = 1"]);
    const r = await box.run(["import os\nprint('leak' in globals(), 'GEMINI_API_KEY_TEST_ONLY' in os.environ)"]);
    delete process.env.GEMINI_API_KEY_TEST_ONLY;
    expect(r.blocks[0]!.output).toBe("False False\n");
  });

  it("stops a run that takes too long", async () => {
    const quick = new Sandbox({ timeoutMs: 800 });
    const r = await quick.run(["print('start')", "while True:\n    pass"]);
    expect(r.timed_out).toBe(true);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0]).toEqual({ output: "start\n", failed: false });
    expect(r.blocks[1]!.failed).toBe(true);
    expect(r.blocks[1]!.output).toContain("ran for more than 1 seconds");
  });

  it("caps output", async () => {
    const small = new Sandbox({ maxOutput: 100 });
    const r = await small.run(["print('x' * 10_000)"]);
    expect(r.blocks[0]!.output.length).toBeLessThan(200);
    expect(r.blocks[0]!.output).toContain("output cut at 100 characters");
  });

  it("says so when Python cannot start", async () => {
    const r = await new Sandbox({ python: "/nonexistent/python" }).run(["1"]);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]!.failed).toBe(true);
    expect(r.blocks[0]!.output).toContain("could not start");
  });
});
