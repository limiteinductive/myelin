# Myelin

**Accelerating human understanding.**

Myelin is a local-first, domain-agnostic workspace for learning hard ideas with an LLM—math, ML, research papers, codebases, systems, science, or writing. Instead of passive chat transcripts you forget by tomorrow, Myelin turns live exploration into durable understanding:

- **Explore** — Work through papers, derivations, code, or concepts with a peer-level reasoning partner.
  - Highlight any confusing phrase and click **`???`** (`Cite | ??? | + Map`) to queue a 1-click *"I don't understand this"* annotation alongside your other citations and main reply.
  - Coach responses separate pure explanation from an explicit **Question** card with an inline batchable answer input, 1-click **Tell me**, or zero-friction skip when you want to pursue your own tangent.
  - Only genuinely new concepts or real gaps get crystallized onto your knowledge map—never things you already knew cold.
- **Practice** — Fast, targeted drills (`recall`, `rebuild`, `explain`, `use`) scheduled by **RWKV-Instant** with foundation-first DAG ordering.
  - Grounded inline highlights anchor feedback directly to exact spans in your attempt, with in-place editing that highlights and jumps straight to unresolved slips.
  - Optional cosmetic formatting (`Tidy ⌘⇧F`), sketch canvas, and self-healing post-pass follow-ups (clarify a rep, reword a unit, or adjust grading in place).
- **Map & Learner Memory** — Inspect your concept dependency tree (`⌘M`), recall estimates, and a lean cognitive profile automatically consolidated via background **dreaming** (promoting recurring blind spots and pruning mastered ones).

## Architecture

TypeScript monorepo (`Node >= 22`):

| Package | Role |
| --- | --- |
| [`packages/core`](packages/core) | Event-sourced knowledge graph, spaced-repetition scheduler, unit/run state machine |
| [`packages/server`](packages/server) | Hono HTTP + SSE server, SQLite store, RWKV-Instant recall scorer, System 1/2 judge cascade, Explore & Dream pipelines |
| [`packages/web`](packages/web) | Solid 2.0 web app (Explore, Practice, Map, KaTeX math, selection citations, styled tooltips) |
| [`packages/cli`](packages/cli) | `myelin` CLI (`up`, `deploy`, `invite`, `import`, `metrics`) |

## Quick start

```bash
npm install
cp .env.example .env
# Configure either your local `agy` CLI subscription (no API key needed) or OPENROUTER_API_KEY in .env
npm run build
node packages/cli/dist/main.js up
```

Then open the one-time sign-in link printed in the terminal (default `http://127.0.0.1:4317`).

For local development with automatic server reloads after rebuilds:

```bash
npm run watch:server
```

## Configuration

Put environment variables in `.env` (never committed):

- **Option 1 — Local Antigravity CLI subscription (no API key needed):**
  - `MYELIN_MODEL=agy`
  - `MYELIN_JUDGE_MODEL=agy/gemini-4-neon-low` (all coaching, clarification, exploration, and prompt roles inherit this verbatim with zero silent downgrades; override any specific role explicitly with `MYELIN_DRILL_MODEL`, `MYELIN_CLARIFY_MODEL`, `MYELIN_EXPLORE_MODEL`, `MYELIN_PROMPT_MODEL`, `MYELIN_SIDECAR_MODEL`, or `MYELIN_TIDY_MODEL`)
- **Option 2 — OpenRouter API:**
  - `OPENROUTER_API_KEY=...`
  - `MYELIN_JUDGE_MODEL=...` (optional model override)
- `MYELIN_DATA` — Data directory (defaults to `~/.myelin/data`)

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘↵` / `Ctrl+↵` | Check / Send / Next |
| `⌘⇧F` | Cosmetically tidy draft (`⌘Z` undoes) |
| `⌘\` | Toggle sidebar |
| `⌘M` | Toggle Map |
| `⌘[` / `⌘]` (or `⌥←` / `⌥→`) | Navigate Back / Forward |
| `Esc` | Cancel in-flight request or close popover / Map |

## Verification

```bash
npm run typecheck
npm run build
npm test
```

## CLI commands

```bash
node packages/cli/dist/main.js up [--port 4317] [--host 127.0.0.1] [--data DIR]
node packages/cli/dist/main.js invite <name> [--url URL]
node packages/cli/dist/main.js metrics [name]
node packages/cli/dist/main.js perf [--data DIR] [--last N]   # or `npm run perf`
node packages/cli/dist/main.js deploy <ssh-host> [--domain D]
```
