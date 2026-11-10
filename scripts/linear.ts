#!/usr/bin/env bun
// Call one of the bridge's Linear tools from a shell — for sessions that don't
// have the bridge's MCP server connected. Goes through the running bridge, so
// the script never touches the Linear token.
//
//   bun scripts/linear.ts linear_issue_create '{"team":"RBD","title":"…","labels":["papercut"]}'
//   bun scripts/linear.ts linear_graphql '{"query":"{ viewer { name } }"}'
//   bun scripts/linear.ts            # list the tools
const url = process.env.BRIDGE_MCP_URL ?? "http://127.0.0.1:8365/mcp";
const [tool, json = "{}"] = process.argv.slice(2);

async function rpc(method: string, params: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).catch(() => {
    throw new Error(`bridge not reachable at ${url} — is it running?`);
  });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? text;
  const body = JSON.parse(data);
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

try {
  if (!tool) {
    const { tools } = await rpc("tools/list", {});
    for (const t of tools.filter((t: { name: string }) => t.name.startsWith("linear_"))) {
      console.log(`${t.name}\n  ${t.description}\n  args: ${Object.keys(t.inputSchema.properties ?? {}).join(", ")}\n`);
    }
  } else {
    const result = await rpc("tools/call", { name: tool, arguments: JSON.parse(json) });
    const out = result.content?.map((c: { text: string }) => c.text).join("\n") ?? "";
    (result.isError ? console.error : console.log)(out);
    if (result.isError) process.exit(1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
