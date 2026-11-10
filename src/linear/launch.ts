import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../log";
import type { Config } from "../config";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Launched {
  cwd: string;
  paneId?: string;
}

export type Launcher = (opts: { repo: string; branch: string; prompt: string }) => Promise<Launched>;

interface CreateResult {
  ok?: boolean;
  error?: { message?: string };
  result?: {
    worktree?: { path?: string };
    launch?: { outcome?: { handle?: string }; prompt?: { outcome?: string } };
    agentTerminalHandle?: string;
  };
}

/** New Orca worktree off the remote default branch, Claude in its first terminal. */
export function orcaLauncher(config: Config): Launcher {
  const orca = (args: string[], timeout = 120_000) =>
    exec(config.orcaBin, args, { timeout, maxBuffer: 8 * 1024 * 1024 });

  const create = async (repo: string, branch: string, prompt: string): Promise<CreateResult> => {
    const { stdout } = await orca([
      "worktree", "create", "--repo", `path:${repo}`, "--name", branch, "--no-parent",
      "--base-branch", "origin/main", "--agent", "claude", "--prompt", prompt, "--setup", "run", "--json",
    ]);
    return JSON.parse(stdout);
  };

  return async ({ repo, branch, prompt }) => {
    await exec("git", ["-C", repo, "fetch", "--quiet", "origin", "main"], { timeout: 60_000 }).catch((err) =>
      log(`linear: fetch failed for ${repo}, origin/main may be stale: ${err}`),
    );
    let out: CreateResult;
    try {
      out = await create(repo, branch, prompt);
    } catch (err) {
      // Retry only when Orca was not there to answer. A timeout or a garbled
      // reply may hide a worktree that WAS created; a second create would
      // leave an orphan Claude holding the same prompt.
      const e = err as { killed?: boolean; signal?: string | null; stdout?: string };
      if (e.killed || e.signal || err instanceof SyntaxError || e.stdout?.trim()) throw err;
      log(`linear: worktree create failed before Orca answered, opening Orca and retrying: ${err}`);
      await orca(["open", "--json"]);
      out = await create(repo, branch, prompt);
    }
    const cwd = out.result?.worktree?.path;
    if (!out.ok || !cwd) throw new Error(`orca worktree create failed: ${out.error?.message ?? JSON.stringify(out).slice(0, 400)}`);
    const paneId = out.result?.launch?.outcome?.handle ?? out.result?.agentTerminalHandle;

    // With setupAgentStartupPolicy: wait-for-setup Orca drops --prompt; Claude
    // then starts on an empty input once setup ends and we type it ourselves.
    if (paneId && out.result?.launch?.prompt?.outcome === "not-delivered") {
      void deliverWhenReady(orca, paneId, prompt).catch((err) => log(`linear: prompt delivery failed for ${paneId}: ${err}`));
    }
    return { cwd, paneId };
  };
}

async function deliverWhenReady(
  orca: (args: string[], timeout?: number) => Promise<{ stdout: string }>,
  paneId: string,
  prompt: string,
) {
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    await sleep(5000);
    // Both must hold: Orca sees Claude in that terminal (not the setup shell,
    // whose prompt may use the same glyph) and Claude shows its input line.
    const list = await orca(["terminal", "list", "--json"], 30_000).catch(() => ({ stdout: "{}" }));
    const terminals = (JSON.parse(list.stdout || "{}") as { result?: { terminals?: { handle?: string; agentIdentity?: string }[] } }).result?.terminals;
    if (terminals?.find((t) => t.handle === paneId)?.agentIdentity !== "claude") continue;
    const { stdout } = await orca(["terminal", "read", "--terminal", paneId, "--json"], 30_000).catch(() => ({ stdout: "" }));
    if (!stdout.includes("❯")) continue;
    const sent = await orca(
      ["terminal", "send", "--terminal", paneId, "--text", prompt, "--enter", "--wait-submit", "15", "--json"],
      60_000,
    );
    // One attempt only: typing the prompt twice would start the job twice.
    log(`linear: prompt typed into ${paneId} after setup (${sent.stdout.includes("turn_started") ? "turn started" : "start unconfirmed"})`);
    return;
  }
  throw new Error("Claude never became ready within 20 minutes");
}
