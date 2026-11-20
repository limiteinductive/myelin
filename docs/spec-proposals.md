# Spec proposals

Places where the code differs from `docs/spec.md` or settles something the spec leaves open. Each needs a yes or no before the spec changes.

## Milestone 2

1. **A server registry beside the per-user files.** Users, one-time login links and signed-in devices live in `data/registry.sqlite`. It is server bookkeeping, not a learner's record, so its rows change (a link is marked used, a device's last-seen time moves). Secrets are stored only as SHA-256 hashes. The learner's record stays one append-only file per user at `data/users/<user_id>.sqlite`.
   *Spec change:* add to "Data model": "The server also keeps a registry of users, login links and devices. It is not part of any learner's record."

2. **A login link is spent by the page, not by opening it.** `GET /login/<token>` serves the app, and the app spends the token with `POST /api/login`. A chat app's link preview fetches the URL but runs no script, so it cannot use up the link. The device then holds an HttpOnly, SameSite=Strict cookie.
   *Spec change:* add to "Sign-in": "Opening the link loads the app, which spends it. Link previews do not."

3. **`myelin invite` also signs in another device.** For an existing name it prints a fresh link for that user instead of failing. `myelin up` makes the first user on an empty data directory and prints a link for them on every start. Links expire after 7 days.
   *Spec change:* in the CLI table, "`myelin invite <name>`: creates the user if new, and prints a one-time login link for a new device."

4. **Derived state is held in memory.** The server replays each learner's log into core's `State` when the file is first opened and applies each appended event. No derived SQLite tables are written. They can be added later if replay on open gets slow; the rebuild guarantee is the same.
   *Spec change:* "Derived tables" becomes "Derived state … held in memory and rebuilt from the events when a learner's file is opened."

5. **Devices may append only learner events.** A device may append `message.added` by the learner, `unit.reworded` by the learner, `page.created`, `page.edited` and `activity.signal`, each with its own `device_id`. Everything else is written by the server (the tutor's tools, the importer). A batch is all-or-nothing; a repeated id with the same content returns the stored `seq`, and with different content is refused.
   *Spec change:* add to "Rules": "Devices append only learner events. The server writes the rest."

6. **Where a friend's own model key lives (for milestone 9).** You chose that friends bring their own key. The spec says the key is a server environment variable. A friend's key cannot be typed into the thread, because messages are permanent events, and there is no settings panel. Proposal: the host sets it with `myelin invite <name> --key-from <file>` (or `--key-env VAR`), it is stored encrypted in the registry under a server secret, and it is never sent to clients. If you would rather friends enter it themselves, that needs a control the product rules do not allow yet.
   *Spec change:* in "Deploy CLI and sharing", "Each friend's model API key is stored on the server for their user, set by the host with `myelin invite`, and never sent to clients." Mark the open question settled.

## Milestone 3

7. **The Pi session lives in memory and is rebuilt per sitting.** Each learner has one in-memory Pi session. A sitting ends after 30 minutes with no events; the next turn starts a fresh session whose context is built from the record (goals, preferences, thread tail), as "Context, not a transcript" asks. Nothing of Pi's is written to disk except an empty `auth.json`.
   *Spec change:* add to "Setup": "The Pi session is in memory. A sitting ends after 30 idle minutes, and the next starts a new session from the record."

8. **The first-run message is fixed text, written by the server.** On an empty thread the server posts "What do you want to learn, and is there a date you are working toward?" once, without calling the model. The learner's answer goes to the model, which sets the goal with `set_goal`.
   *Spec change:* add to "First run": "The first message is fixed text and costs no model call."

9. **The opening slot fires when the stream opens after a gap.** When a device connects and the newest message is older than 30 minutes, the tutor gets an `[app: …]` line saying the learner just opened the app, and greets them in one line with one question. Until milestone 4 there are no probes, so this is a plain greeting. Lines in `[app: …]` brackets come from the app, never from the learner, and the system prompt says so.
   *Spec change:* none yet; milestone 4 adds the greeting probe to this slot.

10. **Drafts are transient, the reply is one event.** While the tutor writes, the server sends `event: tutor` lines on the stream (`{id, text, done, error?}`). They are not stored. When the reply is complete the server appends one `message.added` with the draft's id, so a device swaps the draft for the stored message without a jump. A device that connects mid-reply gets the current draft.
    *Spec change:* add to "Rules": "Streaming text is not an event. Only the finished reply is stored."

11. **A model error writes nothing.** If the model call fails, no event is written. Devices show one grey line ("The tutor could not answer just now. Your message is kept, and it will answer when you next send.") and the unanswered messages are carried into the next turn. A message sent while the tutor is replying is answered in the next turn, not dropped.
    *Spec change:* add to "Behaviour": "On a failed call nothing is stored, and the learner's unanswered messages go into the next turn."

12. **The plus button waits for milestone 7.** It has nothing to attach until code blocks and pages exist, so the composer has only the field and Send for now.
    *Spec change:* none; noted so its absence is not read as a decision.

13. **Day dividers in the thread.** A small "Today", "Yesterday" or dated label (`myl-day`) sits between days. It is text, not a control.
    *Spec change:* add to "The thread": "Days are separated by a dated label."

14. **The CLI reads `.env`.** `myelin up` loads `.env` from the working directory and the repo root. The model is `MYELIN_MODEL` (default `google/gemini-flash-latest`) and the key is the provider's usual variable (`GEMINI_API_KEY`). With no key, the server runs and says the tutor is off.
    *Spec change:* in "Deploy CLI and sharing", name `MYELIN_MODEL` and the provider key variable.

15. **Pi's SDK docs link.** The SDK page is now under `docs.pi.dev/latest`. The two links in the spec point at the old path.
    *Spec change:* update both links.
