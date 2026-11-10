#!/bin/zsh
# Launched by laptop-bridge per @mention with SLACK_THREAD_TS / SLACK_CHANNEL /
# SLACK_PROMPT / SLACK_EVENT_TS / SLACK_MCP_URL in env.
#
# Creates an Orca worktree with claude in its first terminal. The monorepo's
# Worktrunk pre-start hooks (ports, strapi DB, deps, claude settings symlink)
# run as the setup script from the monorepo's committed orca.yaml, whose
# setupAgentStartupPolicy: wait-for-setup holds claude until they finish.
#
# Failures go back to the bridge via stdout/stderr and a non-zero exit, which it
# reports into the Slack thread.
set -euo pipefail

# Not /usr/local/bin/orca: that symlink is root-owned mode 0700 and the CLI
# fails to resolve Orca.app through it.
ORCA_BIN=/Applications/Orca.app/Contents/Resources/bin/orca
REPO=$HOME/projects/teetsh/monorepo

BRANCH="slack-${SLACK_EVENT_TS//./-}"
PROMPT="/slack-ta [threadTs:${SLACK_THREAD_TS}] ${SLACK_PROMPT}"

# Basing on the REMOTE default matters: the local main goes stale between
# pulls, and jobs used to start N commits behind.
git -C "$REPO" fetch --quiet origin main || echo "launch-job: fetch failed, origin/main may be stale" >&2

create() {
  $ORCA_BIN worktree create --repo "path:$REPO" --name "$BRANCH" --no-parent \
    --base-branch origin/main --agent claude --prompt "$PROMPT" --setup run --json
}

# Laptop just rebooted / Orca not running: open it, then retry once.
if ! OUT="$(create 2>&1)"; then
  echo "launch-job: first create failed, opening Orca and retrying: $OUT" >&2
  $ORCA_BIN open --json >/dev/null
  OUT="$(create 2>&1)" || true
fi

if [[ "$(print -r -- "$OUT" | /usr/bin/jq -r '.ok // false' 2>/dev/null)" != true ]]; then
  echo "launch-job: orca worktree create failed: $OUT" >&2
  exit 1
fi

print -r -- "$OUT" | /usr/bin/jq -r '"launch-job: \(.result.worktree.path // .result.worktree.id) agent=\(.result.agentTerminalHandle // .result.startupTerminal.handle // "none")"'
