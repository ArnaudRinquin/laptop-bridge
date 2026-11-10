---
name: linear-ta
description: Lane launched from Linear via laptop-bridge. Use when the prompt starts with /linear-ta, or when a message starts with "[linear session:" or "[linear follow-up session:". Reports to Linear agent sessions and project updates through the laptop MCP (linear_register / linear_activity / linear_plan / linear_graphql).
---

# linear-ta — Linear-driven lane

You were started from Arnaud's personal Linear workspace. Args:

`[lane:<key>] [linear session:<sid> issue:<ID>]? <scope> — <request>`

- `lane` identifies this worktree to the bridge. One lane = one worktree = one Linear **project** (all its issues come to you), or one standalone **issue**.
- `session` is a Linear agent-session thread: where the user asked, and where you answer. A lane can serve several sessions over time; always answer on the session a message came with.

All Linear access goes through the `laptop` MCP (http://127.0.0.1:8365/mcp). Do NOT use the `claude.ai Linear` connector or `orca linear`: they are logged into the Teetsh workspace, the wrong one.

No `mcp__laptop__linear_*` tools in your session (it started while the bridge was down)? Same tools from a shell, through the running bridge: `bun ~/projects/laptop-bridge/scripts/linear.ts <tool> '<json args>'` (no arguments lists them).

Lane not started from Linear (an existing worktree being moved to a Linear project)? Use `linear_adopt({project, cwd, paneId, branch})` instead of `linear_register`.

## Boot (in this order)

1. `linear_register({lane, cwd: <pwd>, paneId: $ORCA_TERMINAL_HANDLE, branch})`. Never skip: it routes follow-ups to you and creates the "Open in Orca" link.
2. If you have a session: `linear_activity({session, type: "thought", body: "<one line: what you understood>"})`.
3. Rename the terminal: `/Applications/Orca.app/Contents/Resources/bin/orca terminal rename --terminal "$ORCA_TERMINAL_HANDLE" --title "<project or issue id>" --json`.
4. Read the brief with `linear_graphql`:
   - project lane: `query($id:String!){ project(id:$id){ name description content status{name} issues{ nodes{ id identifier title description state{name type} } } } }`
   - issue lane: `query($id:String!){ issue(id:$id){ id identifier title description state{name} comments{ nodes{ body user{name} } } } }` (id accepts `RBD-12`)

## Doing the work

- Follow the repository's own `CLAUDE.md` for how work is done, reviewed, tested and merged. Do NOT run `/go` and do not auto-merge: this is not the Teetsh pipeline. If the repo says to wait for Arnaud's go, ask for it with an `elicitation`.
- Nobody watches the terminal. When you need a decision, ask on the session: `linear_activity({session, type: "elicitation", body})`, then stop and wait; the answer arrives as a `[linear follow-up session:…]` message.
- Progress on a session: `linear_plan` for the checklist (send the full list each time), `linear_activity` type `action` at real milestones only. Keep it sparse.
- End every request with `linear_activity` type `response` (what changed, test results, PR link) or `error`. A session left without one looks stuck.

## Tracking in Linear (project lanes)

Issues are your lane's tracking; keep them true as you go, via `linear_graphql`.

**You do move issue statuses here.** The global rule "never update Linear issue status manually" is about the Teetsh workspace and its automations. In this personal workspace you own the status of your lane's issues: move one to In Progress when you start it and to Done when its work is finished and verified. Two exceptions: if an issue has a linked PR, leave In Review / Done to the GitHub integration; and see "Waiting for agent" below. Say in your `response` which issues you moved.

- State ids: `query{ team(id:"RBD"){ id states{ nodes{ id name type } } } }`
- Create: `linear_issue_create({team, project, title, description, labels, state})` (names, not ids; `linear_issue_search` first)
- Move: `mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id,input:$i){ success } }` with `{stateId}`
- Checkpoint (CI green, hand-over ready, merged, blocked): `mutation($i:ProjectUpdateCreateInput!){ projectUpdateCreate(input:$i){ success } }` with `{projectId, body, health}` (`onTrack` | `atRisk` | `offTrack`). Body: where the lane stands, what is next, what you need from Arnaud.

Never move an issue into "Waiting for agent": that status is how the user triggers you.

## Messages typed into your session by the bridge

- `[linear session:<sid> issue:<ID>] <title> — <request>`: a new request on another issue of your lane. Acknowledge on that session, fold it in, answer there when done.
- `[linear follow-up session:<sid>] <text>`: the user replying on a thread you already serve. Mid-work it is steering; after a `response` it is a new turn. "STOP requested" means stop and report where things stand.

## Rules

- Never guess a session id or lane key. Missing token: do the work, skip the Linear calls that need it.
- If a tool errors, keep working; mention it in the final response.
