# Storyboard: one learner, ten moments

This is the user story the spec was designed against. The drawn version is at https://claude.ai/artifact/SxuU1jPhLHJpFV3QbZpQqU. Its colours and fonts predate the design system, so use it for the flow and use `design/` for the look.

## One thread: learning and remembering in the same conversation

1. **Opening the thread.** Monday, 21:10. You open the app and there is only the thread. The tutor greets you with one ten-second recall, then asks what you want. No tabs, no queue, no due count.
2. **Units appear as you work.** You build the idea with one nudge. Units appear in the thread the moment they are found. There is no wrap-up step: reword one if you care, otherwise keep going.
3. **Recall inside the work.** Recall arrives inside the work. The tutor needs an old unit, so it asks you for it instead of restating it. An unrelated question only comes at a pause, and saying "not now" drops it. Nothing piles up.
4. **Next morning, on the phone.** Tuesday, 08:40. Same thread, two minutes. No grade buttons: the tutor judges how it went and you correct it in words.
5. **A miss finds a new unit.** A week later. The greeting is a problem you have never seen. You miss it, the miss reveals a new unit, and you carry on with it right there.
6. **Asking where you stand.** Sunday. There is no map screen. You ask where you stand and the answer comes as a card in the thread. You change how the tutor behaves the same way, by telling it.

## At the desk: building on a page, and working against the clock

7. **A page with asides.** When the work needs room, a page opens beside the conversation. You write, the tutor reads along and stays quiet. You select a line to ask about it. When your reasoning slips, the tutor asks a question at that line and does not write the fix.
8. **Explain it back, with code.** Explaining is a test too. You write for a newcomer and the tutor plays one, asking naive questions at your sentences. Code runs on the page, top to bottom. The tutor also notices how you work, here a habit of predicting before running. The page is yours to keep.
9. **A timed run.** You say how much time you have and when the deadline is. The tutor plans the sitting around it: one timed run under interview conditions. This is the only time a clock is on screen. The tutor answers clarifying questions and is otherwise silent.
10. **The debrief.** Afterwards the time that was measured silently comes back as a debrief: where the minutes went, which move would have saved them, and how your speed on a unit has changed. A habit worth building becomes a unit of its own.

## Not drawn

Sign-in, the first run and a lost connection are described in the spec under "Sign-in, first run and lost connection". The sign-in screen and the composer's not-connected state are in `design/components/SignIn` and `design/components/Composer`.
