import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log";

/**
 * A lane is one worktree + one Claude session. A Linear project maps to one
 * lane (all its issues are routed there); an issue without a project gets its own.
 */
export interface Lane {
  /** `p-<project slugId>` or the issue identifier (`RBD-12`). Also the token in the job's prompt. */
  key: string;
  kind: "project" | "issue";
  name: string;
  url: string;
  projectId?: string;
  issueId?: string;
  repo: string;
  branch: string;
  /** Known once the worktree exists (launcher result, confirmed by linear_register). */
  cwd?: string;
  paneId?: string;
  /** Agent sessions routed here, oldest first. The lane answers each on its own thread. */
  sessions: string[];
  launchedAt: number;
  /** Set by linear_register: Claude is up and listening. Cleared on every (re)launch. */
  registeredAt?: number;
  /** Messages that arrived while the lane was still booting; typed in once it registers. */
  pending?: string[];
}

/** Localhost-only: clicked on the laptop, brings the lane's worktree forward in Orca. */
export const openInOrcaLink = (port: number, laneKey: string) => ({
  label: "Open in Orca",
  url: `http://127.0.0.1:${port}/open/${encodeURIComponent(laneKey)}`,
});

export class LaneIndex {
  private map = new Map<string, Lane>();

  constructor(private persistPath?: string) {
    if (!persistPath) return;
    try {
      for (const l of JSON.parse(readFileSync(persistPath, "utf8")) as Lane[]) this.map.set(l.key, l);
    } catch {
      // no index yet
    }
  }

  get(key: string) {
    return this.map.get(key);
  }

  values() {
    return [...this.map.values()];
  }

  bySession(sessionId: string) {
    return this.values().find((l) => l.sessions.includes(sessionId));
  }

  delete(key: string) {
    this.map.delete(key);
    this.persist();
  }

  set(lane: Lane) {
    this.map.set(lane.key, lane);
    this.persist();
  }

  private persist() {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      // Holds held message text: owner-only, like the token file.
      writeFileSync(tmp, JSON.stringify(this.values(), null, 1), { mode: 0o600 });
      renameSync(tmp, this.persistPath);
    } catch (err) {
      log(`linear: lane index persist failed: ${err}`);
    }
  }
}
