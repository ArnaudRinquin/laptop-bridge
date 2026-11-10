# laptop-bridge

Formerly `slack-to-laptop`.

One long-lived local process that turns a message into work on this laptop, and
reports back where the message came from. Two front doors, one back room:

- **Slack**: `@mention` the bot (Socket Mode) → a worktree job, streamed back
  into the thread.
- **Linear**: delegate an issue to the agent, `@mention` it, move an issue to a
  trigger status, or start a project → a lane (worktree + Claude session) that
  answers in Linear's agent sessions and keeps the project's issues up to date.
- **Back room**: a local HTTP MCP server the jobs call to report progress, a
  registry that routes follow-ups into the running Claude session, and a
  SwiftBar menubar status.

The job never holds Slack or Linear credentials. It only knows a correlation
token passed in its prompt (`threadTs` for Slack, a lane key and session id for
Linear); this process maps it to the real thread and owns the tokens. State is
snapshotted under `~/.cache/slack-to-laptop/`, so restarting the bridge doesn't
interrupt running jobs.

How it's built / build your own: [RECIPE.md](RECIPE.md).

## Slack app (one-time)

1. <https://api.slack.com/apps> → Create New App → From scratch.
2. **Agents & AI Apps** feature → toggle ON (grants `assistant:write`, required for streams + setStatus).
3. **Socket Mode** → ON → create app-level token with scope `connections:write` → that's `appToken` (`xapp-…`).
4. **OAuth & Permissions** → bot scopes: `app_mentions:read`, `chat:write`, `assistant:write`.
5. **Event Subscriptions** → subscribe to bot event `app_mention`.
6. Install to workspace → `botToken` (`xoxb-…`). Invite the bot to your channel: `/invite @YourApp`.

Note: Slack docs say `setStatus` is migrating from `assistant:write` to `chat:write` — both scopes above cover either.

## Run

```sh
mkdir -p ~/.config/slack-trigger
cp config.example.json ~/.config/slack-trigger/config.json
# fill botToken + appToken
bun run server.ts
```

`allowedUserIds` (Slack user IDs): when non-empty, only those users can trigger
jobs — anyone else gets a threaded "only <them> can trigger me" reply. Empty =
anyone in the channel.

With `jobCommand: null`, mentioning the bot runs a smoke demo: instant thinking
checklist, two task cards ticking, "hi", stream closed. That validates the whole
Slack side before wiring any jobs.

## Wire real jobs

Set `jobCommand` in the config — a zsh command run per mention with env:

| var | value |
|---|---|
| `SLACK_THREAD_TS` | correlation token — pass to every MCP tool call |
| `SLACK_CHANNEL` | channel id |
| `SLACK_PROMPT` | mention text, bot mention stripped |
| `SLACK_EVENT_TS` | unique per mention — use for the worktree name |
| `SLACK_MCP_URL` | `http://127.0.0.1:8365/mcp` |

Example: `"jobCommand": "/Users/you/projects/laptop-bridge/scripts/launch-job.zsh"` —
see `scripts/launch-job.zsh` (machine-specific: Orca + repo hardcoded).
It spawns a worktree Claude with prompt `/slack-ta [threadTs:$SLACK_THREAD_TS] $SLACK_PROMPT`:
the token travels *inside the prompt*, since the job's Claude only sees what the
skill receives (see "Job-side skills" below).

Connect the worktree's Claude to the MCP (once, user scope):

```sh
claude mcp add --transport http --scope user laptop http://127.0.0.1:8365/mcp
```

## MCP tools

All take `threadTs` (from `SLACK_THREAD_TS`):

- `register_job({threadTs, cwd, paneId?, pid?, branch?})` — call once at boot; where the session lives, for follow-up routing (`paneId` = `$ORCA_TERMINAL_HANDLE`, or `$TMUX_PANE` on the tmux fallback)
- `thinking_step({threadTs, title, status, id?, details?})` — checklist step; `status ∈ pending|in_progress|complete|error`; same `id`/title updates the step
- `append_text({threadTs, markdown})` — prose in the progress message (important mid-course findings only)
- `set_status({threadTs, text})` — grey "is …" line; `""` clears
- `finish({threadTs, markdown?})` — settle the progress message + post `markdown` as its own final-report reply (the user's one notification). Call exactly once, last (again after each follow-up).

## Follow-ups

Mentioning the bot again in a job's thread does NOT spawn a second job: the
bridge looks the thread up in `~/.cache/slack-to-laptop/jobs.json` (written by
`register_job`, survives `finish` for 7 days), verifies the session's terminal
still sits in the job's worktree (a terminal id alone is not a handle — tmux
recycles pane ids, Orca's handles go stale on an app restart — so cwd is ground
truth), and types `[slack follow-up threadTs:…] <text>` into that Claude
session — mid-work it's a steering message, after finish a new turn with full
context. A stream is reopened first if needed ("Reconnecting to session…"). If
the terminal is gone, it falls back to spawning a fresh job with a note. Only
the typing is terminal-specific (`src/inject.ts`); finding the session is
registration-based and generic.

## Terminals (Orca + tmux)

Jobs run as Orca worktrees: `orca worktree create` gives
each job its own checkout with Claude in the first terminal, and
`orca terminal send` types follow-ups into it. tmux panes are still listed, so
sessions started before the move stay reachable; no tmux server just means no
tmux panes.

Two gotchas, both measured:

- **Use the CLI inside the app bundle**
  (`/Applications/Orca.app/Contents/Resources/bin/orca`). The
  `/usr/local/bin/orca` symlink is root-owned mode 0700 and the CLI can't
  resolve Orca.app through it.
- **A repo with `setupAgentStartupPolicy: wait-for-setup` drops `--prompt`**
  (`launch.prompt.outcome` is `"not-delivered"`): Claude starts on an empty
  input once setup ends. The Linear launcher (`src/linear/launch.ts`) waits for
  the prompt line and types the prompt itself, once.

## Linear

Optional: everything below is off unless the config has a `linear` block.

**The model.** A Linear *project* is a lane: one worktree, one Claude session,
and every issue of that project is routed to it — issues are the lane's own
tracking, not separate jobs. An issue *without* a project gets its own lane.

**What starts work**

| In Linear | In the bridge |
|---|---|
| Delegate an issue to the agent, or `@mention` it | New agent session → the issue's lane (created if needed) |
| Reply in an agent session | Typed into the lane's terminal as `[linear follow-up session:…]` |
| Move an issue into the trigger status (`triggerStatus`) | The bridge opens an agent session on the issue, then as above |
| Move a project to a started status | The project's lane is launched with the project as its brief |

Messages that arrive while a lane is still booting are held and typed in when
it registers. Only a human's change triggers work: the lane writes to Linear
as the app, and events whose actor is not a user are ignored. At most
`maxLanes` lanes with a live session run at once.

**Setup (one-time)**

1. Linear webhooks are plain HTTPS POSTs, so the laptop needs a public URL.
   Tailscale Funnel, exposing that one path only:
   `tailscale funnel --bg --set-path /linear http://127.0.0.1:8365/linear`
2. Linear → Settings → API → OAuth applications → New. Callback URL
   `<publicUrl>/linear/oauth/callback`, webhook URL `<publicUrl>/linear/webhook`.
   Events: **Agent session events**, **Inbox notifications**, **Permission
   changes**, plus **Issues** and **Projects** for the status triggers.
3. Add to the config:

   ```json
   "linear": {
     "clientId": "…", "clientSecret": "…", "webhookSecret": "…",
     "publicUrl": "https://<machine>.<tailnet>.ts.net",
     "triggerStatus": "Waiting for agent",
     "teamRepos": { "RBD": "/Users/you/projects/booker" },
     "projectRepos": { "Website": "/Users/you/projects/site" },
     "maxLanes": 3,
     "allowedUserIds": ["<your Linear user id>"]
   }
   ```

   `allowedUserIds` empty = any member of the workspace can start work.

   `projectRepos` (by project name) wins over `teamRepos` (by team key); an
   issue with no mapping is refused with a message in its session.
4. Start the bridge, open `http://127.0.0.1:8365/install/linear` on the laptop
   and authorize the app for the teams it should see. The token (24h, refreshed
   automatically) is stored in `~/.config/slack-trigger/linear-token.json`.
5. Add the trigger status to each team's workflow by hand: an agent app is not
   allowed to edit workflows.

**Security.** Only `/linear/*` is reachable from outside. The webhook checks
the `Linear-Signature` HMAC over the raw body, rejects timestamps older than a
minute and drops redelivered ids; the OAuth callback only accepts a `state`
this process issued. `/mcp`, `/install/linear` and `/open/*` are localhost only,
and refuse any request whose `Host` is not a local name (a web page reaching
127.0.0.1 through DNS rebinding carries its own). Events signed for another
workspace than the installed one are ignored. Text coming from Linear is typed
only into a terminal Orca reports as running Claude, on one line, with control
bytes removed and look-alike bridge tags defused.

**MCP tools for the lane** (same `/mcp` endpoint)

- `linear_register({lane, cwd, paneId?, branch?})` — call once at boot: routes
  follow-ups to this session, flushes held messages, attaches the "Open in
  Orca" link to the lane's sessions and project.
- `linear_activity({session, type, body | action…})` — post on an agent session:
  `thought`, `action`, `elicitation` (ask the user and wait), `response`, `error`.
- `linear_plan({session, items})` — the session's checklist (full list each time).
- `linear_graphql({query, variables?})` — anything else, as the app: read the
  project, create and move issues, post project updates.
- `linear_issue_search({query, team?})` / `linear_issue_create({team, title,
  description?, labels?, project?, state?, priority?})` — file a follow-up or a
  papercut in one call; labels, project and status go by name. The trigger
  status is refused.
- `linear_adopt({project, cwd, paneId?, branch?})` — attach a worktree that was
  NOT started from Linear to a project, so the project's messages reach it.

A session without the MCP server connected can call the same tools through the
running bridge: `bun scripts/linear.ts <tool> '<json args>'` (no arguments lists
them). The script never touches the Linear token.

**Open in Orca.** `GET /open/<lane>` runs `orca worktree activate` on the lane's
worktree. The link is attached in Linear as `http://127.0.0.1:8365/open/<lane>`,
so it only does something on the laptop itself.

The job-side skill is `linear-ta` (the Linear twin of `slack-ta`, see below).
Raw events are appended to `~/.cache/slack-to-laptop/linear-events.jsonl`.

A job that dies without `finish` gets swept: streams idle > `staleStreamMinutes` are stopped and cleared.

Why each job gets ONE progress message (stream, then `chat.update` edits after
~3.5 min) and the Slack API quirks behind it: see [RECIPE.md](RECIPE.md#design-decisions--gotchas).

## Job-side skills

Don't make each job improvise the protocol: the two skills in [`skills/`](skills)
own it. `slack-ta` streams a Slack job (`/slack-ta [threadTs:…] <task>`),
`linear-ta` runs a Linear lane (`/linear-ta [lane:…] …`). Install them with

```sh
npx skills add ArnaudRinquin/laptop-bridge --global
```

They are mine, so adapt them: `slack-ta` hands the task to a private `/go`
pipeline (replace that step with your own workflow), and `linear-ta` names my
workspace and team. What is worth keeping: pass the correlation token to every
`laptop` MCP call, report at real milestones only, and always close the request
(`finish`, or a `response` / `error` activity), also on failure. If the token is
missing, do the work and skip the reporting; if a call errors with "no live
stream", the stream was swept: continue the work, stop streaming.

`GET /healthz` lists active streams.

## How it's built

Architecture, build-your-own steps, how the Linear front door was added, and
the measured Slack / Linear / Orca / SwiftBar gotchas live in [RECIPE.md](RECIPE.md).

## SwiftBar

```sh
cp swiftbar/laptop-bridge.sh ~/Library/Application\ Support/SwiftBar/Plugins/  # or your plugin dir
chmod +x .../laptop-bridge.sh
```

Streamable plugin: SwiftBar owns the process lifecycle; menubar shows 🛰️ + active
stream count. Don't also run `bun run server.ts` manually (port collision).
Test from a terminal first: `./swiftbar/laptop-bridge.sh` — you should see
blocks starting with `~~~`. Logs: `~/.cache/slack-to-laptop/server.log`
(written by the server itself — NEVER add a stderr redirect to the plugin
script: closing SwiftBar's stderr pipe makes it spin at 100%+ CPU).

SwiftBar does NOT respawn the process if it dies. To restart the bridge:
`open -g "swiftbar://refreshplugin?name=laptop-bridge"` (or SwiftBar menu →
plugin → Refresh). If the 🛰️ icon is missing but the process runs, check
`defaults read com.ameba.SwiftBar` for `"NSStatusItem VisibleCC
laptop-bridge.sh" = 0` and write it back to `-bool true`.
