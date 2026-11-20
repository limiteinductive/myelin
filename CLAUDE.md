# Myelin

Myelin is a tool for learning any subject with an AI tutor in one ongoing conversation, with a memory layer underneath. It is for one person and a few friends, each with a private thread on a shared server.

## Read first

- `docs/spec.md` is the source of truth for behaviour, architecture, the data model and the build order.
- `docs/storyboard.md` is the user story the spec was designed against.
- `design/README.md` holds the interface rules. `design/tokens.json`, `design/components/bundle.css` and each `design/components/<Name>/README.md` are the visual spec. Open a `preview.html` in a browser to see a component.
- `prompts/tutor.md` is a first draft of the tutor's system prompt. It has not been run against a model.

## Decisions that are settled

- TypeScript monorepo with four packages: `core`, `server`, `web`, `cli`.
- The server holds the record. One SQLite file per user, one append-only `events` table, everything else derived. There is no offline mode beyond keeping an unsent draft.
- Clients talk to the server over HTTPS and receive updates over Server-Sent Events.
- The web app is Solid 2.0 with Vite, installable. The page editor is ProseMirror with KaTeX and CodeMirror.
- The tutor is a Pi agent embedded in the server, with Pi's built-in file and shell tools switched off and the tutor tools from the spec registered instead.
- Scheduling is FSRS behind the `Scheduler` interface in the spec.
- Code runs in a Python sandbox inside the server container.
- The CLI is `myelin`. The bare package name is taken on npm and PyPI, so use a scope if anything is published.

## Product rules that must not be broken

- One thread, no modes. No tabs, sidebar, settings panel, library, queue, due count or grade buttons.
- The only controls on screen are the composer, Send, the plus button, Reword on a unit, Run page on a code block, the link from a page back to the thread, and text selection. Before adding any other control, stop and ask.
- The tutor never edits a page. It has no tool that can.
- Events are never updated or deleted. A correction is a new event.
- Time is measured on every event and shown only in timed runs and debriefs.
- Each learner's thread, pages and units are private. Do not add shared, social or multiplayer features.
- The logo appears on the sign-in screen, the favicon and the app icon, and nowhere in the thread.

## Interface rules

- Take every colour, space, radius and font from the tokens. Do not hard-code a colour.
- Use the `myl-` classes in `design/components/bundle.css` as the starting stylesheet and keep their names.
- Support the light and dark themes from the tokens alone.
- `design/tokens.css` is generated from `design/tokens.json`. Regenerate it; do not edit it by hand.

## How to work

- Follow the build order in the spec, one milestone at a time. Each milestone has a "Done when" test. Do not start the next one until that test passes.
- Start with milestone 1 (Core). It has no UI and no network.
- Before milestone 3, run a short spike on the two untested assumptions: embedding Pi through `createAgentSession()` with custom tools and its built-in tools off, and the Solid 2.0 APIs. Both come from documentation and have not been tried. Solid 2.0 removed `createResource`, `batch`, `on`, `produce` and `createMutable`, and most examples online target 1.x, so read the current docs first.
- The unticked items under "Open questions" in the spec are assumptions to build on, not questions to ask again. Code execution on the server, an installable web app for Android, typed math, read-only pages on a phone and the probe defaults are all assumed as written.
- One thing is undecided and matters at milestone 9: whether friends use the host's model API key or bring their own. Ask before building `myelin invite`.
- If the code and the spec disagree, say so and propose a change to the spec. Do not change either silently.
