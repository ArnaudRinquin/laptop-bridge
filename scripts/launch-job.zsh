#!/bin/zsh
# Launched by slack-to-laptop per @mention with SLACK_THREAD_TS / SLACK_CHANNEL /
# SLACK_PROMPT / SLACK_EVENT_TS / SLACK_MCP_URL in env.
#
# Runs `wt spawn` directly — no throwaway window. The tmux version needed one:
# the monorepo's setup-tmux hook exits silently when $TMUX is unset, so `wt` had
# to run *inside* tmux for the worktree's window to appear. herdr has no such
# constraint: the hook dispatches on HERDR_ENV (which we set), and
# herdr-layout.local drives the herdr server over its socket, so nothing here
# needs to run inside a pane.
#
# Failures used to be visible as a stuck tmux window; now stdout/stderr go back
# to the bridge, which reports a non-zero exit into the Slack thread.
set -euo pipefail

HERDR_BIN=/opt/homebrew/bin/herdr
WT_BIN=/opt/homebrew/bin/wt
FNM_BIN=/opt/homebrew/bin/fnm
REPO=$HOME/projects/teetsh/monorepo
SERVER_LOG=$HOME/.cache/slack-to-laptop/herdr-server.log

BRANCH="slack-${SLACK_EVENT_TS//./-}"
PROMPT="/slack-ta [threadTs:${SLACK_THREAD_TS}] ${SLACK_PROMPT}"

# setup-tmux dispatches on HERDR_ENV before $TMUX; nothing exports it from a
# dotfile, so a job spawned by the bridge must claim the herdr path itself.
export HERDR_ENV=1
export HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}"

# Laptop just rebooted / herdr not running: start it headless, the counterpart
# of the tmux version's `new-session -d`. A later `herdr` attaches to it.
# `status server` always exits 0 — the state is in its output, not the code.
if [[ "$($HERDR_BIN status server 2>&1)" != *"status: running"* ]]; then
  mkdir -p "${SERVER_LOG:h}"
  # `exec` at the end orphans it to init anyway; disown is best-effort because
  # job control is off in a non-interactive shell and `set -e` would kill us.
  $HERDR_BIN server >>"$SERVER_LOG" 2>&1 &
  disown 2>/dev/null || true
  for _ in {1..40}; do
    [[ "$($HERDR_BIN status server 2>&1)" == *"status: running"* ]] && break
    sleep 0.25
  done
fi

# `wt spawn` is the shared alias in ~/.config/worktrunk/config.toml — a fetch plus
# `wt switch -c --base origin/<default> --no-cd`. Basing on the REMOTE default
# matters: worktrunk defaults to the local one, which goes stale between pulls, so
# slack jobs used to start N commits behind. (Monorepo PR #2176 fixed only the old
# `g wtc` alias, which this script never called.)
#
# The binary, not the `wt` shell function: that wrapper exists only to apply cd
# directives back to an interactive shell, and --no-cd emits none.
cd "$REPO"

# fnm switches node from a `chpwd` hook, which only exists in an INTERACTIVE
# shell. This script is a child of one (the bridge spawns `zsh -ilc`), so it
# inherits fnm's multishell dir but NOT the hook — the `cd` above changes no
# node version. Left alone it runs fnm's global default (v20.7.0), whose bundled
# corepack cannot load the repo's pnpm 11 and dies with
# ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING in the `deps` pre-start hook.
# `fnm use` with no argument reads the .nvmrc in $PWD.
if [[ -x $FNM_BIN ]]; then
  [[ -n "${FNM_MULTISHELL_PATH:-}" ]] || eval "$($FNM_BIN env --shell zsh)"
  $FNM_BIN use --install-if-missing || echo "launch-job: fnm use failed, continuing on $(node -v 2>&1)" >&2
fi

exec $WT_BIN spawn --name="$BRANCH" --prompt="$PROMPT"
