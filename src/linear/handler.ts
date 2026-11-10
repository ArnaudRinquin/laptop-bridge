import { log } from "../log";
import type { Config, LinearConfig } from "../config";
import { injectText, listOrcaPanes, type Pane } from "../inject";
import type { LinearClient } from "./client";
import { openInOrcaLink, type Lane, type LaneIndex } from "./lanes";
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
  /** Injectable for tests. Must THROW when the terminals can't be listed: an empty list means "no terminals". */
  panes?: () => Promise<Pane[]>;
  inject?: (pane: Pane, text: string) => Promise<void>;
  bootGraceMs?: number;
}

/**
 * Text from Linear (titles, comments) ends up typed into a terminal and read
 * by the lane as a message. One line, no control bytes, and it must not be
 * able to forge the tags the bridge itself puts in front.
 */
export const untrusted = (s: string, max = 600) =>
  s
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\[(?=\s*(linear\b|lane:|slack\b))/gi, "(")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "lane";
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** How long a launched lane may take to register before it is considered dead. */
const BOOT_GRACE_MS = 20 * 60_000;

export interface LinearHandler {
  handle: LinearEventHandler;
  /** Called when a lane registers: type in what arrived while it was booting. */
  flushPending: (laneKey: string) => Promise<number>;
}

/**
 * Routing: a project is a lane (one worktree, every issue of the project lands
 * there); an issue without a project is its own lane. Work starts on a
 * delegation / @mention (agent session), on an issue entering the trigger
 * status, or on a project entering a started status.
 */
export function createLinearHandler(deps: HandlerDeps): LinearHandler {
  const { config, linear, client, lanes, launch } = deps;
  const panes = deps.panes ?? (() => listOrcaPanes(config));
  const inject = deps.inject ?? ((pane, text) => injectText(config, pane, text));
  const bootGraceMs = deps.bootGraceMs ?? BOOT_GRACE_MS;
  /** Sessions this process created itself — Linear echoes them back as `created`. */
  const ownSessions = new Set<string>();
  /** Serialises routing: two events for one project must not create two worktrees. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  /**
   * The lane's Claude terminal: in the lane's worktree AND running Claude.
   * A worktree also has plain tabs (a dev server…), and the registered
   * terminal becomes a bare shell when Claude exits — text typed there would
   * be lost at best, run as a command at worst.
   */
  const livePane = async (lane: Lane, all?: Pane[]) => {
    if (!lane.cwd) return undefined;
    const claude = (all ?? (await panes())).filter(
      (p) => (p.path === lane.cwd || p.foregroundPath === lane.cwd) && p.agent === "claude",
    );
    return claude.find((p) => p.id === lane.paneId) ?? claude[0];
  };

  const booting = (lane: Lane) => !lane.registeredAt && Date.now() - lane.launchedAt < bootGraceMs;

  /** Type into the lane (held messages first), or hold the message while Claude is not listening yet. */
  async function deliver(key: string, text?: string): Promise<"sent" | "queued" | "gone"> {
    const lane = lanes.get(key)!;
    if (booting(lane)) {
      if (text) lanes.set({ ...lane, pending: [...(lane.pending ?? []), text] });
      return "queued";
    }
    const pane = await livePane(lane);
    // The caller relaunches with `text` in the new prompt; earlier held messages stay on the record.
    if (!pane) return "gone";
    for (const t of [...(lane.pending ?? []), ...(text ? [text] : [])]) {
      await inject(pane, t);
      // Dropped from the record only once typed: a failure keeps the rest for the next delivery.
      const now = lanes.get(key)!;
      if (now.pending?.[0] === t) lanes.set({ ...now, pending: now.pending.slice(1) });
    }
    return "sent";
  }

  async function flushPending(laneKey: string) {
    const held = lanes.get(laneKey)?.pending?.length ?? 0;
    if (!held) return 0;
    if ((await deliver(laneKey)) !== "sent") return 0;
    log(`linear: flushed ${held} held message(s) into lane ${laneKey}`);
    return held;
  }

  /** A lane that never registers must not swallow messages silently. */
  function watchBoot(key: string, launchedAt: number) {
    setTimeout(() => {
      const lane = lanes.get(key);
      if (!lane || lane.registeredAt || lane.launchedAt !== launchedAt) return;
      const held = lane.pending?.length ?? 0;
      log(`linear: lane ${key} never registered (${held} message(s) held)`);
      const body = `The lane \`${lane.name}\` never came up on the laptop (Claude did not start within ${Math.round(bootGraceMs / 60_000)} minutes).${held ? ` ${held} message(s) were not delivered.` : ""} Reply here to start it again.`;
      for (const id of lane.sessions) void postActivity(client, id, { type: "error", body }).catch((err) => log(`linear: boot failure report failed: ${err}`));
    }, bootGraceMs).unref();
  }

  const repoFor = (teamKey: string, projectName?: string) =>
    (projectName && linear.projectRepos[projectName]) || linear.teamRepos[teamKey];

  async function startLane(lane: Lane, prompt: string) {
    const all = await panes();
    const others = lanes.values().filter((l) => l.key !== lane.key);
    const running = (await Promise.all(others.map(async (l) => booting(l) || Boolean(await livePane(l, all))))).filter(Boolean).length;
    if (running >= linear.maxLanes) {
      throw new Error(`${running} lanes already running or starting (limit ${linear.maxLanes}) — close one or retry later`);
    }
    // Recorded before the launch so a second event for the same lane routes instead of launching again.
    const previous = lanes.get(lane.key);
    lanes.set(lane);
    try {
      const launched = await launch({ repo: lane.repo, branch: lane.branch, prompt });
      lanes.set({ ...lanes.get(lane.key)!, cwd: launched.cwd, paneId: launched.paneId });
      log(`linear: lane ${lane.key} launched in ${launched.cwd}`);
    } catch (err) {
      // A record left behind would hold every message for the boot grace instead of retrying.
      if (previous) lanes.set({ ...previous, sessions: lane.sessions, pending: lanes.get(lane.key)?.pending });
      else lanes.delete(lane.key);
      throw err;
    }
    watchBoot(lane.key, lane.launchedAt);
  }

  async function routeSession(sessionId: string, issueId: string, request: string, opts: { stop?: boolean } = {}) {
    const { issue } = await client.graphql<{ issue: IssueInfo }>(ISSUE_QUERY, { id: issueId });
    const key = issue.project ? `p-${issue.project.slugId}` : issue.identifier;
    const existing = lanes.get(key);
    const tag = `[linear session:${sessionId} issue:${issue.identifier}]`;
    // On every session, whenever it joins the lane — not only those known when the lane registers.
    void client
      .graphql(`mutation ($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }`, {
        id: sessionId,
        input: { addedExternalUrls: [openInOrcaLink(config.port, key)] },
      })
      .catch((err) => log(`linear: Open in Orca link failed for session ${sessionId}: ${err}`));

    if (existing) {
      lanes.set({ ...existing, sessions: [...new Set([...existing.sessions, sessionId])] });
      const outcome = await deliver(key, `${tag} ${untrusted(issue.title, 120)} — ${untrusted(request)}`);
      if (outcome !== "gone") {
        const body = outcome === "sent" ? `Sent to the running lane \`${existing.name}\`.` : `The lane \`${existing.name}\` is still starting — your message is held and will be delivered when it is up.`;
        await postActivity(client, sessionId, { type: "thought", body });
        return;
      }
    }
    if (opts.stop) {
      await postActivity(client, sessionId, { type: "response", body: "Nothing is running for this lane." });
      return;
    }
    await postActivity(client, sessionId, {
      type: "thought",
      body: existing ? "The previous session for this lane is gone — starting a fresh one." : "Received on the laptop — creating a worktree.",
    });

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
      pending: lanes.get(key)?.pending,
    };
    const scope = issue.project ? `project "${untrusted(issue.project.name, 80)}" (id ${issue.project.id})` : "single issue";
    await startLane(lane, `/linear-ta [lane:${key}] ${tag} ${scope} — ${untrusted(issue.title, 120)} — ${untrusted(request)}`);
  }

  /** One place for every failure (Orca unreachable, launch failed, lane limit): the user sees it on the thread. */
  async function reported<T>(sessionId: string, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      await postActivity(client, sessionId, { type: "error", body: `Couldn't handle this on the laptop: ${message(err)}. Reply to try again.` }).catch(() => {});
      throw err;
    }
  }

  async function onAgentSession(event: Record<string, unknown>) {
    const session = event.agentSession as { id?: string; issueId?: string; creatorId?: string | null } | undefined;
    const activity = event.agentActivity as { content?: { body?: string }; signal?: string | null; userId?: string | null } | undefined;
    if (!session?.id) return;
    const sessionId = session.id;
    const body = activity?.content?.body ?? "";
    if (event.action === "created" && ownSessions.delete(sessionId)) return;

    await reported(sessionId, async () => {
      const author = activity?.userId ?? session.creatorId;
      if (linear.allowedUserIds.length && !(author && linear.allowedUserIds.includes(author))) {
        log(`linear: session ${sessionId} from user ${author ?? "?"} refused (not in allowedUserIds)`);
        await postActivity(client, sessionId, { type: "error", body: "You are not allowed to start work on this laptop." });
        return;
      }
      if (event.action === "created") {
        if (!session.issueId) {
          await postActivity(client, sessionId, { type: "error", body: "I can only work from an issue for now." });
          return;
        }
        await routeSession(sessionId, session.issueId, body);
        return;
      }
      if (event.action !== "prompted") return;
      const stop = activity?.signal === "stop";
      const lane = lanes.bySession(sessionId);
      if (lane) {
        const text = stop ? "STOP requested by the user — stop what you are doing and say where things stand." : untrusted(body, 2000);
        const outcome = await deliver(lane.key, `[linear follow-up session:${sessionId}] ${text}`);
        if (outcome === "queued") {
          await postActivity(client, sessionId, { type: "thought", body: "The lane is still starting — your message is held and will be delivered when it is up." });
        }
        if (outcome !== "gone") return;
      }
      if (session.issueId) {
        await routeSession(sessionId, session.issueId, body, { stop });
        return;
      }
      await postActivity(client, sessionId, { type: "error", body: "The session for this thread is gone and I can't tell which issue it belongs to." });
    });
  }

  async function onIssueChange(event: Record<string, unknown>) {
    const data = event.data as { id: string; identifier?: string; state?: { name?: string } };
    const from = event.updatedFrom as { stateId?: string } | undefined;
    // Entering the status: moved into it, or created straight in it.
    const entered = event.action === "create" || Boolean(from?.stateId);
    if (!entered || data.state?.name !== linear.triggerStatus) return;
    const created = await client.graphql<{ agentSessionCreateOnIssue: { agentSession: { id: string } } }>(
      `mutation ($input: AgentSessionCreateOnIssue!) { agentSessionCreateOnIssue(input: $input) { agentSession { id } } }`,
      { input: { issueId: data.id } },
    );
    const sessionId = created.agentSessionCreateOnIssue.agentSession.id;
    ownSessions.add(sessionId);
    await reported(sessionId, () =>
      routeSession(sessionId, data.id, `Handle ${data.identifier ?? "this issue"} (moved to "${linear.triggerStatus}").`),
    );
  }

  async function onProjectChange(event: Record<string, unknown>) {
    const data = event.data as { id: string; name: string; slugId: string; teamIds?: string[]; status?: { type?: string } };
    const from = event.updatedFrom as { statusId?: string } | undefined;
    const entered = event.action === "create" || Boolean(from?.statusId);
    if (!entered || data.status?.type !== "started") return;
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
        pending: existing?.pending,
        launchedAt: Date.now(),
      },
      `/linear-ta [lane:${key}] project "${untrusted(data.name, 80)}" (id ${data.id}) was started — read its description and issues, then drive it.`,
    );
  }

  const handle: LinearEventHandler = async (event, eventType) => {
    // Signed, but for another workspace (the app installed elsewhere): not ours to act on.
    const org = event.organizationId;
    if (typeof org === "string" && org !== (await client.organizationId())) {
      log(`linear: event for another workspace (${org}) ignored`);
      return;
    }
    if (eventType === "AgentSessionEvent") {
      await serial(() => onAgentSession(event));
      return;
    }
    // The lane's own writes come back as events; only a human's change triggers work.
    const actor = event.actor as { id?: string; type?: string } | undefined;
    if (actor?.type !== "user") return;
    if (linear.allowedUserIds.length && !(actor.id && linear.allowedUserIds.includes(actor.id))) return;

    if (eventType === "Issue" && event.action !== "remove") await serial(() => onIssueChange(event));
    else if (eventType === "Project" && event.action !== "remove") await serial(() => onProjectChange(event));
  };

  return { handle, flushPending: (key) => serial(() => flushPending(key)) };
}
