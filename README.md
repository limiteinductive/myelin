# Myelin handoff

Everything needed to start building Myelin with Claude Code, as of 20 November 2026.

| Path | What it is |
| --- | --- |
| `CLAUDE.md` | Instructions Claude Code reads on its own: settled decisions, product rules and how to work |
| `docs/spec.md` | The design spec, version 0.2, including the nine-milestone build order |
| `docs/storyboard.md` | The ten-moment user story in words |
| `prompts/tutor.md` | First draft of the tutor's system prompt |
| `design/` | The design system: rules, tokens, stylesheet, component guidelines with previews, and the logo files |

## Starting

1. Create an empty repository and copy this folder's contents into its root.
2. Open Claude Code there and ask it to read `CLAUDE.md` and `docs/spec.md`, then implement milestone 1 (Core).

## Keeping it current

`docs/spec.md` and `design/` are snapshots of two living documents:

- Spec: https://claude.ai/artifact/6pKnyCQQNiXf8NhcNkrU4b
- Design system: https://claude.ai/artifact/1sTptRJP1RVcYB5WYjWw45

If either changes, replace the snapshot. The spec can be exported from its own menu as Markdown.

## Known gaps

- The tutor prompt has not been run against a model.
- Embedding Pi and the Solid 2.0 APIs are taken from documentation and have not been tried.
- The design system has been checked as rendered previews, not in a built app or on a phone.
- Whether friends use the host's model API key or their own is undecided. It matters at milestone 9.
