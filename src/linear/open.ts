import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type express from "express";
import { log } from "../log";
import type { Config } from "../config";
import type { LaneIndex } from "./lanes";

const exec = promisify(execFile);
const page = (msg: string) =>
  `<!doctype html><meta charset="utf-8"><title>Orca</title><body style="font:16px system-ui;margin:3rem">${msg}</body>`;

/** "Open in Orca" links from Linear land here. Localhost only: not under /linear. */
export function mountOpen(app: express.Express, config: Config, lanes: LaneIndex) {
  app.get("/open/:key", async (req, res) => {
    const lane = lanes.get(req.params.key);
    if (!lane?.cwd) {
      res.status(404).send(page("No worktree is known for this lane."));
      return;
    }
    try {
      await exec(config.orcaBin, ["worktree", "activate", "--worktree", `path:${lane.cwd}`, "--json"], { timeout: 30_000 });
      await exec("/usr/bin/open", ["-a", "Orca"]).catch(() => {});
      res.send(page(`Opened <b>${lane.name.replace(/[<&]/g, "")}</b> in Orca. You can close this tab.`));
    } catch (err) {
      log(`linear: open failed for ${lane.key}: ${err}`);
      res.status(500).send(page("Orca couldn't open that worktree — it may have been removed."));
    }
  });
}
