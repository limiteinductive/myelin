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
