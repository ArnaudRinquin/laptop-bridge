import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./log";
import type { Config } from "./config";
import type { JobRecord } from "./jobs";

const exec = promisify(execFile);

export type Mux = "tmux" | "orca";

export interface Pane {
  id: string;
  path: string;
  /** cwd of the pane's foreground process — diverges from `path` while a command runs. */
  foregroundPath?: string;
  command: string;
  /** Agent the multiplexer recognises as running there ("claude"); unset for a plain shell. */
  agent?: string;
  mux: Mux;
}

/**
 * Pick the pane hosting the job's Claude session. Registration gives us the
 * pane id, but ids are not a reliable handle on their own — tmux recycles them
 * after close, Orca's go stale on an app restart — so a pane only counts if it
 * currently sits in the job's worktree. Among path matches, prefer the
 * registered id, then a pane that looks like a Claude process (Orca labels it
 * "claude"; the tmux-visible claude CLI shows up as its version number, e.g.
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
 * migration may still live in tmux, so no list is authoritative — and a dead
 * one (no tmux server, Orca not running) must not hide the other's panes.
 */
export async function listPanes(config: Config): Promise<Pane[]> {
  const results = await Promise.allSettled([listTmuxPanes(config), listOrcaPanes(config)]);
  const panes: Pane[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") panes.push(...r.value);
    else log(`inject: pane listing failed: ${r.reason}`);
  }
  return panes;
}

async function listTmuxPanes(config: Config): Promise<Pane[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec(config.tmuxBin, [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}",
    ]));
  } catch (err) {
    // No tmux server (or no tmux at all) is the normal state now: no panes, not a failure.
    if (/no server running|error connecting|ENOENT/.test(String(err))) return [];
    throw err;
  }
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id = "", path = "", command = ""] = l.split("\t");
      return { id, path, command, mux: "tmux" as const };
    });
}

interface OrcaTerminal {
  handle?: string;
  worktreePath?: string;
  agentIdentity?: string;
  title?: string;
}

/**
 * Throws when Orca can't answer or the list is cut short: callers that decide
 * "this session is gone" from the list must not mistake a busy Orca for it.
 */
export async function listOrcaPanes(config: Config): Promise<Pane[]> {
  const { stdout } = await exec(config.orcaBin, ["terminal", "list", "--json"], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { ok?: boolean; result?: { terminals?: OrcaTerminal[]; truncated?: boolean } };
  if (!parsed.ok || !parsed.result?.terminals) throw new Error("orca terminal list returned no terminals field");
  if (parsed.result.truncated) throw new Error("orca terminal list was truncated");
  return parsed.result.terminals.map((t) => ({
    id: t.handle ?? "",
    path: t.worktreePath ?? "",
    command: t.agentIdentity ?? t.title ?? "",
    agent: t.agentIdentity ?? undefined,
    mux: "orca" as const,
  }));
}

/**
 * Type text into the pane's Claude session, exactly like a human would.
 * Newlines are collapsed (a raw newline would submit prematurely).
 */
export async function injectText(config: Config, pane: Pane, text: string) {
  const oneLine = text.replace(/\s*\n+\s*/g, " ").trim();
  if (pane.mux === "orca") {
    await exec(config.orcaBin, ["terminal", "send", "--terminal", pane.id, "--text", oneLine, "--enter", "--json"], { timeout: 30_000 });
  } else {
    await exec(config.tmuxBin, ["send-keys", "-t", pane.id, "-l", "--", oneLine]);
    await exec(config.tmuxBin, ["send-keys", "-t", pane.id, "Enter"]);
  }
  log(`inject: sent ${oneLine.length} chars to ${pane.mux} pane ${pane.id}`);
}
