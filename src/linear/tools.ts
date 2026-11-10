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
        lanes.set({ ...record, cwd, paneId: paneId ?? record.paneId, branch: branch ?? record.branch, registeredAt: Date.now() });
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
}
