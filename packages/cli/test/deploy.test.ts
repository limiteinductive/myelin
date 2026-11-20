// `myelin deploy` against a fake ssh that records each remote command and what it was sent. No host,
// no Docker: what is checked is what would be run there, and that no key is ever on a command line.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxFromEnv } from "../src/commands.js";
import { deploy, deployEnv, domainFor, onHost, q, runCommand } from "../src/deploy.js";

const KEY = "AIza-test-only-0123456789";

describe("deploy settings", () => {
  it("serves at the host's name unless told a domain, and refuses a bare name or address", () => {
    expect(domainFor("ben@Myelin.Example.com")).toBe("myelin.example.com");
    expect(domainFor("ssh://ben@box.example.org:2222")).toBe("box.example.org");
    expect(domainFor("box", "learn.example.com")).toBe("learn.example.com");
    expect(() => domainFor("box")).toThrow(/--domain/);
    expect(() => domainFor("root@203.0.113.7")).toThrow(/--domain/);
  });

  it("sends where it is served, the settings that mean the same there, and the host's keys", () => {
    const env = { GEMINI_API_KEY: KEY, MYELIN_DATA: "/Users/me/data", MYELIN_OBSERVE_PAUSE_MS: "9000", TZ: "Europe/Berlin", DEEPSEEK_API_KEY: "ds-0123456789" };
    const r = deployEnv(env, { domain: "myelin.example.com", name: "ben" });
    expect(r.text).toContain("MYELIN_URL=https://myelin.example.com\n");
    expect(r.text).toContain("MYELIN_DOMAIN=myelin.example.com\n");
    expect(r.text).toContain("MYELIN_NAME=ben\n");
    expect(r.text).toContain("TZ=Europe/Berlin\n");
    expect(r.text).toContain("MYELIN_OBSERVE_PAUSE_MS=9000\n");
    expect(r.text).toContain(`GEMINI_API_KEY=${KEY}\n`);
    expect(r.text).not.toContain("MYELIN_DATA");
    // A key for a provider no model uses stays here.
    expect(r.text).not.toContain("DEEPSEEK");
    expect(r).toMatchObject({ keys: ["GEMINI_API_KEY"], missing: null });

    const tri = deployEnv({ ...env, MYELIN_TRIAGE_MODEL: "deepseek/deepseek-flash" }, { domain: "d.example.com" });
    expect(tri.keys).toEqual(["GEMINI_API_KEY", "DEEPSEEK_API_KEY"]);
    expect(deployEnv({}, { domain: "d.example.com" }).missing).toBe("GEMINI_API_KEY");
    expect(() => deployEnv({ GEMINI_API_KEY: "a\nB=c" }, { domain: "d.example.com" })).toThrow(/line break/);
  });

  it("starts a container the sandbox cannot write to outside /tmp, with the data on a volume", () => {
    const cmd = runCommand();
    for (const part of ["--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "-v myelin-data:/data", "-p 443:443", "--restart unless-stopped", "noexec"]) {
      expect(cmd).toContain(part);
    }
    expect(cmd).toContain(`--env-file "$HOME/.myelin/env" myelin:latest`);
    expect(q("it's")).toBe(`'it'\\''s'`);
  });

  it("runs page code as the container's sandbox user when the environment names one", () => {
    expect(sandboxFromEnv({}).user).toBeUndefined();
    expect(sandboxFromEnv({ MYELIN_SANDBOX_UID: "10001", MYELIN_SANDBOX_GID: "10002", MYELIN_RUN_MEMORY_MB: "2048" })).toMatchObject({ user: { uid: 10001, gid: 10002 }, memoryMb: 2048 });
  });
});

describe("deploy over a fake ssh", () => {
  let dir: string;
  let ssh: string;
  const calls = () =>
    readFileSync(join(dir, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; script: string; stdin: string });

  const fake = (logs: string) => {
    ssh = join(dir, "ssh");
    writeFileSync(
      ssh,
      `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = ${JSON.stringify(dir)};
const argv = process.argv.slice(2);
const script = argv.at(-1);
const n = fs.existsSync(path.join(dir, "calls.jsonl")) ? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8").split("\\n").length : 1;
const stdin = path.join(dir, "stdin-" + n);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv, script, stdin }) + "\\n");
// docker exec shares this terminal's stdin, which does not end.
if (script.startsWith("docker exec")) process.exit(0);
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  fs.writeFileSync(stdin, Buffer.concat(chunks));
  if (script.startsWith("docker version")) process.stdout.write("29.1.0\\n");
  if (script.includes("docker logs")) process.stdout.write(${JSON.stringify(logs)});
});
`,
    );
    chmodSync(ssh, 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "myelin-deploy-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const LOGS = [
    "true",
    "The tutor is google/gemini-4-neon.",
    "You run on GEMINI_API_KEY. Each friend brings their own Gemini key.",
    "Made the first user, ben.",
    "Myelin is running at http://127.0.0.1:4317",
    "Sign in on this device (the link works once): https://myelin.example.com/login/tok123",
    "For another device: myelin invite ben",
    "",
  ].join("\n");

  it("sends the source and the keys on stdin, builds there, starts it, and hands back the first sign-in link", async () => {
    fake(LOGS);
    const said: string[] = [];
    const r = await deploy({
      host: "ben@myelin.example.com",
      name: "ben",
      env: { GEMINI_API_KEY: KEY },
      ssh,
      quiet: true,
      log: (s) => said.push(s),
      fetch: (async () => ({ ok: true })) as unknown as typeof fetch,
      pollMs: 10,
    });
    expect(r).toEqual({ url: "https://myelin.example.com", link: "https://myelin.example.com/login/tok123", served: true });

    const all = calls();
    const scripts = all.map((c) => c.script);
    expect(scripts[0]).toMatch(/^docker version/);
    expect(scripts[1]).toContain(`cat > "$HOME/.myelin/env"`);
    expect(scripts[1]).toContain("umask 077");
    expect(scripts[2]).toBe("docker build --label app=myelin -t myelin:latest -");
    expect(scripts[3]).toContain("docker run -d --name myelin");
    expect(scripts[4]).toContain("docker logs myelin");
    for (const c of all) expect(c.argv.slice(0, 3)).toEqual(["-o", "ConnectTimeout=20", "ben@myelin.example.com"]);

    // The key goes on stdin, into the settings file, and nowhere else.
    expect(readFileSync(all[1]!.stdin, "utf8")).toContain(`GEMINI_API_KEY=${KEY}\n`);
    expect(JSON.stringify(all.map((c) => c.argv))).not.toContain(KEY);
    expect(said.join("\n")).not.toContain(KEY);
    expect(said).toContain("Made the first user, ben.");

    // The source, without dependencies, built files, data or local settings.
    const files = execFileSync("tar", ["-tzf", all[2]!.stdin], { encoding: "utf8" }).split("\n");
    for (const f of ["Dockerfile", "deploy/entrypoint.sh", "deploy/Caddyfile", "packages/cli/src/deploy.ts", "prompts/tutor.md", "package-lock.json"]) {
      expect(files).toContain(f);
    }
    expect(files.some((f) => /node_modules|\/dist\/|(^|\/)\.env|\.sqlite|^data\//.test(f))).toBe(false);
  });

  it("shows the server's last words when it does not start", async () => {
    fake("false\nmyelin: could not cut the sandbox off from the network with iptables\n");
    await expect(deploy({ host: "box", domain: "myelin.example.com", env: {}, ssh, quiet: true, log: () => {}, pollMs: 10 })).rejects.toThrow(/did not start[\s\S]*could not cut the sandbox off/);
  });

  it("runs invite in the container on the host", async () => {
    fake("");
    expect(await onHost("box", ["invite", "Bo Li"], ssh)).toBe(0);
    expect(calls()[0]!.script).toBe("docker exec myelin myelin invite 'Bo Li'");
  });
});
