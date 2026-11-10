import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";

export interface LinearConfig {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** Public origin that forwards /linear to this bridge (Tailscale Funnel). */
  publicUrl: string;
  /** Issue status that starts work when an issue is moved into it. */
  triggerStatus: string;
  /** Team key → repo path, e.g. { "RBD": "/Users/me/projects/booker" }. */
  teamRepos: Record<string, string>;
  /** Project name → repo path; wins over the team's repo. */
  projectRepos: Record<string, string>;
  /** Lanes with a live session allowed at once; further starts are refused. */
  maxLanes: number;
  /** Linear user ids allowed to start work. Empty = any member of the workspace. */
  allowedUserIds: string[];
}

export interface Config {
  /** Absent = Linear front door off; the Slack side is unaffected. */
  linear?: LinearConfig;
  botToken: string;
  appToken: string;
  port: number;
  taskDisplayMode: "timeline" | "plan";
  staleStreamMinutes: number;
  /**
   * Shell command spawned per mention (via /bin/zsh -ilc — interactive, so
   * .zshrc PATH managers like fnm/nvm/mise are loaded). Receives env:
   * SLACK_THREAD_TS, SLACK_CHANNEL, SLACK_PROMPT, SLACK_EVENT_TS, SLACK_MCP_URL.
   * If null, runs a built-in smoke demo (stream "hi" + a task card, then stop).
   */
  jobCommand: string | null;
  jobCwd: string;
  /** Slack user IDs allowed to trigger jobs. Empty = anyone. Others get a threaded refusal. */
  allowedUserIds: string[];
  /** tmux binary (absolute — the SwiftBar env has a minimal PATH). */
  tmuxBin: string;
  /**
   * Orca CLI inside the app bundle. Not /usr/local/bin/orca: that symlink is
   * root-owned mode 0700, and the CLI fails to resolve Orca.app through it.
   */
  orcaBin: string;
}

export const CONFIG_PATH = join(homedir(), ".config", "slack-trigger", "config.json");

export function loadConfig(): Config {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch {
    throw new Error(`missing config: ${CONFIG_PATH} — copy config.example.json there and fill tokens`);
  }
  const j = JSON.parse(raw);
  if (!j.botToken?.startsWith("xoxb-")) throw new Error("config.botToken must be an xoxb- bot token");
  if (!j.appToken?.startsWith("xapp-")) throw new Error("config.appToken must be an xapp- app-level token");
  return {
    linear: parseLinear(j.linear),
    botToken: j.botToken,
    appToken: j.appToken,
    port: j.port ?? 8365,
    taskDisplayMode: j.taskDisplayMode === "plan" ? "plan" : "timeline",
    staleStreamMinutes: j.staleStreamMinutes ?? 60,
    jobCommand: j.jobCommand ?? null,
    jobCwd: j.jobCwd ?? homedir(),
    allowedUserIds: Array.isArray(j.allowedUserIds)
      ? j.allowedUserIds.filter((x: unknown): x is string => typeof x === "string")
      : [],
    tmuxBin: j.tmuxBin ?? "/opt/homebrew/bin/tmux",
    orcaBin: j.orcaBin ?? "/Applications/Orca.app/Contents/Resources/bin/orca",
  };
}

function parseLinear(l: Record<string, unknown> | undefined): LinearConfig | undefined {
  if (!l) return undefined;
  for (const k of ["clientId", "clientSecret", "webhookSecret", "publicUrl"]) {
    if (typeof l[k] !== "string" || !l[k]) {
      // Not fatal: a half-filled Linear block must not take the Slack side down with it.
      log(`config.linear.${k} is missing — Linear front door disabled`);
      return undefined;
    }
  }
  return {
    clientId: l.clientId as string,
    clientSecret: l.clientSecret as string,
    webhookSecret: l.webhookSecret as string,
    publicUrl: (l.publicUrl as string).replace(/\/$/, ""),
    triggerStatus: typeof l.triggerStatus === "string" ? l.triggerStatus : "Waiting for agent",
    teamRepos: (l.teamRepos as Record<string, string>) ?? {},
    projectRepos: (l.projectRepos as Record<string, string>) ?? {},
    maxLanes: typeof l.maxLanes === "number" ? l.maxLanes : 3,
    allowedUserIds: Array.isArray(l.allowedUserIds) ? l.allowedUserIds.filter((x: unknown): x is string => typeof x === "string") : [],
  };
}
