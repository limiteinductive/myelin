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

## Milestone 7

55. **What `page.ran` records.** `{page_id, rev, blocks: [{output, failed}], timed_out, duration_ms}`. The server appends it from device `server:sandbox` after Run page; a client may not append one. A run that stops at a failing block has fewer results than the page has blocks. The tutor sees the latest run's output under each code block in the page text, headed with the revision it ran at, so it can tell when the page has changed since.
    *Spec change:* add the payload to "Event types".

56. **How a run works.** Every code block on the page as it is now, top to bottom, in one fresh `python3` process, stopping at the first block that fails. Prints and errors go under the block that made them, and a traceback names the block (`<block 2>, line 2`). The value of a block's last expression is shown, as in a notebook. Runs queue one at a time on the server; pressing Run page again during a run waits for that run. `MYELIN_PYTHON` picks the interpreter and `MYELIN_RUN_TIMEOUT_MS` the limit (30 seconds by default).
    *Spec change:* add to "The page".

57. **What the sandbox isolates, and what it does not yet.** Each run gets a fresh process and temporary directory, an environment without the server's secrets, a wall-clock limit that kills the whole process group, CPU-time and file-size limits, and output capped at 20,000 characters per block. It does not isolate the file system or the network. That is acceptable for one person on their own machine. At milestone 9 the container must provide it: no network for the sandbox user, a read-only file system outside its temporary directory, and memory limits.
    *Spec change:* add to "Deploy CLI and sharing".

58. **Output is matched to blocks by position.** After an edit, the last run's output stays under the block in the same position until the next run. Adding a block above another moves the old output to the wrong block until then. Keeping output per block across edits would need an id on each code block. Deferred until it bothers someone.
    *Spec change:* none.

59. **The foot of a code block.** It holds the status and Run page. The status reads "Not run yet", "Running…", "Ran with the page", "Failed at this block", or why the run did not happen ("Code does not run on this server", "The page could not run while offline"). Output sits between the code and the foot, and "(nothing printed)" stands in for empty output. On a read-only page there is no Run page.
    *Spec change:* none.

60. **CodeMirror inside code blocks is deferred.** The spec and CLAUDE.md name it. For now a code block is a plain ProseMirror block in the mono font: Tab and Shift-Tab indent by four spaces, Enter keeps the indent and adds four after a colon, and the down arrow on the last line leaves the block. Typing ``` starts a block. CodeMirror would add syntax colours and bracket matching. It is worth adding when pages hold longer code, since it brings its own selection model to reconcile with anchored asides.
    *Spec change:* "ProseMirror, with KaTeX for math and plain code blocks; CodeMirror later". Needs your say, since it touches a settled decision.

61. **`run_code` posts nothing.** The tutor's own checks run in the same sandbox and only the tutor sees the output. Neither the thread nor the page shows them.
    *Spec change:* none.

62. **A probe page records its probe.** `open_page` takes an optional `unit_id` and `depth`, which must come together. The `page.created` event then carries `probe: {unit_id, depth}`. Only the tutor can create a probe page. When the learner says they are done, `record_probe` on that unit and depth uses the page's title and starter as the prompt and the page as the answer.
    *Spec change:* add `unit_id, depth` to `open_page` in "Tutor tools" and `probe` to `page.created`.

63. **The newcomer is the tutor plus triage.** On an explain page, triage is told the page is an explanation for a newcomer of the unit, and raises the first place a newcomer would get stuck, with the newcomer's naive question as the reason. The observation turn asks the tutor to read as the newcomer and, if it would get stuck too, ask the naive question as an aside: one at a time, no hint, at most 40 words. Every turn while the page is open reminds the tutor that it is the newcomer and how to grade when the learner is done.
    *Spec change:* add to "Explaining".

64. **Explain and use latency is null for now.** Active time on a page is not measured until milestone 8, so a probe answered on a page records `latency_ms: null`. A probe asked and answered in the thread still records the latency of its answer.
    *Spec change:* none; milestone 8 fills it in.

65. **Explain may come before recall.** A first explain success with no ladder yet starts the explain ladder at step 2, with the next probe 7 days on. It does not start the use ladder or the memory model. Only recall and rebuild do that.
    *Spec change:* add to "The evidence ladder".

66. **A run does not start a look.** The observer waits for edits, not runs, so a failing run alone gets no aside. The tutor sees the run's output in its next turn. Whether a failed run should count as a pause can be tuned by use.
    *Spec change:* none.

## Milestone 8

67. **Run events carry the page and the reason.** `run.started` is `{run_id, duration_ms, conditions, page_id}`, where `page_id` is the page the work is on, or null. `run.ended` is `{run_id, reason}`, where the reason is `time` or `stopped`. A run that ran out of time ends at its length, however late the event that says so arrives. At most one run is on at a time.
    *Spec change:* add the payloads to "Events".

68. **Four run tools, and the run's length in minutes.** The spec lists `start_run(duration, conditions)` and `end_run()`. The tools are `start_run(minutes, conditions, page_id?)`, `pause_run()`, `resume_run()` and `end_run()`. The learner pauses and stops in words, and the tutor calls the tool. A run is from 1 second to 4 hours. With no page, `start_run` offers a `timed_run` probe, so the tutor sets the problem in the thread.
    *Spec change:* replace the row in "Tutor tools".

69. **The app ends the run at zero, and the tutor debriefs.** The server holds a timer for the run that is on. At zero it writes `run.ended` with reason `time` and starts a tutor turn. That turn gets the run's report and is told to say time is up in a few words and then debrief. If the learner wrote as time ran out, their words follow. If the clock reached zero while no one was there (longer ago than the sitting gap), the run ends quietly and the tutor gets a note at the next turn instead.
    *Spec change:* add to "Timed runs and debriefs".

70. **The debrief is built from a report.** The tutor gets a chronology on the run's clock: what was sent, each stretch of writing with the lines it left new or changed, each run of the page and how it went, pauses, the learner leaving the app, quiet stretches of 90 seconds or more, how the run ended, and the page at the end. The tutor names the steps from it.
    *Spec change:* add to "Timed runs and debriefs".

71. **`show_card` with `kind: "timeline"` takes steps with end times.** `steps: [{name, until?}]`, where `until` is m:ss on the run's clock. The last step ends where the run did. `costly` is the step number of the one move that would have saved the most, or left out when nothing stands out. The server works out the durations, adds "Unused" for time left on a run stopped early, and refuses steps that do not increase. Up to 12 steps.
    *Spec change:* describe the timeline's data in "Tutor tools".

72. **The timeline card sits under the tutor's reply.** Cards follow a message's text, as unit cards do, so the sentence about the costly step comes before the card, not after it as `design/components/Timeline/README.md` says. Putting it after would mean splitting the reply in two.
    *Withdrawn by proposal 83.*
    *Spec change:* in the Timeline README, "The tutor's sentence about the costly step comes with the card". Needs your say, since it touches the design.

73. **The speed trend is in words for now.** The spec's debrief shows "the speed trend on the units involved". The card shows only the timeline. The tutor can speak to speed from the probes it records, which carry latency. A trend on the card waits for the metrics in milestone 9.
    *Spec change:* none yet; revisit at milestone 9.

74. **How active time is measured.** The marks are learner messages (when input began and when sent), page edits (when the batch began and when it was sent), rewordings, and activity signals. Two marks no more than 5 minutes apart are joined. A blur or away signal ends a span. The client sends focus and blur when the window gains or loses focus, away when the page is hidden or closed, typing at most every 30 seconds while keys are pressed, and focus at most every minute while the pointer moves or the page scrolls.
    *Spec change:* add "away" to the signals in "Measuring", and the 5-minute rule.

75. **Probe latency is active time.** A probe answered in the thread measures the active time from the question being shown to the answer being sent. A probe answered on a page measures the active time from the page's creation to its last edit, which lifts proposal 64. `record_probe` takes `away: true` when the learner says they were away, and the latency is then null. The explain trace now says how long, for example "Explained in 4 minutes."
    *Spec change:* add to "Measuring"; proposal 64 is withdrawn.

76. **Probes during and after a run count as timed.** A probe recorded while a run is on, or within 30 minutes of one ending, gets the `timed_run` slot unless it was offered with another. During a run, `next_probe` and `open_aside` refuse, and every turn reminds the tutor of the conditions and that the clock shows the time, so it never says it.
    *Spec change:* none; this is how "a silent tutor" is enforced.

77. **The budget is a note each turn.** `set_budget` already records "I have 20 minutes". The budget lasts until the sitting ends, and at most 12 hours. While it does, each turn tells the tutor how many of the minutes are used, counted as active time in this sitting, and to mention it only near the end. Once they are used up, the tutor wraps up in a line unless the learner wants to go on.
    *Spec change:* add to "Planning".

78. **A goal date brings runs closer.** Within 14 days of an active goal's date, the context says so, with when the last timed run was, and asks the tutor to offer a timed run under the goal's conditions at most once a sitting, starting it only if the learner accepts.
    *Spec change:* add to "Planning". The 14 days can be tuned by use.

79. **Weekly time is deferred to the metrics.** Active time per week is one of the three metrics, so it is built at milestone 9 from the same marks.
    *Spec change:* none.

80. **The clock's placement and look.** At a desk, the clock sits at the right of the page's bar, on the line of the link back to the thread. With no page open, and on a phone, it sits at the top of the thread above the scrolling messages, so it stays in view. The time is shown as mm:ss, rounded up, so it reads 00:00 only at zero. In the last minute it turns `warning`. Paused, it reads "paused". It ticks only while the clock runs.
    *Spec change:* none.

81. **Quiet stretches are steps of their own.** In the first live run the tutor folded 17 minutes with nothing on the page into the last step of work, so the bar said the proof took most of the run. `show_card` now refuses a step that holds a quiet stretch of 3 minutes or more along with more than a minute (or a fifth of the stretch) of other time, and says which stretch to split out. The report also says once that the learner left the app, and when they came back, instead of a line per blur and away signal.
    *Spec change:* none.

## Milestone 9

82. **The units table is a snapshot, posted with `show_card` kind `units`.** It takes `unit_ids` (in the order given) or a `topic` word, and refuses more than 20 rows, an unknown id, or nothing matching. Each row gives the statement and kind, a found note in the last 7 days such as "found Monday, by a miss", what it rests on ("nothing, memorized" when nothing), and a chip per depth that applies: recall and use for a memorized unit, all four for one that rests on something, use alone for a move that is only observed, plus any depth it was tested at. A chip is shown or missed by the last attempt at that depth, and not yet with none. An observation counts as use. A told unit not yet rebuilt reads "Told, not rebuilt". The evidence is as it was when asked. The statement and kind follow later rewordings.
    *Spec change:* add to "Cards": "The units table is a snapshot of the evidence when it was asked for."

83. **Tables and timelines go after the reply's first paragraph.** The tutor writes one short line, a blank line, then the rest. The app shows the first paragraph, the card, then the rest, so the card has a sentence above it and one below it as `design/components/UnitsTable/README.md` and `design/components/Timeline/README.md` say. A reply with no second paragraph shows the card at the end. Unit and page cards still follow the whole reply. Proposal 72 is withdrawn.
    *Spec change:* none.

84. **The metrics are read with `myelin metrics [name]`, not in the thread.** Time is shown only in timed runs and debriefs, and the measures are for the person running the server. The report gives use probes 7 days or more after the unit was found (succeeded out of made, across how many units), predicted against actual recall (mean of each, the Brier score, and by band of prediction), and a row per week starting Monday in `TZ`: active time in the thread, on pages and in timed runs, units gained, and use probes. A stretch of active time counts toward what ended it: a message in the thread, a page edit or an aside on a page. Time inside a run counts as the run. Imported units are not gains, and imported probes are not use probes. Proposal 73's speed trend still waits: the per-unit latency is there, but no card shows it.
    *Spec change:* add to "Metrics": "Read with `myelin metrics`, never in the thread."

85. **Calibration counts only recall and rebuild probes made after a review.** Only those feed the memory model, so only they test its prediction. A unit's first such probe has none to test: the scheduler gives 0 for a unit it has no reviews of, which puts it first in line rather than predicting anything. Imported probes carry study mode's predictions, so they count as reviews but are not scored.
    *Spec change:* add to "Metrics": "Predicted recall is scored on recall and rebuild probes after the first."


86. **A friend brings their own model key, pasted into the thread once.** The person running the server, the first user, runs on the host's key from the environment. Anyone else, and the host too when no host key is set, is asked for their own key when they first open the thread: a note says the tutor runs on their own key, and until it is given the composer takes the key rather than a message (no draft is kept, and the browser does not suggest or spell-check it). Send checks it with one small call to the provider; a refusal shows in the composer's scope line. A kept key is stored in `registry.sqlite`, now readable by its owner only, per learner and provider. It is never an event, never logged, and never sent back to a client. The tutor's first words wait for the key. `myelin invite` says when the friend will be asked. The observer's triage uses `MYELIN_TRIAGE_MODEL` only when the learner has a key for its provider, else the tutor's model. No new control: the composer and Send do it. Not done: replacing a key that stops working. The tutor then says it could not answer, and the host would replace the row by hand.
    *Spec change:* in "Deploy", replace "The model API key is an environment variable on the server and is never sent to clients." with "The host's model API key is an environment variable on the server. Each friend gives their own key once, from the thread. No key is ever sent to a client." Tick the open question on friends' keys: they bring their own.

87. **HTTPS comes from Caddy inside the one container.** The container runs Caddy in front of the server on 127.0.0.1. Caddy gets and renews the certificate for the domain, keeps it on the data volume under `/data/caddy`, and answers on ports 80 and 443. The host needs only Docker, those two ports open and a DNS name pointing at it. No proxy or certificate tool is installed on the host.
    *Spec change:* in "Deploy CLI and sharing", "The container holds the Node server, the built web app, the Python sandbox and Caddy, which serves HTTPS with a certificate it renews itself."

88. **How the container isolates the sandbox, completing proposal 57.** Code runs as its own user (uid 10001), not the server's. A firewall rule in the container drops every packet that user sends; the container checks at start that a connection from that user fails, and refuses to start otherwise. The container's file system is read-only apart from the data volume, which the sandbox user cannot read, and a `/tmp` where nothing can be executed. Each run is limited to 2 GB of memory (`MYELIN_RUN_MEMORY_MB`), 256 processes and 64 MB per file, is the first process the kernel kills when memory runs out, and every process it left behind is killed when it ends. The server runs as root inside the container with a reduced set of capabilities, so it can start runs as the other user; it gives up the one that changes the firewall once the rule is in. `myelin up` on a desk machine is unchanged: runs there are still the learner's own processes.
    *Spec change:* add to "Deploy CLI and sharing": "Code runs as a separate user with no network, a read-only file system outside its temporary directory, and limits on memory and processes."

89. **`myelin deploy` builds the image on the host.** The spec says it builds the image and ships it. It sends the source over SSH instead (no dependencies, built files, data or local settings), and the host's Docker builds it. The deploying machine then needs SSH and tar but not Docker, and the image is built for the host's own processor. The first build takes a few minutes; later ones reuse Docker's cache. It waits for the server to start, prints the first user's sign-in link, and waits for HTTPS to answer.
    *Spec change:* in the CLI table, "`myelin deploy <host>`: sends the source to a host with Docker over SSH, builds the image there and starts it with a persistent volume and HTTPS."

90. **The domain and settings go with the deploy.** The domain is the SSH host's name, or `--domain` when that is not a DNS name. The server's settings go to `~/.myelin/env` on the host, readable by its owner only, sent on SSH's input so no key is ever on a command line: the domain, the model settings, the deploying machine's time zone (days and weeks follow it, as with `myelin up`), `--name` for the first user, and the host's model key if it is set here. Paths such as `MYELIN_DATA` are not sent. Running deploy again replaces the container and keeps the volume, so the record and sign-ins survive.
    *Spec change:* none.

91. **`myelin invite` and `myelin metrics` take `--on <host>`.** They then run inside the deployed container over SSH, so the person running the server never logs in to the host to invite a friend. Sign-in links printed by the server use the domain.
    *Spec change:* in the CLI table, add "`--on <host>` runs `invite` or `metrics` on a deployed server."

92. **`myelin backup` and `myelin restore` are not built.** The CLI table lists them, but no milestone does. Until they are, a learner's file can be copied out of the `myelin-data` volume by hand.
    *Spec change:* none, unless you want them added to a milestone.

## After milestone 9

93. **Three dots while the tutor works on a reply and has written nothing yet.** You asked for feedback while the model thinks: with a thinking model, several seconds pass before the first word, and the thread looked stuck. `design/README.md` and `design/components/Message/README.md` say there is no typing indicator. In the tutor's place, three small dots in `muted` pulse from the moment the server starts a reply until its first word replaces them, in the thread, in an aside, or in the thread card beside a page. They appear only after 400ms, so a quick reply does not flicker, and they hold still when the device asks for reduced motion. The observer's unasked looks show no dots, so the quiet observer stays quiet.
    *Design change:* in "Motion" and in Message's rules, "Until the first word arrives, three muted dots pulse where the reply will be. There is no typing effect."

94. **No button carries a word.** You set the rule: in agentic hyperminimalism no button has a label. `design/README.md` says the opposite: "Use three icons only: plus, send (an upward arrow) and close… Make everything else a word." Every button is now an icon at 18px with a 1.75px stroke in the current colour, named for screen readers by its `aria-label`: Reword is a pencil (a tick while editing), Run page a triangle, the desk page's way back to the thread the close cross it already was on a phone, and a page link ends in a chevron instead of "Open". An icon button shows a 32px chip in its own colour at 12% on hover, inside the 44px hit area. Reword moves from the card's right side to the label's line, square in the corner, so the statement keeps the card's full width. The composer's corners are concentric with the send button (radius 26px, half the target plus the composer's padding), its text sits 16px in, its border darkens slightly while it has focus, and an empty composer's send button is `hover` with a `muted` arrow rather than pale accent: nothing to send is not something to act on. The thread fades out over 24px above the composer instead of being cut off.
    *Design change:* in "Iconography", replace the three rules with "No button carries a word. Icons: plus, send, close, reword (a pencil), done (a tick), run (a triangle) and open (a chevron), drawn at 18px with a 1.75px stroke in the current colour. Give every one an accessible label." In UnitCard, "A Reword icon button on the label's line, at the right." In Composer, "`radius` half the send target plus `space-1`, concentric with the send button" and "dimmed to `hover` with a `muted` arrow while the field is empty". In PageLink, "a chevron in `accent` on the right". Move the rules from `packages/web/src/app.css` into `bundle.css` and the previews once accepted.

95. **The tutor writes TeX, asks for one thing, and makes an idea stick before the next.** Your first long sitting (probability for interviews, 59 messages) showed three faults. The prompt's "rough typed form the app renders" was read as plain text, so the tutor wrote `sum_{t=1}^n` and `sqrt(d)` while the thread renders TeX between dollar signs (proposal 33). Its single question often asked for two things ("what does it look like, and why…"), and it used σ and f without saying what they were, so you had to ask twice. And it moved to a new idea after every correct guided step: five ideas in ninety minutes, none tried unaided, and no seam was ever offered to the scheduler, so nothing was probed. The prompt now says: math is TeX, `$…$` inline and `$$…$$` on its own line, never plain text, and money is written in words; unit statements stay a sentence in words and plain symbols with no dollar signs, since the unit card shows its text as typed; a new idea introduces every symbol and assumption it uses; the one question asks for one thing; and before a new idea comes one short unaided problem in the form the goal tests, moving on once it is solved without a hint or when the learner asks, with the change of idea treated as a seam (`next_probe(seam)`).
    *Spec change:* in the appendix prompt, "Every turn in the thread" gains "Introduce every symbol and assumption the idea uses" under item 2, "asking for one thing, not two joined by 'and'" under item 3, and the paragraph "An idea is not learned when they get one guided step right…"; "Units of understanding" gains "in words and plain symbols, without dollar signs" after "one sentence the learner could say aloud"; in "Voice", replace "Write math in the rough typed form the app renders" with "Write math as TeX between dollar signs: `$…$` inline, `$$…$$` on a line of its own. Never as plain text such as sum_{t=1}^n. Write money in words." In "Answer input for math", "rough typed math" becomes "TeX between dollar signs, rendered by KaTeX; the learner may type it rough".

96. **A greeting the learner has not answered is not repeated.** Your thread showed four identical "Welcome back" greetings in a row: each time the app opened after a 30-minute gap, the tutor greeted again, even when its last greeting was still unanswered. The opening slot (proposal 9) now skips when the newest message is the tutor's and it came more than 30 minutes after the learner last wrote in the thread or on a page. Such a message opened the last return, so its question still stands. A tutor reply the learner left unanswered within a sitting still gets a greeting on the next return. The test is the message's distance from the learner's last work, so no event records which turn was a greeting and the schema is unchanged.
    *Spec change:* in proposal 9's rule, "When a device connects and the newest message is older than 30 minutes" gains "unless that message is the tutor's own opening of a return the learner has not answered".

97. **Selecting a passage of a thread message replies to it.** You asked to reply to, or annotate, a passage of the tutor's message. The spec has "Selecting a passage aims the composer at it" for pages only. Selecting text inside one thread message now aims the composer at that passage as a quote: the line above the composer reads "Replying to “…” · Esc to let go", and the passage stays marked in `selection` while you type, drawn by the browser's highlight layer so the message itself is untouched. Sending posts an ordinary `message.added` with a new optional `quote` (the message's id and the passage's text, with any formula given back as its TeX between dollar signs, and a selection that cuts into a formula taking all of it). The learner's message shows the quote above its text, styled as an aside's quote, clamped to three lines. The tutor is told which message the passage came from and how long ago, and answers in the thread. Escape, a click elsewhere or a selection on a page lets the quote go; a quote and a page anchor never travel together. No control is added: text selection is already one of the allowed controls. Old events read as having no quote.
    *Spec change:* in "Asides", "Selecting a passage aims the composer at it" gains "On a page that opens an aside; in a thread message it quotes the passage in the reply." In the data model, `message.added` becomes "Author, text, cards, an optional anchor (page and passage), an optional quote (message and passage), and the timing fields".
    *Design change:* in Message's rules, "A reply to a passage shows the passage above its text as a quote, at most three lines." In Composer, "While a reply quotes a passage, the scope line says so and Escape lets it go."

98. **Unit statements render their math.** You saw raw symbols in unit cards: proposal 95 kept dollar signs out of units because the card showed its text as typed, so the tutor wrote `sum_{t=1}^n log P(w_t | …)` there, the very plain-text math it no longer writes in messages. The card now renders TeX between dollar signs as the thread does, the units table already did, and Reword shows the source while you edit and renders it again when you finish. The prompt now asks for unit statements in words, with any math as TeX between dollar signs. Units found before this keep their plain symbols until they are reworded.
    *Spec change:* in the appendix prompt, "Units of understanding" replaces proposal 95's "in words and plain symbols, without dollar signs" with "in words, with any math as TeX between dollar signs as in the thread".
    *Design change:* in UnitCard, "The statement renders math as the thread does; while it is reworded it shows its source."

99. **A found unit can name what it rests on before that is recorded.** Your probability units said "It rests on nothing, so it is one to memorize" for results you had derived, such as $E[X^2] = \mathrm{Var}(X) + E[X]^2$ and the variance of a sum. A unit could rest only on units already recorded, and the definitions and results a derivation used seldom were, so the tutor had no choice but to call it arbitrary. That breaks the rebuild probe, explain, and "When a rebuild fails, the tutor checks the units it rests on". `find_unit`, and `revise_unit` when it links, now take `basics`: sentences for what the unit rests on that is not recorded yet. Each is recorded as its own arbitrary unit with a new origin, `used` (the learner already had it), and gets no card; a basic with the same text as a recorded unit is that unit. The derived unit's card names them. Units found with `used` are not counted in the weekly "units found", like imported ones. The prompt says a unit rests on nothing only if it is arbitrary (a word, a notation, a definition, a convention or a seed move), and asks the tutor to link a listed unit that is marked arbitrary but can be rebuilt.
    *Spec change:* in "How units are found", "The learner derives or explains something. The result is a unit, resting on what was used" gains "; what was used and is not recorded yet is recorded with it, as units the learner already had". In the tool table, `find_unit` and `revise_unit` gain "and the basics it rests on that are not recorded yet". In the data model, `unit.found`'s origin gains `used`. In the appendix prompt, "Say what it rests on" takes the new wording in `prompts/tutor.md`.
