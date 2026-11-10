import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log";

/**
 * Durable job index: threadTs → where the job's Claude session lives.
 * Populated by the job itself via the register_job MCP tool (no path
 * heuristics in the bridge). Entries OUTLIVE finish() so follow-up mentions
 * can be routed to the still-open session; pruned after MAX_AGE.
 */
export interface JobRecord {
  threadTs: string;
  /** Worktree the job runs in — ground truth for pane verification. */
  cwd: string;
  /** Pane hosting the session: $ORCA_TERMINAL_HANDLE ("term_…"), $HERDR_PANE_ID ("w7:p2") or $TMUX_PANE ("%42"). Never trusted alone — always verified against cwd. */
  paneId?: string;
  /** Pre-herdr name for `paneId`. Read-only: persisted records written before the migration still carry it. */
  tmuxPane?: string;
  pid?: number;
  branch?: string;
  registeredAt: number;
}

const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export class JobsIndex {
  private map = new Map<string, JobRecord>();

  constructor(private persistPath?: string) {
    if (!persistPath) return;
    try {
      const entries: JobRecord[] = JSON.parse(readFileSync(persistPath, "utf8"));
      const cutoff = Date.now() - MAX_AGE_MS;
      for (const r of entries) {
        if (r?.threadTs && r.registeredAt >= cutoff) this.map.set(r.threadTs, r);
      }
    } catch {
      // no index yet
    }
  }

  get(threadTs: string) {
    return this.map.get(threadTs);
  }

  set(record: JobRecord) {
    this.map.set(record.threadTs, record);
    this.persist();
  }

  private persist() {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.map.values()]));
      renameSync(tmp, this.persistPath);
    } catch (err) {
      log(`jobs: persist failed: ${err}`);
    }
  }
}
