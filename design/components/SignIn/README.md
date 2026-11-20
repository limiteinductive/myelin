The sign-in screen is what the app shows when it is opened without a valid invite link: the logo, one field and one line of help.

## Structure

- `myl-signin` fills the viewport and centres a single column with `space-6` between its parts.
- The lockup (`myl-logo`) at 40px.
- A composer (`myl-composer`) at most 420px wide, with no plus button. Its placeholder is "Paste your invite link". Its send button signs in and is dimmed while the field is empty.
- One line in the `trace` style and `muted`: "Whoever runs this server can make you a link."

## Rules

- There is no password, no email field, no "create account" and no settings. An invite link is the only way in.
- Opening an invite link directly signs the learner in and never shows this screen.
- A link works once. If a pasted link was already used or is wrong, replace the help line with "That link has already been used or is not valid." in `warning`. Do not clear the field.
- After signing in, go straight to the thread. On a first visit the thread holds one tutor message asking what the learner wants to learn.
- This is the only screen that shows the logo.

## The consumer provides

The handler that checks the link, and the error state.
