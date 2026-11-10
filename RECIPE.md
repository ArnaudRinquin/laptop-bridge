# RECIPE — build your own laptop-bridge

How this project is built and how to make your own. Written for an AI coding
agent handed this file and told "build me one of these". For running *this*
instance, see `README.md`.

## Pitch

`@mention` a Slack bot → a coding agent (Claude Code) starts in a fresh git
worktree **on your own laptop** → its progress streams back into the Slack
thread as one live native "agent" message (checklist cards + prose) → a final
report lands as a single reply. Mentioning the bot again in the same thread
types the message into the still-running session instead of starting a new
one. For one developer who wants to kick off local agent jobs from Slack
(phone, another machine) without exposing anything publicly. Small enough to
rebuild in an afternoon.

## Ingredients

| Thing | Why |
|---|---|
| Bun (TypeScript, no build step) | Runtime; `bun run server.ts`, `bun test` |
| `@slack/bolt` (Socket Mode) | Receive `app_mention` with no public URL |
| `@slack/web-api` | `chat.startStream/appendStream/stopStream/update`, `assistant.threads.setStatus` |
| `@modelcontextprotocol/sdk` + `express` + `zod` | Local HTTP MCP server the job's agent calls |
| Slack app with **Agents & AI Apps** ON | Grants `assistant:write`; required for streams + setStatus |
| Bot scopes `app_mentions:read`, `chat:write`, `assistant:write`; event `app_mention` | Listen + write |
| App-level token, scope `connections:write` | Socket Mode |
| Claude Code (or any MCP-capable agent) | Does the work; calls the MCP tools |
| A job launcher (here: Orca worktrees, tmux as legacy) | Creates worktree + starts the agent in a terminal |
| Optional second front door: a Linear OAuth app (`actor=app`) + a tunnel for one path | Start and steer work from issues and projects |
| SwiftBar (optional, macOS) | Menubar status + process lifecycle |

Secrets / config (file `~/.config/slack-trigger/config.json`, shape in
`config.example.json`; names only):

- `botToken` (`xoxb-…`), `appToken` (`xapp-…`) — validated by prefix in `src/config.ts`.
- `port` (default 8365), `taskDisplayMode` (`timeline`|`plan`), `staleStreamMinutes` (60),
  `allowedUserIds` (empty = anyone), `jobCommand` (null = smoke demo), `jobCwd`,
  `orcaBin`, `tmuxBin` (absolute paths — see gotchas).
- Optional `linear` block: `clientId`, `clientSecret`, `webhookSecret`, `publicUrl`,
  `triggerStatus`, `teamRepos`, `projectRepos`, `maxLanes`, `allowedUserIds`.

Env passed to each job: `SLACK_THREAD_TS`, `SLACK_CHANNEL`, `SLACK_PROMPT`,
`SLACK_EVENT_TS`, `SLACK_MCP_URL`.

## Architecture

```
Slack ──app_mention (Socket Mode)──▶ ┌──────────── server.ts (one process) ───────────┐
  ▲                                   │ slackApp.ts  dedupe, auth, follow-up routing   │
  │ startStream / appendStream /      │ streams.ts   StreamOps: all Slack writes       │
  │ stopStream / chat.update /        │ registry.ts  threadTs → stream entry (+disk)   │
  │ setStatus                         │ jobs.ts      threadTs → session location (+disk)│
  └───────────────────────────────────│ mcpServer.ts HTTP MCP on 127.0.0.1:PORT/mcp     │
                                      │ swiftbar.ts  menubar blocks on stdout           │
                                      └──────┬───────────────────────────▲─────────────┘
                     spawn zsh -ilc jobCommand│                           │ MCP tool calls
                                              ▼                           │ (threadTs only)
                          scripts/launch-job.zsh → worktree + Claude Code ┘
                          prompt: /slack-ta [threadTs:…] <text>
                          follow-ups ◀── src/inject.ts types into the pane
```

Flow:
1. Mention → bot/dup/unauthorized filtered → if `jobs.json` knows the thread and a
   pane sits in its worktree, inject the text there (follow-up) and stop.
2. Else `StreamOps.start` opens a native stream with a spinning "Booting worktree
   job" card *before* spawning anything (instant feedback).
3. Spawn `jobCommand` (or `smokeDemo` if null). Launcher output is captured;
   non-zero exit is posted into the thread.
4. Job's agent calls MCP: `register_job` → `thinking_step`/`append_text`/`set_status`
   → `finish(markdown)`. First call completes the boot card.
5. Keepalive tick (60s) converts streams aged ≥3.5 min to edit-in-place mode.
   Sweep tick (60s) kills entries idle > `staleStreamMinutes`.

Storage: `~/.cache/slack-to-laptop/registry.json` (live streams + replay log),
`jobs.json` (session locations, kept 7 days), `server.log`. Atomic writes
(tmp + rename). `GET /healthz` lists active streams.

Key files: `server.ts`, `src/slackApp.ts`, `src/streams.ts`, `src/mcpServer.ts`,
`src/registry.ts`, `src/jobs.ts`, `src/inject.ts`, `src/config.ts`, `src/log.ts`,
`src/swiftbar.ts`, `scripts/launch-job.zsh`, `swiftbar/laptop-bridge.sh`,
`test/mcp.test.ts` (fake Slack client mirroring measured API behavior).

## Build-your-own steps

1. `bun init`; add deps from `package.json` (`@slack/bolt`, `@slack/web-api`,
   `@modelcontextprotocol/sdk`, `express`, `zod`). Copy `tsconfig.json`.
2. Create the Slack app exactly per README "Slack app (one-time)". Invite bot to a channel.
3. Config loader + logger: copy `src/config.ts`, `src/log.ts` (log to file + stderr, never stdout).
4. Registry with disk snapshot: `src/registry.ts`. Entry = `{threadTs, channel, mode,
   streamTs, teamId, userId, chunks (replay log), timestamps, bootPending}`.
5. `StreamOps` (`src/streams.ts`): start / append / convert-to-update / update
   (serialized per thread, full re-render each time) / finish / kill / keepalive.
   Port `renderBlocks` + `renderLog` for the chunk → Block Kit conversion.
6. MCP server (`src/mcpServer.ts`): stateless `StreamableHTTPServerTransport`
   (fresh server per POST), 5 tools, bind `127.0.0.1` only, `/healthz`.
7. Slack listener (`src/slackApp.ts`) with `jobCommand: null` → run, mention the
   bot, see the smoke demo (cards tick, "hi" report). This validates the Slack side
   before any jobs exist.
8. Wire `server.ts`: restore registry → `adoptRestored()` → keepalive + sweep
   intervals → MCP → Slack; on SIGTERM persist and exit **without** stopping streams.
9. Job launcher: write your own `jobCommand` script (reference
   `scripts/launch-job.zsh`; it is machine-specific). It must create a worktree,
   start the agent with the `threadTs` inside the prompt, and exit non-zero on failure.
10. `claude mcp add --transport http --scope user laptop http://127.0.0.1:8365/mcp`.
11. Job-side skill (e.g. `~/.claude/skills/slack-ta/`, not in this repo): parse
    `threadTs` from the prompt, `register_job` first, `thinking_step` at real
    milestones, `finish(markdown)` ALWAYS (also on failure). No token → work
    without streaming; "no live stream" error → keep working, stop streaming.
12. Follow-ups: `jobs.json` + `src/inject.ts` (list panes, verify cwd, type text).
13. Optional: SwiftBar plugin `swiftbar/laptop-bridge.sh` (`--swiftbar` flag).
14. Tests: `bun test` against a fake `WebClient` (see `test/mcp.test.ts`).

## Design decisions & gotchas

All "measured" items come from commit messages / README; none are in Slack docs.

**Slack streaming**
- Slack hard-kills a native stream ~5:00 after start no matter what you append;
  no keepalive, no re-stream onto an existing `ts`. ⇒ stream while young, at
  ~3.5 min `stopStream` and switch to `chat.update` on the same message forever
  (`chat.update` works on stopped streamed messages). One message per job.
- History of what failed (git log): rotation (delete + recreate; can't delete a
  live stream → `cant_delete_message`, plus ping noise) → segment-mode (new message
  per segment; splits, dup cards, pings) → current update-mode.
- `task_card` and `plan` are real Block Kit blocks, accepted by `chat.update` even
  on stopped streams ⇒ no visual downgrade after conversion. Block form: `status`
  required, `"pending"` rejected (hide pending steps), `plan.title` plain string.
- `chat.stopStream` with `markdown_text` only works on a stream with no chunks
  (`streaming_mode_mismatch`). Final report = new stream seeded with a markdown
  chunk + plain stop; fallback `chat.postMessage`.
- Frozen `in_progress` cards render with ⚠️ in stopped streams — settle them to
  complete/error before stopping.
- Edits don't bump `ts` → add a "⏳ still working — updated HH:MM" context footer.
- Limits enforced: 50 blocks/message, ~12k chars per markdown block.
- `message_not_in_streaming_state` (e.g. laptop slept past 5:00) → fold chunks into
  the replay log and convert; the edit re-renders everything.
- Report is a separate reply on purpose: it is the job's single notification.

**State & reliability**
- The job never sees Slack tokens or message ids, only `threadTs`. The bridge
  maps it. Any runner works if the token rides along and `127.0.0.1:PORT` is reachable.
- Token travels *inside the prompt* (`/slack-ta [threadTs:…] …`) because the agent
  only sees what the skill receives.
- Registry snapshot + replay log ⇒ bridge restarts are invisible; restored
  `stream` entries are force-converted on boot (liveness unknown).
- Slack redelivers events unacked after 3s → dedupe by `event_id`. Ignore bot
  mentions (loop guard).
- Conversions coalesced per thread (keepalive + MCP calls race); edits serialized
  so an older render can't overwrite a newer one.
- Keepalive doesn't touch `lastActivity`; only real job calls defer the sweep.
  Sweep (`kill`) marks spinning steps ❌ and folds a timeout note into the message.
- Every Slack write has a fallback chain ending in plain `chat.postMessage`.

**Follow-ups & terminals**
- Terminal ids are not a handle: tmux recycles pane ids, Orca's handles go stale on
  an app restart. Ground truth = the terminal's cwd equals the registered worktree.
- List tmux and Orca with `allSettled`; a dead one must not hide the other's panes.
  No tmux server is the normal state, not a failure worth logging.
- Type with `orca terminal send --text … --enter` (or `tmux send-keys -l` + `Enter`).
  Collapse newlines before typing (a raw newline submits early).
- Use the Orca CLI inside the app bundle; the `/usr/local/bin/orca` symlink is
  root-owned 0700 and can't resolve the app.
- Pick among cwd matches: registered id, else something that looks like Claude
  (Orca reports `agentIdentity: "claude"`; in tmux the claude CLI shows up as its
  version number, e.g. `2.1.x`, or `node`/`claude`), else first match.
- Mid-work, an injected follow-up is a steering message; after `finish` it's a
  new turn with full context. If no stream is live, one is reopened first
  ("Reconnecting to session…"); if the pane is gone, a fresh job is spawned with a note.

**Spawning**
- Spawn via `zsh -ilc`, not `-lc`: PATH managers (fnm/nvm/mise) load from
  `.zshrc`; login-only shell → pnpm missing, exit 127.
- fnm's `chpwd` hook is interactive-only, so a script's `cd` doesn't switch node;
  call `fnm use` explicitly.
- Base worktrees on `origin/<default>`, not the local default branch (stale →
  jobs started N commits behind).
- Pipe and log launcher output even on exit 0 (a launcher can exit 0 with no
  agent started); listen on `exit`, not `close`.
- A repo with `setupAgentStartupPolicy: wait-for-setup` makes Orca drop `--prompt`
  (`launch.prompt.outcome: "not-delivered"`): wait until Orca reports Claude in
  that terminal AND its input line shows, then type the prompt once.

**A second front door (Linear)** — all measured
- Reuse everything above; add only the edge: a verified webhook instead of a
  socket, its own correlation tokens (lane key + agent session id), its own
  report-back tools on the same MCP server.
- Decide the *unit of work* before wiring triggers. Here a project is one
  long-lived session (a lane) and its issues are messages to it, so a second
  issue types into a running terminal instead of opening a second worktree.
- Linear only delivers by HTTPS POST: tunnel ONE path (`tailscale funnel
  --set-path /linear`) and treat everything under it as hostile until the HMAC
  over the RAW body checks out (mount the route before any JSON body parser).
  Reply 200 within 5 s, work after the ack; first agent activity within 10 s.
- Everything not under that path is local: refuse any `Host` that is not a local
  name, or a web page can reach the MCP endpoint through DNS rebinding.
- An agent app cannot edit a team's workflow or create team-scoped labels
  ("not allowed to take action"); workspace labels, issues, projects, project
  updates and external links work. Initiatives need `initiative:read/write`.
- Created straight in a status = a `create` event with no `updatedFrom`; moved
  into it = `update` with `updatedFrom.stateId` (issues) / `statusId` (projects).
  Handle both or "create it already In Progress" does nothing.
- The app's own writes come back as webhooks: act only when `actor.type` is
  `user`. A session the app opens itself (`agentSessionCreateOnIssue`) is echoed
  back as `created`: remember its id and drop the echo.
- Text from Linear gets typed into a terminal: only into one the multiplexer
  reports as running the agent (after Claude exits, the same terminal is a
  shell), on one line, control bytes stripped, look-alike bridge tags defused.
- "Can't list terminals" is not "the session is gone": a busy multiplexer must
  produce a retryable error, never a second worktree.
- Messages that arrive while a lane boots are held and typed in when it
  registers; drop each from the queue only once typed.
- Linear accepts `http://127.0.0.1:…` as a session external URL and a project
  link: a localhost route that runs `orca worktree activate` makes "Open in Orca".
  A page opened that way can `window.close()` itself (not in Firefox).
- Access tokens last 24 h and the refresh token rotates: one process owns the
  token; other sessions call that process (`scripts/linear.ts`), never the API.

**SwiftBar**
- `~~~` must *lead* each streamable block; trailing it leaves the item empty.
- Never redirect stderr in the plugin script: closing the pipe makes SwiftBar spin
  at 100%+ CPU. Server writes its own log file; Bolt logs routed through `log()`.
- Use `process.stdout.write` (piped `console.log` is block-buffered); absolute
  binary paths (GUI PATH is minimal).
- SwiftBar doesn't respawn a dead process; refresh via
  `open -g "swiftbar://refreshplugin?name=laptop-bridge"`.

**Naming quirk**: config dir is `~/.config/slack-trigger/`, cache dir is
`~/.cache/slack-to-laptop/`.

**Deliberately not built**: worktree cleanup on job end (kills follow-ups).
Suggested shape: an explicit "cleanup" follow-up telling the session to remove
its worktree and exit.

## Ways to adapt

- **Launcher**: replace `scripts/launch-job.zsh` with docker / ssh / CI / plain
  `claude -p` — only contract is the `SLACK_*` env and `threadTs` in the prompt.
- **Follow-up injection**: `src/inject.ts` is the only terminal-specific code;
  swap for your terminal (or drop follow-ups).
- **Agent**: anything that speaks MCP over HTTP; keep the 5-tool protocol.
- **Status UI**: drop SwiftBar; poll `/healthz` from anything.
- **Access**: `allowedUserIds`, or extend the mention handler with channel rules.
- **Display**: `taskDisplayMode: "plan"` vs `"timeline"`.
- **Messaging platform**: the threadTs-correlation + replay-log + edit-in-place
  pattern ports to any chat API with message edits; the 5-min-stream workaround
  is Slack-specific.
