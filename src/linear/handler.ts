import { log } from "../log";
import type { Config, LinearConfig } from "../config";
import { findPane, injectText, listPanes, type Pane } from "../inject";
import type { LinearClient } from "./client";
import type { Lane, LaneIndex } from "./lanes";
import type { Launcher } from "./launch";
import type { LinearEventHandler } from "./routes";

export function postActivity(client: LinearClient, agentSessionId: string, content: Record<string, unknown>) {
  return client.graphql(
    `mutation ($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`,
    { input: { agentSessionId, content } },
  );
}

interface IssueInfo {
  id: string;
  identifier: string;
  title: string;
  url: string;
  team: { key: string };
  project: { id: string; name: string; slugId: string; url: string } | null;
}

const ISSUE_QUERY = `query ($id: String!) {
  issue(id: $id) { id identifier title url team { key } project { id name slugId url } }
}`;

export interface HandlerDeps {
  config: Config;
  linear: LinearConfig;
  client: LinearClient;
  lanes: LaneIndex;
  launch: Launcher;
  /** Injectable for tests. */
  panes?: () => Promise<Pane[]>;
  inject?: (pane: Pane, text: string) => Promise<void>;
}

const oneLine = (s: string, max = 600) => s.replace(/\s+/g, " ").trim().slice(0, max);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "lane";

/**
 * Routing: a project is a lane (one worktree, every issue of the project lands
 * there); an issue without a project is its own lane. Work starts on a
 * delegation / @mention (agent session), on an issue entering the trigger
 * status, or on a project entering a started status.
 */
/** How long a launched lane may take to register before it is considered dead. */
const BOOT_GRACE_MS = 20 * 60_000;

export interface LinearHandler {
  handle: LinearEventHandler;
  /** Called when a lane registers: type in what arrived while it was booting. */
  flushPending: (laneKey: string) => Promise<number>;
}

export function createLinearHandler(deps: HandlerDeps): LinearHandler {
  const { config, linear, client, lanes, launch } = deps;
  const panes = deps.panes ?? (() => listPanes(config));
  const inject = deps.inject ?? ((pane, text) => injectText(config, pane, text));
  /** Sessions this process created itself — Linear may echo them back as `created`. */
  const ownSessions = new Set<string>();
  /** Serialises routing: two events for one project must not create two worktrees. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const livePane = async (lane: Lane, all?: Pane[]) =>
    lane.cwd ? findPane(all ?? (await panes()), { threadTs: lane.key, cwd: lane.cwd, paneId: lane.paneId, registeredAt: 0 }) : undefined;

  const booting = (lane: Lane) => !lane.registeredAt && Date.now() - lane.launchedAt < BOOT_GRACE_MS;

  /** Type into the lane, or hold the message while Claude is not listening yet. */
  async function deliver(lane: Lane, text: string): Promise<"sent" | "queued" | "gone"> {
    if (booting(lane)) {
      lanes.set({ ...lanes.get(lane.key)!, pending: [...(lanes.get(lane.key)!.pending ?? []), text] });
      return "queued";
    }
    const pane = await livePane(lane);
    if (!pane) return "gone";
    await inject(pane, text);
    return "sent";
  }

  async function flushPending(laneKey: string) {
    const lane = lanes.get(laneKey);
    if (!lane?.pending?.length) return 0;
    const pane = await livePane(lane);
    if (!pane) return 0;
    const pending = lane.pending;
    lanes.set({ ...lane, pending: [] });
    for (const text of pending) await inject(pane, text);
    log(`linear: flushed ${pending.length} held message(s) into lane ${laneKey}`);
    return pending.length;
  }

  const repoFor = (teamKey: string, projectName?: string) =>
    (projectName && linear.projectRepos[projectName]) || linear.teamRepos[teamKey];

  async function startLane(lane: Lane, prompt: string) {
    const all = await panes();
    const running = (await Promise.all(lanes.values().map((l) => livePane(l, all)))).filter(Boolean).length;
    if (running >= linear.maxLanes) {
      throw new Error(`${running} lanes already running (limit ${linear.maxLanes}) — close one or retry later`);
    }
    // Recorded before the launch so a second event for the same lane routes instead of launching again.
    lanes.set(lane);
    const launched = await launch({ repo: lane.repo, branch: lane.branch, prompt });
    lanes.set({ ...lanes.get(lane.key)!, cwd: launched.cwd, paneId: launched.paneId });
    log(`linear: lane ${lane.key} launched in ${launched.cwd}`);
  }

  async function routeSession(sessionId: string, issueId: string, request: string) {
    const { issue } = await client.graphql<{ issue: IssueInfo }>(ISSUE_QUERY, { id: issueId });
    const key = issue.project ? `p-${issue.project.slugId}` : issue.identifier;
    const existing = lanes.get(key);
    const tag = `[linear session:${sessionId} issue:${issue.identifier}]`;

    if (existing) {
      lanes.set({ ...existing, sessions: [...new Set([...existing.sessions, sessionId])] });
      const outcome = await deliver(lanes.get(key)!, `${tag} ${oneLine(issue.title, 120)} — ${oneLine(request)}`);
      if (outcome !== "gone") {
        const body = outcome === "sent" ? `Sent to the running lane \`${existing.name}\`.` : `The lane \`${existing.name}\` is still starting — your message is held and will be delivered when it is up.`;
        await postActivity(client, sessionId, { type: "thought", body });
        return;
      }
      await postActivity(client, sessionId, { type: "thought", body: "The previous session for this lane is gone — starting a fresh one." });
    } else {
      await postActivity(client, sessionId, { type: "thought", body: "Received on the laptop — creating a worktree." });
    }

    const repo = existing?.repo ?? repoFor(issue.team.key, issue.project?.name);
    if (!repo) {
      await postActivity(client, sessionId, {
        type: "error",
        body: `No repository is mapped for team ${issue.team.key}${issue.project ? ` / project "${issue.project.name}"` : ""}. Add it to \`linear.teamRepos\` or \`linear.projectRepos\` in the bridge config.`,
      });
      return;
    }
    const lane: Lane = {
      key,
      kind: issue.project ? "project" : "issue",
      name: issue.project?.name ?? `${issue.identifier} ${issue.title}`,
      url: issue.project?.url ?? issue.url,
      projectId: issue.project?.id,
      issueId: issue.project ? undefined : issue.id,
      repo,
      branch: `${slug(issue.project?.name ?? `${issue.identifier}-${issue.title}`)}-${Date.now().toString(36).slice(-4)}`,
      sessions: [...new Set([...(existing?.sessions ?? []), sessionId])],
      launchedAt: Date.now(),
      pending: existing?.pending,
    };
    const scope = issue.project ? `project "${oneLine(issue.project.name, 80)}" (id ${issue.project.id})` : "single issue";
    try {
      await startLane(lane, `/linear-ta [lane:${key}] ${tag} ${scope} — ${oneLine(issue.title, 120)} — ${oneLine(request)}`);
    } catch (err) {
      await postActivity(client, sessionId, { type: "error", body: `Couldn't start the lane: ${err instanceof Error ? err.message : err}` });
      throw err;
    }
  }

  async function onAgentSession(event: Record<string, unknown>) {
    const session = event.agentSession as { id?: string; issueId?: string } | undefined;
    const activity = event.agentActivity as { content?: { body?: string }; signal?: string | null } | undefined;
    if (!session?.id) return;
    const body = activity?.content?.body ?? "";

    if (event.action === "created") {
      if (ownSessions.delete(session.id)) return;
      if (!session.issueId) {
        await postActivity(client, session.id, { type: "error", body: "I can only work from an issue for now." });
        return;
      }
      await routeSession(session.id, session.issueId, body);
      return;
    }
    if (event.action === "prompted") {
      const lane = lanes.bySession(session.id);
      if (lane) {
        const text = activity?.signal === "stop" ? "STOP requested by the user — stop what you are doing and say where things stand." : oneLine(body, 2000);
        const outcome = await deliver(lane, `[linear follow-up session:${session.id}] ${text}`);
        if (outcome === "queued") {
          await postActivity(client, session.id, { type: "thought", body: "The lane is still starting — your message is held and will be delivered when it is up." });
        }
        if (outcome !== "gone") return;
      }
      if (session.issueId) {
        await routeSession(session.id, session.issueId, body);
        return;
      }
      await postActivity(client, session.id, { type: "error", body: "The session for this thread is gone and I can't tell which issue it belongs to." });
    }
  }

  async function onIssueUpdate(event: Record<string, unknown>) {
    const data = event.data as { id: string; identifier?: string; state?: { name?: string } };
    const from = event.updatedFrom as { stateId?: string } | undefined;
    if (!from?.stateId || data.state?.name !== linear.triggerStatus) return;
    const created = await client.graphql<{ agentSessionCreateOnIssue: { agentSession: { id: string } } }>(
      `mutation ($input: AgentSessionCreateOnIssue!) { agentSessionCreateOnIssue(input: $input) { agentSession { id } } }`,
      { input: { issueId: data.id } },
    );
    const sessionId = created.agentSessionCreateOnIssue.agentSession.id;
    ownSessions.add(sessionId);
    await routeSession(sessionId, data.id, `Handle ${data.identifier ?? "this issue"} (moved to "${linear.triggerStatus}").`);
  }

  async function onProjectUpdate(event: Record<string, unknown>) {
    const data = event.data as { id: string; name: string; slugId: string; teamIds?: string[]; status?: { type?: string } };
    const from = event.updatedFrom as { statusId?: string } | undefined;
    if (!from?.statusId || data.status?.type !== "started") return;
    const key = `p-${data.slugId}`;
    const existing = lanes.get(key);
    if (existing && (booting(existing) || (await livePane(existing)))) return;

    const { teams } = await client.graphql<{ teams: { nodes: { id: string; key: string }[] } }>(`{ teams { nodes { id key } } }`);
    const teamKey = teams.nodes.find((t) => data.teamIds?.includes(t.id))?.key ?? "";
    const repo = existing?.repo ?? repoFor(teamKey, data.name);
    if (!repo) {
      log(`linear: project "${data.name}" started but no repo is mapped for team ${teamKey || "?"} — ignored`);
      return;
    }
    await startLane(
      {
        key,
        kind: "project",
        name: data.name,
        url: String(event.url ?? ""),
        projectId: data.id,
        repo,
        branch: `${slug(data.name)}-${Date.now().toString(36).slice(-4)}`,
        sessions: existing?.sessions ?? [],
        launchedAt: Date.now(),
      },
      `/linear-ta [lane:${key}] project "${oneLine(data.name, 80)}" (id ${data.id}) was started — read its description and issues, then drive it.`,
    );
  }

  const handle: LinearEventHandler = async (event, eventType) => {
    // The lane's own writes come back as events; only a human's change triggers work.
    const actor = event.actor as { id?: string; type?: string } | undefined;
    if (eventType !== "AgentSessionEvent" && actor?.type !== "user") return;

    if (eventType === "AgentSessionEvent") await serial(() => onAgentSession(event));
    else if (eventType === "Issue" && event.action === "update") await serial(() => onIssueUpdate(event));
    else if (eventType === "Project" && event.action === "update") await serial(() => onProjectUpdate(event));
  };
  return { handle, flushPending: (key) => serial(() => flushPending(key)) };
}
