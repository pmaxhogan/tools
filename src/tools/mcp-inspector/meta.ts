import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "mcp-inspector",
  matrixSlug: "mcp",
  icon: "Plug",
  name: "MCP Inspector",
  description:
    "Browse an MCP server's tools and schemas, read its responses, and build test calls.",
  category: "Dev",
  keywords: [
    "mcp inspector",
    "model context protocol",
    "mcp server tools",
    "mcp tools list",
    "mcp streamable http",
    "json-rpc mcp",
    "test mcp server",
  ],
  searchTerms: [
    "model context protocol debugger",
    "mcp client",
    "inspect mcp server",
    "mcp tools/list",
    "mcp tools/call",
    "sse json-rpc parser",
    "anthropic mcp",
    "mcp schema viewer",
    "claude mcp server test",
    "mcp inspector alternative",
    "test mcp tool calls",
    "mcp playground",
    "mcp session id header",
    "mcp handshake tester",
    "mcp server debugger online",
    "tools/list json viewer",
    "streamable http mcp test",
  ],
  input: "text/plain",
  output: "application/json",
  privacyNote:
    "Pasted responses are parsed entirely in your browser. The interactive client sends requests from your browser to the MCP server URL you enter, and only when you connect; an optional relay through this site's worker exists for servers without CORS headers.",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "parse",
      // Full sentence labels: keep the dropdown rather than a row of buttons.
      ui: "select",
      options: [
        {
          value: "parse",
          label: "Summarize a pasted response",
          synonyms: [
            "parse",
            "decode",
            "read response",
            "sse",
            "event stream",
            "json-rpc",
            "tools list",
          ],
        },
        {
          value: "requests",
          label: "Build curl commands for a server URL",
          synonyms: [
            "curl",
            "requests",
            "connect",
            "handshake",
            "initialize",
            "commands",
            "terminal",
          ],
        },
      ],
    },
    {
      kind: "text",
      id: "clientName",
      label: "Client name (curl mode)",
      default: "tools.maxhogan.dev MCP Inspector",
      placeholder: "My MCP client",
    },
  ],
  copy: {
    what: "Reads Model Context Protocol servers that speak the Streamable HTTP transport. Paste any response body, plain JSON or a text/event-stream payload, and it detects whether the message is an initialize result, a tools/list page, a tools/call result, or a JSON-RPC error, then lays it out as labeled rows: server name and version, advertised capabilities, and every tool with its required and optional parameters read out of the inputSchema. Switch to curl mode and give it a server URL to get the exact initialize, notifications/initialized, tools/list, and tools/call commands, headers included.",
    how: "Pick a mode. In the default mode, paste the body your server returned and read the summary rows. In curl mode, enter the endpoint URL, run the first command with -i, copy the Mcp-Session-Id header the server sends back, and paste it into the later commands. Every row has its own copy button, so a whole handshake is four clipboard hits.",
    why: "The official inspector is a local npm package you have to install and run before you can look at a single schema, and the online JSON-RPC viewers know nothing about MCP, so a tools/list page arrives as a wall of raw JSON. This page opens instantly, understands the message shapes, flattens JSON Schema into a readable parameter line, and parses SSE bodies that a plain JSON formatter rejects outright.",
    faq: [
      {
        q: "Does it support authenticated MCP servers?",
        a: "Not in this version. It connects to unauthenticated servers only, and the optional relay never forwards Authorization headers or any other credential. For a server behind OAuth or an API key, use curl mode and add the header yourself in your terminal.",
      },
      {
        q: "Why does my server need CORS headers, or the relay?",
        a: "The interactive client runs in your browser, so the browser enforces the same origin policy on every request it makes. Unless the server answers with Access-Control-Allow-Origin and allows the MCP headers, the browser blocks the response before this page can read it. That is why an optional relay through this site's worker exists for servers that cannot send those headers. Paste mode and curl mode never need it.",
      },
      {
        q: "Which protocol versions does it speak?",
        a: "It sends 2025-06-18 and understands servers that answer 2025-03-26 or 2024-11-05. A revision outside that set is still summarized, with the version flagged so you know the shapes may differ.",
      },
    ],
  },
};
