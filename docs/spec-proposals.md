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

14. **The CLI reads `.env`.** `myelin up` loads `.env` from the working directory and the repo root. The model is `MYELIN_MODEL` (default `google/gemini-4-neon`, was `google/gemini-flash-latest` until milestone 5) and the key is the provider's usual variable (`GEMINI_API_KEY`). With no key, the server runs and says the tutor is off.
    *Spec change:* in "Deploy CLI and sharing", name `MYELIN_MODEL` and the provider key variable.

15. **Pi's SDK docs link.** The SDK page is now under `docs.pi.dev/latest`. The two links in the spec point at the old path.
    *Spec change:* update both links.

## Milestone 4

16. **Cards ride on the tutor's message.** A unit card is `{kind: "unit", unit_id, how, note}` in the `cards` of the tutor message where the unit was found. The device shows the unit's current wording from the unit events, so a reword updates every card that shows it. The trace is a `{kind: "trace", text}` card on the reply that closed the probe, shown as the grey line inside that message.
    *Spec change:* in "The thread", say that a message carries its cards and its trace.

17. **The card's sub-line is composed by the server.** The tutor gives a short lead note ("The nudge that unblocked you."), and the server adds what it rests on: "It rests on nothing, so it is one to memorize.", "It rests on X." or, for a told unit that can be rebuilt, "It can be rebuilt, so I will not test it until you have rebuilt it once." The label is "Found", "Found by this miss" (origin error) or "Noted" (told and rebuildable).
    *Spec change:* none; the UnitCard README already describes this.

18. **Reflexes get no card mid-work.** A unit found with `observe_only` (a reflex) is recorded without a card, so the tutor does not interrupt work to announce it. It is raised in a debrief.
    *Spec change:* add to "Units": "A reflex is announced in the debrief, not mid-work."

19. **Answer time until milestone 8.** `latency_ms` is `sent_at − shown_at` from the learner's answer. `shown_at` is when the tutor's message was first on screen with the app visible, and `input_started_at` is the first keystroke since the last send. Activity signals in milestone 8 can refine it.
    *Spec change:* none yet.

20. **The tutor says the consequence; the app says the time.** Following "Say the consequence in one short line" in the prompt, the tutor writes "Rebuilt. Back in about nine days.", and the grey trace says "Recalled in 9 seconds." When the time is unknown, the trace carries the consequence and the tutor does not repeat it. The PhoneThread preview shows the consequence as the trace instead; the two should agree.
    *Spec change:* make the PhoneThread preview's trace a time ("Recalled in 9 seconds."), or drop the line from the prompt. I recommend the first.

21. **A learner's reword reaches the tutor as an app line.** When the learner rewords a unit, the next turn starts with `[app: the learner reworded unit … to "…". Their wording stands.]`.
    *Spec change:* none.

22. **Reword is one control with two states.** Reword makes the statement editable in place, and while editing the same button reads "Done". Enter or leaving the field saves, and Escape restores the old wording. A noted card has no Reword, as in the UnitCard preview.
    *Spec change:* none, unless you count "Done" as a new control.

23. **Probe offers live in memory.** The probe offered by the greeting or a seam is held in memory for six hours so `record_probe` can stamp its slot and predicted recall. After a restart, a probe defaults to the `in_context` slot.
    *Spec change:* none.

24. **Cards survive a model error.** This amends proposal 11: if the model fails after a tool already wrote a unit or a grade, the server posts the cards on an empty tutor message so the record and the thread agree. The empty message shows only its cards.
    *Spec change:* amend proposal 11 to "A model error writes no text."

25. **Math in the thread renders with milestone 5.** The tutor writes TeX such as `$\nabla p$`. The thread shows it as typed until KaTeX arrives with the page, and it will render math in thread messages too.
    *Spec change:* none.

## Milestone 5

26. **Pages are opened in words; the plus button still waits.** A page opens when the learner asks for one and the tutor calls `open_page`. The plus button has nothing to attach until milestone 7.
    *Spec change:* amend proposal 12 to "until milestone 7".

27. **A page's title is fixed for now.** The spec says naming is asked for in words, but the data model has no rename event. `open_page` sets the title, and asking to rename gets a plain "not yet".
    *Spec change:* add `page.renamed {page_id, title}` to Pages and a `rename_page` tool. I suggest doing it at milestone 9 with `show_card`.

28. **"In progress" and "kept".** A page link reads "in progress" while the page is open on this device, or while it is the most recently edited page and was edited within 30 minutes. Otherwise it reads "kept".
    *Spec change:* none; the PageLink README leaves the rule open.

29. **The tutor's open page.** For the tutor, the open page is the most recently created or edited page touched within the last 12 hours. Its text, with line numbers, goes into the context. When its revision changes mid-sitting, the next turn starts with `[app: the open page now reads: …]`. Line numbers are only for `open_aside`; the tutor is told never to mention them.
    *Spec change:* add to "Tutor agent / Context".

30. **A reply in an aside carries its anchor forward.** A learner message sent while the composer is aimed at an aside carries that aside's anchor. The tutor sees `[app: this is in an aside on page "…", at line N: "…"]`, and its reply joins the same aside. Anchors are mapped to the current revision; the quote stays as first written.
    *Spec change:* none.

31. **The problem is the first block of the page.** `page.created`'s starter becomes a `problem` node at the top of the document. The editor refuses any step that touches it, so the learner cannot change the problem and the tutor never edits the page.
    *Spec change:* add to "Data model / Pages".

32. **A page's revision is its step count.** `rev` counts every editor step applied. Every device and the server fold `page.edited` with the same core code, so a `base_rev` and an anchor's `rev` mean the same thing everywhere.
    *Spec change:* add to "Data model / Pages".

33. **Math on a page is text.** TeX between dollar signs is stored as typed and rendered with decorations. With the cursor in a formula it shows as source. This uses the thread's math rule, so `$5 and $6` is not math. An aside highlight over a formula marks the rendered formula.
    *Spec change:* none; the spec says "typed math".

34. **Asides that overlap are one aside.** Asides group by anchor range. A message whose range overlaps an existing aside's range on the same page joins it. Asides are ordered by their passage's position.
    *Spec change:* add to "The experience / Asides".

35. **What the composer is aimed at.** A selection on the page aims the composer at that passage ("About "…""). A selection or a cursor inside an aside's passage aims it at that aside ("In the aside on "…""). Escape aims it back at the thread. The line is rendered as it reads, math included.
    *Spec change:* none; it is the "composer follows the selection" rule made concrete.

36. **Edits are batched and timed.** A `page.edited` carries `started_at` and `ended_at`. A batch is sent after 1 second idle, or at once once it is 10 seconds old or a send is waiting on it.
    *Spec change:* add the two fields to the data model table.

37. **A stale edit is rebased.** The server refuses an edit whose `base_rev` is behind (409, `stale`). The device takes the newer steps, rebases its own with `prosemirror-collab` and sends again.
    *Spec change:* none.

38. **Unsent steps survive a reload, carefully.** A device keeps its unconfirmed steps in local storage with the revision they were made on. They are restored only when the page is still at that revision. A batch that was sent but not confirmed is re-posted with the same id and timestamp, so the server's dedupe makes it idempotent. This extends "keep an unsent draft" to the page.
    *Spec change:* amend "no offline mode beyond keeping an unsent draft" to "an unsent draft or unsent page edits".

39. **Each tab is its own editor.** Every tab gets its own collab client id, so two tabs on one device rebase against each other like two devices.
    *Spec change:* none.

40. **The margin's thread card shows the last four messages.** It keeps the thread visible beside the page without crowding out the asides. The full thread is one link away.
    *Spec change:* none.

41. **Who raised an aside sets its colours.** A learner-raised aside uses `myl-highlight--resting` on the page and the accent rule on its quote. A tutor-raised aside uses `--asked` and the source rule.
    *Spec change:* none; it follows the Aside README.

42. **Asides whose passage was deleted.** They leave the margin, since nothing on the page is level with them, and stay in the thread view with their quote.
    *Spec change:* add to the Aside README.

43. **On a phone the composer stays with the thread.** The page opens read-only in a sheet over the thread. Asides appear in the thread as quote plus messages, and a reply there goes to the thread, not the aside.
    *Spec change:* none; pages on a phone are read-only.

44. **The tutor's new page opens itself on a desk.** When `open_page` posts a page link while the app is open on a wide screen, the page opens beside the thread. On a phone the link waits for a tap.
    *Spec change:* add to the DeskPage README.

45. **Page link facts.** The link reads "N lines · edited 14:05". When the tutor has asked questions on the page, it reads "N lines, K questions from the tutor".
    *Spec change:* none.

46. **Unit cards in asides stay in the thread.** A unit found inside an aside shows its card in the thread view, not in the desk margin, to keep the margin to the conversation.
    *Spec change:* none.

47. **Marking a passage as a note waits.** The Page README allows showing reasoning in `muted` if the learner marks it as a note, but no control for marking exists, and adding one needs your say. Deferred.
    *Spec change:* none yet.

48. **A link to an existing page waits for `show_card`.** For now the only page link is the one `open_page` posts. Pointing back to an older page needs `show_card(page link)`, which arrives with milestone 9.
    *Spec change:* none.

## Milestone 6

49. **When a pause counts.** The observer looks at a page 15 seconds after the learner's last edit batch reaches the server. Edits from the tutor or from an import never start the timer. A look happens only if the page changed since the last look, and only if a line was added or changed, not just deleted. `MYELIN_OBSERVE_PAUSE_MS` sets the pause.
    *Spec change:* add the default to "Three triggers".

50. **Triage is one call that answers in JSON.** It gets the numbered page, the lines new since the last look, the asides already on the page with whether they are waiting for an answer, and anything said aloud. It returns `{raise, line, why, addressed}`. If triage fails or returns no verdict, nothing is raised. Triage uses the tutor's model unless `MYELIN_TRIAGE_MODEL` names a cheaper one.
    *Spec change:* add to "Three triggers"; close the "Cost of observing" question with this.

51. **When triage raises, the tutor still decides.** The tutor gets an observation turn that names the flagged line and the reason. It may call `open_aside` or `stay_quiet`. An observation turn shows no draft, and any text it writes is not posted, so it can only speak through an aside.
    *Spec change:* add to "Three triggers".

52. **Thinking aloud is told apart by triage, not by a mode.** Thread messages sent while a page is being worked on (the learner edited it in the last 10 minutes) go through triage first. Messages addressed to the tutor get a reply as usual. That includes questions, requests, answers to the tutor's last message, and anything triage is unsure about or fails on. Anything else is thinking aloud. It gets no reply, the tutor is told about it in its next turn, and a real flaw in it gets an aside at the line. If the flaw is not on the page, it gets one short question in the thread. A message in an aside always gets a reply.
    *Spec change:* add to "Thinking aloud".

53. **No cue that the tutor heard.** Thinking aloud gets nothing back, not even a mark or "listening" line, since one would be a new element on screen. The learner sees the tutor is listening because it answers when asked.
    *Spec change:* none.

54. **A look by the tutor counts as a look.** After a reply turn that showed the tutor the page, the observer starts from that revision. A flaw the tutor just discussed in the thread is not raised again as an aside.
    *Spec change:* none.
