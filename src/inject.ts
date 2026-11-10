import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./log";
import type { Config } from "./config";
import type { JobRecord } from "./jobs";

const exec = promisify(execFile);

export type Mux = "tmux" | "herdr" | "orca";

export interface Pane {
  id: string;
  path: string;
  /** cwd of the pane's foreground process — diverges from `path` while a command runs. */
  foregroundPath?: string;
  command: string;
  mux: Mux;
}

/**
 * Pick the pane hosting the job's Claude session. Registration gives us the
 * pane id, but ids are not a reliable handle on their own — tmux recycles them
 * after close, herdr re-issues them on `pane move`, Orca's go stale on an app
 * restart — so a pane only counts if
 * it currently sits in the job's worktree. Among path matches, prefer the
 * registered id, then a pane that looks like a Claude process (herdr and Orca
 * label it "claude"; the tmux-visible claude CLI shows up as its version number, e.g.
 * "2.1.211", or as node/claude).
 */
export function findPane(panes: Pane[], job: JobRecord): Pane | undefined {
  const registered = job.paneId ?? job.tmuxPane;
  const inWorktree = panes.filter((p) => p.path === job.cwd || p.foregroundPath === job.cwd);
  if (!inWorktree.length) return undefined;
  return (
    inWorktree.find((p) => p.id === registered) ??
    inWorktree.find((p) => /^(\d+\.\d+|claude|node)/.test(p.command)) ??
    inWorktree[0]
  );
}

/**
 * Every pane of every multiplexer, merged. Jobs launched before the Orca
 * migration still live in herdr (or tmux), so no list is authoritative — and a
 * dead multiplexer (no tmux server, herdr or Orca not running) must not hide
 * the others' panes, hence allSettled.
 */
export async function listPanes(config: Config): Promise<Pane[]> {
  const results = await Promise.allSettled([
    listTmuxPanes(config),
    listHerdrPanes(config),
    listOrcaPanes(config),
  ]);
  const panes: Pane[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") panes.push(...r.value);
    else log(`inject: pane listing failed: ${r.reason}`);
  }
  return panes;
}

async function listTmuxPanes(config: Config): Promise<Pane[]> {
  const { stdout } = await exec(config.tmuxBin, [
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}",
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id = "", path = "", command = ""] = l.split("\t");
      return { id, path, command, mux: "tmux" as const };
    });
}

interface HerdrPane {
  pane_id?: string;
  cwd?: string;
  foreground_cwd?: string;
  agent?: string;
  terminal_title_stripped?: string;
}

async function listHerdrPanes(config: Config): Promise<Pane[]> {
  const { stdout } = await exec(config.herdrBin, ["pane", "list"], { env: herdrEnv(config) });
  const parsed = JSON.parse(stdout) as { result?: { panes?: HerdrPane[] } };
  return (parsed.result?.panes ?? []).map((p) => ({
    id: p.pane_id ?? "",
    path: p.cwd ?? "",
    foregroundPath: p.foreground_cwd,
    // herdr names the recognised agent outright — no command-name guessing needed.
    command: p.agent ?? p.terminal_title_stripped ?? "",
    mux: "herdr" as const,
  }));
}

interface OrcaTerminal {
  handle?: string;
  worktreePath?: string;
  agentIdentity?: string;
  title?: string;
}

async function listOrcaPanes(config: Config): Promise<Pane[]> {
  const { stdout } = await exec(config.orcaBin, ["terminal", "list", "--json"]);
  const parsed = JSON.parse(stdout) as { ok?: boolean; result?: { terminals?: OrcaTerminal[] } };
  return (parsed.result?.terminals ?? []).map((t) => ({
    id: t.handle ?? "",
    path: t.worktreePath ?? "",
    command: t.agentIdentity ?? t.title ?? "",
    mux: "orca" as const,
  }));
}

/**
 * Type text into the pane's Claude session, exactly like a human would.
 * Newlines are collapsed (a raw newline would submit prematurely).
 *
 * herdr uses `pane send-text` + an `enter` key rather than `agent prompt`:
 * the agent surface does not deliver here — the text never reaches Claude's
 * input box and, without --wait, it reports success anyway.
 */
export async function injectText(config: Config, pane: Pane, text: string) {
  const oneLine = text.replace(/\s*\n+\s*/g, " ").trim();
  if (pane.mux === "orca") {
    await exec(config.orcaBin, ["terminal", "send", "--terminal", pane.id, "--text", oneLine, "--enter", "--json"]);
  } else if (pane.mux === "herdr") {
    await exec(config.herdrBin, ["pane", "send-text", pane.id, oneLine], { env: herdrEnv(config) });
    await exec(config.herdrBin, ["pane", "send-keys", pane.id, "enter"], { env: herdrEnv(config) });
  } else {
    await exec(config.tmuxBin, ["send-keys", "-t", pane.id, "-l", "--", oneLine]);
    await exec(config.tmuxBin, ["send-keys", "-t", pane.id, "Enter"]);
  }
  log(`inject: sent ${oneLine.length} chars to ${pane.mux} pane ${pane.id}`);
}

/**
 * The herdr CLI resolves its socket from $HOME, which the SwiftBar-launched
 * bridge cannot be assumed to have — pass the path outright.
 */
function herdrEnv(config: Config) {
  return { ...process.env, HERDR_SOCKET_PATH: config.herdrSocket };
}
