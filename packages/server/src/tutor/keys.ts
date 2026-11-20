// Whose model API key a learner's tutor runs on. The person running the server, the first user, uses
// the host's key from the environment. A friend brings their own, pasted into the thread once when
// they first sign in, so costs stay separate. A key is checked with one small call before it is kept.
// Keys are never events, never logged and never sent back to a client.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Registry } from "../registry.js";
import type { ModelChoice, ModelSource } from "./tutor.js";

/** The learner has no key for the tutor's provider yet. */
export class NeedsKeyError extends Error {}

/** A pasted key that was not kept, with a sentence the learner can act on. */
export class KeyRejected extends Error {}

interface Spec {
  spec: string;
  provider: string;
  id: string;
}

function parseSpec(spec: string): Spec {
  const [provider, ...rest] = spec.split("/");
  const id = rest.join("/");
  if (!provider || !id) throw new Error(`a model should look like provider/model, not ${spec}`);
  return { spec, provider, id };
}

const NAMES: Record<string, string> = { google: "Gemini", openai: "OpenAI", deepseek: "DeepSeek", anthropic: "Anthropic", mistral: "Mistral" };

/** How a provider is named to a learner: "Gemini" for google. */
export function providerName(provider: string): string {
  return NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

async function load(s: Spec, key: string | null, agentDir: string): Promise<ModelChoice> {
  mkdirSync(agentDir, { recursive: true });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  // A runtime key is held in memory only.
  if (key) await runtime.setRuntimeApiKey(s.provider, key);
  const model = runtime.getModel(s.provider, s.id) as Model<Api> | undefined;
  if (!model) throw new Error(`Pi does not know the model ${s.spec}`);
  return { runtime, model };
}

/** One short call: does the provider answer with this key? */
async function answers({ runtime, model }: ModelChoice): Promise<void> {
  const res = await runtime.completeSimple(
    model,
    { systemPrompt: "Reply with the word ok.", messages: [{ role: "user", content: "ok?", timestamp: Date.now() }] },
    { maxTokens: 64, signal: AbortSignal.timeout(30_000) },
  );
  if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage ?? res.stopReason);
}

export interface ModelKeysOptions {
  registry: Registry;
  agentDir: string;
  /** The tutor's model, such as "google/gemini-4-neon". */
  spec: string;
  /** The host's key for that provider, for the first user only. */
  hostKey?: string | undefined;
  /** A cheaper model for the observer's triage, used when the learner has a key for its provider. */
  triage?: { spec: string; hostKey?: string | undefined } | undefined;
  /** Checks a pasted key before it is kept. By default one small call to the tutor's model. */
  check?: (choice: ModelChoice, key: string) => Promise<void>;
  log?: (msg: string) => void;
}

export class ModelKeys {
  private choices = new Map<string, Promise<ModelChoice>>();

  private constructor(
    private readonly opts: ModelKeysOptions,
    private readonly main: Spec,
    private readonly tri: Spec | null,
  ) {}

  /** Fails at once on a model Pi does not know. */
  static async create(opts: ModelKeysOptions): Promise<ModelKeys> {
    const main = parseSpec(opts.spec);
    const tri = opts.triage && opts.triage.spec !== opts.spec ? parseSpec(opts.triage.spec) : null;
    await load(main, null, opts.agentDir);
    if (tri) await load(tri, null, opts.agentDir);
    return new ModelKeys(opts, main, tri);
  }

  get provider(): string {
    return this.main.provider;
  }

  private isOwner(userId: string): boolean {
    return this.opts.registry.users()[0]?.id === userId;
  }

  private keyFor(userId: string, provider: string, hostKey: string | undefined): string | undefined {
    return this.opts.registry.modelKey(userId, provider) ?? (hostKey && this.isOwner(userId) ? hostKey : undefined);
  }

  private choice(s: Spec, key: string): Promise<ModelChoice> {
    const k = `${s.spec}\n${key}`;
    let c = this.choices.get(k);
    if (!c) {
      c = load(s, key, this.opts.agentDir);
      c.catch(() => this.choices.delete(k));
      this.choices.set(k, c);
    }
    return c;
  }

  /** The provider's name if the learner must bring a key before the tutor can answer, else null. */
  needed(userId: string): string | null {
    return this.keyFor(userId, this.main.provider, this.opts.hostKey) ? null : providerName(this.main.provider);
  }

  readonly model: ModelSource = async (userId) => {
    const key = this.keyFor(userId, this.main.provider, this.opts.hostKey);
    if (!key) throw new NeedsKeyError(`no ${providerName(this.main.provider)} key for ${userId}`);
    return this.choice(this.main, key);
  };

  /** The triage model if the learner has a key for it, else the tutor's. */
  readonly triage: ModelSource = async (userId) => {
    if (this.tri) {
      const key = this.keyFor(userId, this.tri.provider, this.opts.triage?.hostKey);
      if (key) return this.choice(this.tri, key);
    }
    return this.model(userId);
  };

  /** Checks a pasted key with the provider and keeps it for this learner. */
  async set(userId: string, pasted: string): Promise<void> {
    const key = pasted.trim();
    const name = providerName(this.main.provider);
    if (!/^[\x21-\x7e]{8,400}$/.test(key)) throw new KeyRejected(`That does not look like a ${name} API key. Paste the key alone.`);
    try {
      await (this.opts.check ?? answers)(await load(this.main, key, this.opts.agentDir), key);
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).split(key).join("[key]").slice(0, 300);
      (this.opts.log ?? console.error)(`a pasted key for ${userId} did not work: ${why}`);
      throw new KeyRejected(`${name} did not accept that key. Check it and paste it again.`);
    }
    this.opts.registry.setModelKey(userId, this.main.provider, key);
  }
}
