import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { mountLinear, verifySignature } from "../src/linear/routes";
import type { LinearClient } from "../src/linear/client";
import { createLinearHandler } from "../src/linear/handler";
import { LaneIndex } from "../src/linear/lanes";
import type { Config, LinearConfig } from "../src/config";
import type { Pane } from "../src/inject";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "lin_wh_test";
const LINEAR: LinearConfig = {
  clientId: "c",
  clientSecret: "s",
  webhookSecret: SECRET,
  publicUrl: "https://example.test",
  triggerStatus: "Waiting for agent",
  teamRepos: { RBD: "/repos/booker" },
  projectRepos: { Site: "/repos/site" },
  maxLanes: 2,
};
const PORT = 18466;
const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");
const seen: string[] = [];
let server: Server;

beforeAll(() => {
  const app = express();
  mountLinear(
    app,
    LINEAR,
    {} as LinearClient,
    async (_e, type) => void seen.push(type),
    join(tmpdir(), `linear-events-test-${process.pid}.jsonl`),
  );
  app.use(express.json());
  server = app.listen(PORT, "127.0.0.1");
});
afterAll(() => void server.close());

const post = (body: string, headers: Record<string, string>) =>
  fetch(`http://127.0.0.1:${PORT}/linear/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

test("verifySignature rejects wrong, missing and odd-length signatures", () => {
  const body = Buffer.from("{}");
  expect(verifySignature(SECRET, body, sign("{}"))).toBe(true);
  expect(verifySignature(SECRET, body, sign("{} "))).toBe(false);
  expect(verifySignature(SECRET, body, undefined)).toBe(false);
  expect(verifySignature(SECRET, body, "abc")).toBe(false);
});

test("webhook: bad signature 401, stale 401, valid 200 once per delivery", async () => {
  const fresh = JSON.stringify({ type: "Issue", action: "update", webhookTimestamp: Date.now() });
  expect((await post(fresh, { "linear-signature": "00" })).status).toBe(401);

  const stale = JSON.stringify({ type: "Issue", webhookTimestamp: Date.now() - 5 * 60_000 });
  expect((await post(stale, { "linear-signature": sign(stale) })).status).toBe(401);

  const headers = { "linear-signature": sign(fresh), "linear-delivery": "d-1", "linear-event": "Issue" };
  expect((await post(fresh, headers)).status).toBe(200);
  expect((await post(fresh, headers)).status).toBe(200);
  await new Promise((r) => setTimeout(r, 50));
  expect(seen).toEqual(["Issue"]);
});

test("oauth callback refuses an unknown state", async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/linear/oauth/callback?code=x&state=nope`);
  expect(res.status).toBe(400);
});

function harness(
  issues: Record<string, { identifier: string; title: string; project?: { id: string; name: string; slugId: string } }>,
  opts: { bootGraceMs?: number; failLaunches?: number } = {},
) {
  let failLaunches = opts.failLaunches ?? 0;
  const calls: { launches: { repo: string; prompt: string }[]; injected: string[]; activities: { session: string; type: string }[]; links: string[] } = {
    links: [],
    launches: [],
    injected: [],
    activities: [],
  };
  const panes: Pane[] = [];
  let sessionSeq = 0;
  const client = {
    graphql: async (query: string, vars: Record<string, any>) => {
      if (query.includes("agentActivityCreate")) {
        calls.activities.push({ session: vars.input.agentSessionId, type: vars.input.content.type });
        return {};
      }
      if (query.includes("agentSessionUpdate")) {
        calls.links.push(`${vars.id} ${vars.input.addedExternalUrls[0].url}`);
        return {};
      }
      if (query.includes("agentSessionCreateOnIssue")) return { agentSessionCreateOnIssue: { agentSession: { id: `own-${++sessionSeq}` } } };
      if (query.includes("teams")) return { teams: { nodes: [{ id: "team-rbd", key: "RBD" }, { id: "team-lab", key: "LAB" }] } };
      const i = issues[vars.id]!;
      return {
        issue: {
          id: vars.id,
          identifier: i.identifier,
          title: i.title,
          url: `https://linear.test/${i.identifier}`,
          team: { key: i.identifier.split("-")[0] },
          project: i.project ? { ...i.project, url: "https://linear.test/p" } : null,
        },
      };
    },
  } as unknown as LinearClient;
  const lanes = new LaneIndex();
  const { handle, flushPending } = createLinearHandler({
    config: { port: 8365 } as Config,
    linear: LINEAR,
    client,
    lanes,
    bootGraceMs: opts.bootGraceMs,
    launch: async ({ repo, prompt }) => {
      if (failLaunches-- > 0) throw new Error("orca is down");
      calls.launches.push({ repo, prompt });
      const cwd = `/wt/${calls.launches.length}`;
      panes.push({ id: `term_${calls.launches.length}`, path: cwd, command: "claude", mux: "orca" });
      return { cwd, paneId: `term_${calls.launches.length}` };
    },
    panes: async () => panes,
    inject: async (_pane, text) => void calls.injected.push(text),
  });
  const session = (action: string, id: string, issueId: string, body: string) =>
    handle({ action, agentSession: { id, issueId }, agentActivity: { content: { body } } }, "AgentSessionEvent");
  /** What linear_register does: the lane's Claude is up. */
  const register = (key: string) => {
    lanes.set({ ...lanes.get(key)!, registeredAt: Date.now() });
    return flushPending(key);
  };
  return { calls, lanes, panes, handle, session, register };
}

const PROJECT = { id: "proj-1", name: "Counter", slugId: "abc123" };

test("delegated issue without a project launches its own lane", async () => {
  const h = harness({ i1: { identifier: "RBD-5", title: "First try" } });
  await h.session("created", "s1", "i1", "Work on RBD-5");
  expect(h.calls.launches).toHaveLength(1);
  expect(h.calls.launches[0]!.repo).toBe("/repos/booker");
  expect(h.calls.launches[0]!.prompt).toStartWith("/linear-ta [lane:RBD-5] [linear session:s1 issue:RBD-5]");
  expect(h.lanes.get("RBD-5")?.cwd).toBe("/wt/1");
});

test("issues of one project share a lane; follow-ups are typed into it", async () => {
  const h = harness({
    i1: { identifier: "RBD-6", title: "A", project: PROJECT },
    i2: { identifier: "RBD-7", title: "B", project: PROJECT },
  });
  await h.session("created", "s1", "i1", "do A");
  await h.register("p-abc123");
  await h.session("created", "s2", "i2", "do B");
  await h.session("prompted", "s1", "i1", "also this");
  expect(h.calls.launches).toHaveLength(1);
  expect(h.calls.injected).toEqual([
    "[linear session:s2 issue:RBD-7] B — do B",
    "[linear follow-up session:s1] also this",
  ]);
  expect(h.lanes.get("p-abc123")?.sessions).toEqual(["s1", "s2"]);
  // every session of the lane carries the link, including the one that joined later
  expect(h.calls.links).toEqual(["s1 http://127.0.0.1:8365/open/p-abc123", "s2 http://127.0.0.1:8365/open/p-abc123"]);
});

test("a dead session relaunches the lane", async () => {
  const h = harness({ i1: { identifier: "RBD-5", title: "First try" } });
  await h.session("created", "s1", "i1", "go");
  await h.register("RBD-5");
  h.panes.length = 0;
  await h.session("prompted", "s1", "i1", "still there?");
  expect(h.calls.launches).toHaveLength(2);
});

test("trigger status starts work only on a human transition into it", async () => {
  const h = harness({ i1: { identifier: "RBD-8", title: "Queued" } });
  const update = (actorType: string, updatedFrom: object, state: string) =>
    h.handle({ action: "update", actor: { type: actorType }, data: { id: "i1", identifier: "RBD-8", state: { name: state } }, updatedFrom }, "Issue");
  await update("app", { stateId: "x" }, "Waiting for agent");
  await update("user", { title: "old" }, "Waiting for agent");
  await update("user", { stateId: "x" }, "Todo");
  expect(h.calls.launches).toHaveLength(0);
  await update("user", { stateId: "x" }, "Waiting for agent");
  expect(h.calls.launches).toHaveLength(1);
  // Linear echoing the session we created must not route it twice.
  await h.session("created", "own-1", "i1", "echo");
  expect(h.calls.launches).toHaveLength(1);
  expect(h.calls.injected).toHaveLength(0);
});

test("project started launches one lane; unmapped team is ignored; lane limit holds", async () => {
  const h = harness({ i9: { identifier: "RBD-9", title: "extra" } });
  const start = (slugId: string, name: string, teamIds: string[]) =>
    h.handle(
      { action: "update", actor: { type: "user" }, url: "u", data: { id: `id-${slugId}`, name, slugId, teamIds, status: { type: "started" } }, updatedFrom: { statusId: "old" } },
      "Project",
    );
  await start("aaa", "Counter", ["team-rbd"]);
  await start("aaa", "Counter", ["team-rbd"]);
  await start("bbb", "Unmapped", ["team-lab"]);
  await start("ccc", "Site", ["team-lab"]);
  expect(h.calls.launches.map((l) => l.repo)).toEqual(["/repos/booker", "/repos/site"]);
  await expect(h.session("created", "s9", "i9", "third")).rejects.toThrow("lanes already running");
  expect(h.calls.activities.at(-1)).toEqual({ session: "s9", type: "error" });
});

test("messages sent while the lane boots are held, then typed in on registration", async () => {
  const h = harness({ i1: { identifier: "RBD-6", title: "A", project: PROJECT }, i2: { identifier: "RBD-7", title: "B", project: PROJECT } });
  await h.session("created", "s1", "i1", "do A");
  await h.session("prompted", "s1", "i1", "one more thing");
  await h.session("created", "s2", "i2", "do B");
  expect(h.calls.launches).toHaveLength(1);
  expect(h.calls.injected).toHaveLength(0);
  expect(await h.register("p-abc123")).toBe(2);
  expect(h.calls.injected).toEqual(["[linear follow-up session:s1] one more thing", "[linear session:s2 issue:RBD-7] B — do B"]);
  expect(h.lanes.get("p-abc123")?.pending).toEqual([]);
});

test("a failed launch leaves no lane behind: the next message retries", async () => {
  const h = harness({ i1: { identifier: "RBD-5", title: "First try" } }, { failLaunches: 1 });
  await expect(h.session("created", "s1", "i1", "go")).rejects.toThrow("orca is down");
  expect(h.lanes.get("RBD-5")).toBeUndefined();
  expect(h.calls.activities.at(-1)).toEqual({ session: "s1", type: "error" });
  await h.session("prompted", "s1", "i1", "again");
  expect(h.calls.launches).toHaveLength(1);
});

test("a lane whose Claude terminal closed is gone, even if another tab lives in the worktree", async () => {
  const h = harness({ i1: { identifier: "RBD-5", title: "First try" } });
  await h.session("created", "s1", "i1", "go");
  await h.register("RBD-5");
  h.panes.length = 0;
  h.panes.push({ id: "term_dev", path: "/wt/1", command: "dev", mux: "orca" });
  await h.session("prompted", "s1", "i1", "still there?");
  expect(h.calls.injected).toHaveLength(0);
  expect(h.calls.launches).toHaveLength(2);
  // the message that found the lane gone rides in the relaunch prompt, not typed a second time
  expect(h.calls.launches[1]!.prompt).toContain("still there?");
  expect(await h.register("RBD-5")).toBe(0);
  expect(h.calls.injected).toHaveLength(0);
});

test("a lane that never registers reports the failure and delivers held messages once a session is live", async () => {
  const h = harness({ i1: { identifier: "RBD-5", title: "First try" } }, { bootGraceMs: 40 });
  await h.session("created", "s1", "i1", "go");
  await h.session("prompted", "s1", "i1", "held");
  expect(h.calls.injected).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 80));
  expect(h.calls.activities.at(-1)).toEqual({ session: "s1", type: "error" });
  // grace over, Claude terminal is there after all: the next message goes through, held one first
  await h.session("prompted", "s1", "i1", "now");
  expect(h.calls.injected).toEqual(["[linear follow-up session:s1] held", "[linear follow-up session:s1] now"]);
});
