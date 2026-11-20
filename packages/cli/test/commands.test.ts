import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { importStudyModeFile, invite, up } from "../src/commands.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myelin-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = JSON.stringify({
  created_at: "2026-03-01T10:00:00Z",
  algorithm_version: "fsrs-lite-1",
  concept_id: "probability/bayes-rule",
  topic: "probability",
  concept: "Bayes' rule",
  summary: "Derived Bayes from the product rule",
  memory: { difficulty: 5, stability_days: 2, review_count: 0, lapse_count: 0, last_review_at: null, retrievability: null },
  evidence: "wrote it out unaided",
  preferences: [],
  review: null,
});

it("up makes the first user and prints a link that signs in", async () => {
  const lines: string[] = [];
  const srv = await up({ port: 0, data: dir, log: (s) => lines.push(s) });
  try {
    expect(lines.join("\n")).toContain("Made the first user, me.");
    const r = await fetch(`${srv.url}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: srv.link }) });
    expect(await r.json()).toMatchObject({ user: { name: "me" } });
  } finally {
    await srv.close();
  }
});

it("invite makes a user once, then device links", () => {
  const a = invite("Bo", { data: dir, url: "https://myelin.example" });
  expect(a.created).toBe(true);
  expect(a.link).toMatch(/^https:\/\/myelin\.example\/login\/[A-Za-z0-9_-]{43}$/);
  const b = invite("Bo", { data: dir });
  expect(b).toMatchObject({ created: false, user: { id: a.user.id } });
  expect(b.link).not.toBe(a.link);
});

it("imports study-mode once", () => {
  invite("me", { data: dir });
  const path = join(dir, "memory.jsonl");
  writeFileSync(path, entry + "\n");
  expect(importStudyModeFile(path, { data: dir })).toMatchObject({ added: 2, skipped: 0 });
  expect(importStudyModeFile(path, { data: dir })).toMatchObject({ added: 0, skipped: 2 });
});
