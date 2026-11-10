---
name: slack-ta
description: Worktree job launched from a Slack @mention via laptop-bridge. Use when the prompt starts with /slack-ta. Streams progress back to the Slack thread through the laptop MCP (thinking_step / append_text / finish), then runs the actual task via /go.
---

# slack-ta — Slack-driven worktree job

You were spawned by a Slack mention. Args: `[threadTs:<token>] <task description>`.

Extract `<token>` — it identifies your Slack stream. Pass it as `threadTs` to EVERY laptop MCP tool call. The MCP is `laptop` (http://127.0.0.1:8365/mcp).

## Protocol

0. Rename the tab/window (same convention as /go Phase 0) with a `slack: <short task slug>` label (≤30 chars, e.g. `slack: filter prog templates`); use the ticket ID instead if the task names one. Orca first, then herdr, then tmux; skip silently if in none:
   - `$ORCA_TERMINAL_HANDLE` set → `/Applications/Orca.app/Contents/Resources/bin/orca terminal rename --terminal "$ORCA_TERMINAL_HANDLE" --title "slack: <slug>" --json`
   - else `$HERDR_TAB_ID` set → `herdr tab rename "$HERDR_TAB_ID" "slack: <slug>"`
   - else `$TMUX` set → `tmux rename-window -t "$TMUX_PANE" "slack: <slug>"`
1. Immediately, in this order:
   - `register_job({threadTs, cwd: <pwd>, paneId: $ORCA_TERMINAL_HANDLE, else $HERDR_PANE_ID, else $TMUX_PANE, pid: <your pid>, branch: <git branch>})` — this is how follow-up Slack mentions get routed INTO this session instead of spawning a duplicate job. Never skip it. (`paneId` is only a hint — the bridge verifies it against `cwd` — so send whichever is set and omit it if neither is.)
   - `thinking_step({threadTs, title: "Understanding the task", status: "in_progress"})`.
2. Run the task: treat `<task description>` as `/go <task description>` (full pipeline). Skip `/grill-me` and user-approval gates — nobody is watching the terminal; make sensible calls and note them in the final summary.
3. At each real milestone (plan done, implementation, tests, PR), update the checklist: mark the previous step `complete`, add the next as `in_progress`. Short titles ("Planning", "Implementing", "Running tests", "Opening PR"). Use `set_status` for the grey "is …" line during long stretches.
4. On completion: put the concise final report — what changed, test results, PR link — in `finish({threadTs, markdown})`. It's posted as its OWN reply (the user's one notification); do NOT `append_text` the summary.
5. ALWAYS `finish` as your very last act — also on failure (mark the failing step `status: "error"`, put what went wrong in the finish markdown). A stream left open sticks in Slack until swept.

## Follow-ups

Messages starting with `[slack follow-up threadTs:<token>]` are the Slack user replying in your thread — the bridge typed it into your session. Treat it as user steering:

- Mid-work: fold it into the current task; acknowledge with a `thinking_step` so the thread shows it landed.
- After you finished: it's a new turn — the bridge already reopened a stream on the same `threadTs`; stream progress as usual and ALWAYS `finish` again at the end.
- The token in the follow-up is the same `threadTs` you already use.

## Rules

- Never guess `threadTs` — if the token is missing from your prompt, do the work but skip all streaming calls.
- If a streaming call errors with "no live stream", the stream was swept (job took too long) — continue the work, stop streaming.
- Keep Slack output tight: the checklist tells the story; `append_text` only for genuinely important mid-course findings — the final summary goes in `finish(markdown)`.
