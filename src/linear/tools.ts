import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { postActivity } from "./handler";
import type { LinearClient } from "./client";
import { openInOrcaLink, type LaneIndex } from "./lanes";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (err: unknown) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
});

/**
 * The lane's only door to the personal Linear workspace: the job never holds
 * the token, and every write is made as the app (so the bridge can tell its
 * own writes from the user's).
 */
export function registerLinearTools(
  server: McpServer,
  client: LinearClient,
  lanes: LaneIndex,
  port: number,
  onRegistered: (laneKey: string) => Promise<number>,
  triggerStatus: string,
) {
  server.registerTool(
    "linear_register",
    {
      description:
        "Register where this lane's Claude session lives so Linear follow-ups are routed into it and the 'Open in Orca' link works. Call once at boot, before anything else.",
      inputSchema: {
        lane: z.string().describe("The lane token from your prompt ([lane:…])"),
        cwd: z.string().describe("Absolute path of your worktree"),
        paneId: z.string().optional().describe("$ORCA_TERMINAL_HANDLE"),
        branch: z.string().optional(),
      },
    },
    async ({ lane, cwd, paneId, branch }) => {
      try {
        const record = lanes.get(lane);
        if (!record) throw new Error(`unknown lane ${lane}`);
        // The launcher's worktree path and terminal win: a caller can confirm a lane is up, not move it elsewhere.
        lanes.set({ ...record, cwd: record.cwd ?? cwd, paneId: record.paneId ?? paneId, branch: branch ?? record.branch, registeredAt: Date.now() });
        // After this tool returns, so the held messages land once Claude is back at its prompt.
        setTimeout(() => void onRegistered(lane).catch(() => {}), 3000).unref();
        // Sessions get their link when they join the lane (handler); the project gets it once, here.
        const link = openInOrcaLink(port, lane);
        const notes: string[] = [];
        if (record.projectId) {
          try {
            const { project } = await client.graphql<{ project: { externalLinks: { nodes: { url: string }[] } } }>(
              `query ($id: String!) { project(id: $id) { externalLinks { nodes { url } } } }`,
              { id: record.projectId },
            );
            if (!project.externalLinks.nodes.some((l) => l.url === link.url)) {
              await client.graphql(`mutation ($input: EntityExternalLinkCreateInput!) { entityExternalLinkCreate(input: $input) { success } }`, {
                input: { projectId: record.projectId, ...link },
              });
            }
          } catch (err) {
            notes.push(`project link failed: ${err instanceof Error ? err.message : err}`);
          }
        }
        return ok(`registered lane ${lane} (${record.kind}: ${record.name}). ${notes.join("; ")}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "linear_activity",
    {
      description:
        "Post to a Linear agent session thread. thought = progress note; action = a step (action + parameter, result when done); elicitation = ask the user a question and wait for their reply; response = final answer for this request; error = failure. Always end each request with a response or an error.",
      inputSchema: {
        session: z.string().describe("Agent session id from the message you are answering ([linear session:…])"),
        type: z.enum(["thought", "action", "elicitation", "response", "error"]),
        body: z.string().optional().describe("Markdown. Required for every type except action"),
        action: z.string().optional().describe('For type=action, e.g. "Running tests"'),
        parameter: z.string().optional().describe("For type=action, what it applies to"),
        result: z.string().optional().describe("For type=action, the outcome once finished"),
      },
    },
    async ({ session, type, body, action, parameter, result }) => {
      try {
        const content = type === "action" ? { type, action: action ?? "Working", parameter: parameter ?? "", result } : { type, body: body ?? "" };
        await postActivity(client, session, content);
        return ok(`${type} posted`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "linear_plan",
    {
      description: "Replace the checklist shown on a Linear agent session. Send the full list every time.",
      inputSchema: {
        session: z.string(),
        items: z.array(z.object({ content: z.string(), status: z.enum(["pending", "inProgress", "completed", "canceled"]) })),
      },
    },
    async ({ session, items }) => {
      try {
        await client.graphql(
          `mutation ($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }`,
          { id: session, input: { plan: items } },
        );
        return ok("plan updated");
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "linear_graphql",
    {
      description:
        "Run a GraphQL query or mutation against the personal Linear workspace as the Laptop app: read the project and its issues, create and move issues (issueCreate / issueUpdate), comment (commentCreate), post project status updates (projectUpdateCreate with health onTrack|atRisk|offTrack).",
      inputSchema: {
        query: z.string(),
        variables: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ query, variables }) => {
      try {
        return ok(JSON.stringify(await client.graphql(query, variables ?? {})));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const resolveTeam = async (key: string) => {
    const { teams } = await client.graphql<{ teams: { nodes: { id: string; key: string; states: { nodes: { id: string; name: string }[] } }[] } }>(
      `{ teams { nodes { id key states { nodes { id name } } } } }`,
    );
    const team = teams.nodes.find((t) => t.key.toLowerCase() === key.toLowerCase());
    if (!team) throw new Error(`unknown team ${key} (have: ${teams.nodes.map((t) => t.key).join(", ")})`);
    return team;
  };
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  server.registerTool(
    "linear_issue_search",
    {
      description: "Find issues by text in title or description — check for a duplicate before filing one.",
      inputSchema: { query: z.string(), team: z.string().optional().describe('Team key, e.g. "RBD"') },
    },
    async ({ query, team }) => {
      try {
        const text = { or: [{ title: { containsIgnoreCase: query } }, { description: { containsIgnoreCase: query } }] };
        const filter = team ? { and: [text, { team: { key: { eq: team.toUpperCase() } } }] } : text;
        const { issues } = await client.graphql<{ issues: { nodes: unknown[] } }>(
          `query ($filter: IssueFilter) { issues(filter: $filter, first: 15) { nodes { identifier title url state { name } project { name } } } }`,
          { filter },
        );
        return ok(JSON.stringify(issues.nodes));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "linear_issue_create",
    {
      description:
        "File an issue (follow-up, bug, papercut, decision…). Labels, project and state are given by name. Returns the identifier and URL.",
      inputSchema: {
        team: z.string().describe('Team key, e.g. "RBD"'),
        title: z.string(),
        description: z.string().optional().describe("Markdown"),
        labels: z.array(z.string()).optional().describe('Label names, e.g. ["papercut", "area:ci"]'),
        project: z.string().optional().describe("Project name"),
        state: z.string().optional().describe("Status name; defaults to the team's default"),
        priority: z.number().int().min(0).max(4).optional().describe("0 none, 1 urgent, 2 high, 3 medium, 4 low"),
      },
    },
    async ({ team, title, description, labels, project, state, priority }) => {
      try {
        if (state && same(state, triggerStatus)) throw new Error(`"${triggerStatus}" is the user's trigger — pick another status`);
        const t = await resolveTeam(team);
        const input: Record<string, unknown> = { teamId: t.id, title, description, priority };
        if (state) {
          const s = t.states.nodes.find((x) => same(x.name, state));
          if (!s) throw new Error(`unknown status "${state}" (have: ${t.states.nodes.map((x) => x.name).join(", ")})`);
          input.stateId = s.id;
        }
        if (labels?.length) {
          const { issueLabels } = await client.graphql<{ issueLabels: { nodes: { id: string; name: string }[] } }>(
            `{ issueLabels(first: 250) { nodes { id name } } }`,
          );
          input.labelIds = labels.map((name) => {
            const l = issueLabels.nodes.find((x) => same(x.name, name));
            if (!l) throw new Error(`unknown label "${name}" (have: ${issueLabels.nodes.map((x) => x.name).join(", ")})`);
            return l.id;
          });
        }
        if (project) {
          const { projects } = await client.graphql<{ projects: { nodes: { id: string; name: string }[] } }>(
            `{ projects(first: 250) { nodes { id name } } }`,
          );
          const p = projects.nodes.find((x) => same(x.name, project));
          if (!p) throw new Error(`unknown project "${project}"`);
          input.projectId = p.id;
        }
        const { issueCreate } = await client.graphql<{ issueCreate: { issue: { identifier: string; url: string } } }>(
          `mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { issue { identifier url } } }`,
          { input },
        );
        return ok(`${issueCreate.issue.identifier} ${issueCreate.issue.url}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "linear_adopt",
    {
      description:
        "Attach an EXISTING worktree and its Claude session to a Linear project, so the project's issues, mentions and follow-ups are routed to this session instead of a new worktree. For lanes that were not started from Linear.",
      inputSchema: {
        project: z.string().describe("Linear project name or id"),
        cwd: z.string().describe("Absolute path of the worktree"),
        paneId: z.string().optional().describe("$ORCA_TERMINAL_HANDLE of the Claude terminal"),
        branch: z.string().optional(),
      },
    },
    async ({ project, cwd, paneId, branch }) => {
      try {
        const { projects } = await client.graphql<{ projects: { nodes: { id: string; name: string; slugId: string; url: string }[] } }>(
          `{ projects(first: 250) { nodes { id name slugId url } } }`,
        );
        const p = projects.nodes.find((x) => x.id === project || same(x.name, project));
        if (!p) throw new Error(`unknown project "${project}"`);
        const key = `p-${p.slugId}`;
        const previous = lanes.get(key);
        lanes.set({
          key,
          kind: "project",
          name: p.name,
          url: p.url,
          projectId: p.id,
          repo: previous?.repo ?? cwd,
          branch: branch ?? previous?.branch ?? "",
          cwd,
          paneId,
          sessions: previous?.sessions ?? [],
          pending: previous?.pending,
          launchedAt: previous?.launchedAt ?? Date.now(),
          registeredAt: Date.now(),
        });
        const link = openInOrcaLink(port, key);
        const { project: full } = await client.graphql<{ project: { externalLinks: { nodes: { url: string }[] } } }>(
          `query ($id: String!) { project(id: $id) { externalLinks { nodes { url } } } }`,
          { id: p.id },
        );
        if (!full.externalLinks.nodes.some((l) => l.url === link.url)) {
          await client.graphql(`mutation ($input: EntityExternalLinkCreateInput!) { entityExternalLinkCreate(input: $input) { success } }`, {
            input: { projectId: p.id, ...link },
          });
        }
        setTimeout(() => void onRegistered(key).catch(() => {}), 3000).unref();
        return ok(`adopted: project "${p.name}" → lane ${key} in ${cwd}. Messages on its issues now reach this session.`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
