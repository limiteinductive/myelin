# Spike: Pi embedding and Solid 2.0

Run on 2026-11-21 before milestone 3. Both assumptions hold.

## Pi (`@earendil-works/pi-coding-agent` 1.6.0)

- `createAgentSession({ noTools: "builtin", resourceLoader, sessionManager: SessionManager.inMemory(dir), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }), modelRuntime, model })` gives a session whose only active tools are the ones we register. `getActiveToolNames()` returned just the custom tool.
- Tutor tools register as an inline extension: `new DefaultResourceLoader({ extensionFactories: [pi => pi.registerTool(defineTool({...}))], systemPrompt, appendSystemPrompt: [], noSkills, noPromptTemplates, noThemes, noContextFiles })`. Parameters are TypeBox (`typebox` 1.x).
- `systemPrompt` on the loader replaces Pi's coding prompt entirely.
- Streaming: `session.subscribe` gives `message_update` with `assistantMessageEvent.type === "text_delta"`, then `message_end`, `tool_execution_start/end`, `agent_end`, `agent_settled`. `await session.prompt(text)` resolves after tools and the final reply. A second prompt while one is running needs `streamingBehavior: "steer" | "followUp"`.
- Keys: `ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false })` then `setRuntimeApiKey("google", key)`. Runtime keys are not written to disk; the runtime does write an empty `auth.json` at `authPath`, so it points into the server's data directory. One runtime per user carries that user's own key (milestone 9).
- Gemini: provider `google`, key `GEMINI_API_KEY`. Default model `gemini-4-neon` (was `gemini-flash-latest`), set with `MYELIN_MODEL` (for example `google/gemini-pro-latest`).
- Tests: `registerFauxProvider()` from `@earendil-works/pi-ai/compat` scripts replies and tool calls. The faux provider must also be registered on the runtime (`modelRuntime.registerProvider(provider, { apiKey, api, baseUrl, models })`) or the session refuses to prompt for lack of a key.
- Live Gemini check (milestone 3): `google/gemini-flash-latest` answered through the app, called `set_goal` with the right date, streamed its reply, and on the second turn opened with feedback on a wrong answer and ended on one question. A turn with a tool call takes about 6 seconds (two model calls).

## Solid 2.0 (`solid-js` 2.0.3, `@solidjs/web` 2.0.3, `@solidjs/vite-plugin` 3.0.1)

- The package ships its own agent primer at `node_modules/solid-js/skills/solid-2.0/SKILL.md` and a full `CHEATSHEET.md`. Read those, not 1.x examples.
- tsconfig: `"jsx": "preserve", "jsxImportSource": "@solidjs/web"`. The Vite plugin needs `@solidjs/babel-plugin` and `@babel/core` as peers.
- Stores use draft setters: `setStore(s => { s.items.push(x) })`. Writes inside an owned scope (a component body, a computation, even `createRoot`'s own callback) throw `REACTIVE_WRITE_IN_OWNED_SCOPE`. Writes from SSE callbacks and event handlers are fine.
- Reads lag writes until the microtask or `flush()`. Tests call `flush()` before asserting.
- `createEffect(compute, apply)`, `onSettled` instead of `onMount`, `<Loading>` and `<Errored>` instead of `<Suspense>` and `<ErrorBoundary>`, `class={{...}}` instead of `classList`.
- Vitest runs Solid's dev build in Node without a DOM for store logic.
