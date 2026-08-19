import { describe, expect, it } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  buildHeaders,
  buildInitialize,
  buildInitializedNotification,
  buildPing,
  buildToolCall,
  buildToolsList,
  isSseBody,
  parseTransportResponse,
  renderParams,
  run,
  summarizeInitialize,
  summarizeToolResult,
  summarizeTools,
} from "./index";
import { ToolError } from "../types";

const TOOLS_RESULT = {
  tools: [
    {
      name: "get_weather",
      description: "Get the current weather for a city.\nUses a public forecast API.",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
          units: { type: "string", enum: ["metric", "imperial"] },
          coords: {
            type: "object",
            properties: { lat: { type: "number" }, lon: { type: "number" } },
          },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["city"],
      },
    },
    {
      name: "list_alerts",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  nextCursor: "page2",
};

describe("mcp-inspector builders", () => {
  it("builds an exact initialize request", () => {
    expect(buildInitialize("My Client")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "My Client", version: "1.0.0" },
      },
    });
  });

  it("accepts an older protocol version and a custom id", () => {
    const msg = buildInitialize("c", "2024-11-05", 42);
    expect(msg.id).toBe(42);
    expect(msg.params?.protocolVersion).toBe("2024-11-05");
  });

  it("builds the initialized notification with no id at all", () => {
    const msg = buildInitializedNotification();
    expect(msg).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect("id" in msg).toBe(false);
  });

  it("builds tools/list with and without a cursor", () => {
    expect(buildToolsList()).toEqual({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(buildToolsList("abc")).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { cursor: "abc" },
    });
  });

  it("builds tools/call with an `arguments` params key", () => {
    expect(buildToolCall("get_weather", { city: "Paris" })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_weather", arguments: { city: "Paris" } },
    });
  });

  it("rejects a tool call with no name", () => {
    expect(() => buildToolCall("  ", {})).toThrowError(ToolError);
  });

  it("builds ping", () => {
    expect(buildPing()).toEqual({ jsonrpc: "2.0", id: 4, method: "ping" });
  });

  it("builds the transport headers, with the session id only when given", () => {
    expect(buildHeaders()).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    });
    expect(buildHeaders("s-1")["Mcp-Session-Id"]).toBe("s-1");
  });
});

describe("parseTransportResponse", () => {
  it("parses a plain JSON body", () => {
    const messages = parseTransportResponse('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
    expect(messages).toHaveLength(1);
    expect(messages[0].result).toEqual({ tools: [] });
  });

  it("parses a JSON batch", () => {
    const messages = parseTransportResponse(
      '[{"jsonrpc":"2.0","id":1,"result":{}},{"jsonrpc":"2.0","id":2,"result":{}}]',
    );
    expect(messages).toHaveLength(2);
  });

  it("parses an SSE body with two events", () => {
    const body = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}',
      "",
      ": keep alive comment",
      "event: message",
      "id: 7",
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}',
      "",
    ].join("\n");
    const messages = parseTransportResponse(body);
    expect(messages).toHaveLength(2);
    expect(messages[0].result).toEqual({ protocolVersion: "2025-06-18" });
    expect(messages[1].method).toBe("notifications/message");
    expect(isSseBody(body)).toBe(true);
  });

  it("throws bad-response on junk", () => {
    expect(() => parseTransportResponse("not json at all")).toThrowError(ToolError);
    try {
      parseTransportResponse("<html>oops</html>");
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-response");
    }
  });

  it("throws bad-response on an SSE body with no data lines", () => {
    expect(() => parseTransportResponse("event: message\n\nevent: ping\n")).toThrowError(
      /no data lines/,
    );
  });

  it("throws bad-response on a bad SSE data line and on a bare scalar", () => {
    expect(() => parseTransportResponse("event: message\ndata: {oops}\n")).toThrowError(ToolError);
    expect(() => parseTransportResponse("42")).toThrowError(ToolError);
  });
});

describe("summaries", () => {
  it("summarizes an initialize result", () => {
    const rows = summarizeInitialize({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "weather", version: "1.4.0" },
      capabilities: { tools: { listChanged: true }, logging: {} },
      instructions: "Ask about the weather.",
    });
    expect(rows["Server name"]).toBe("weather");
    expect(rows["Server version"]).toBe("1.4.0");
    expect(rows["Protocol version"]).toBe("2025-06-18");
    expect(rows.Capabilities).toBe("tools (listChanged), logging");
    expect(rows.Instructions).toBe("Ask about the weather.");
  });

  it("flags a protocol version it does not know", () => {
    expect(summarizeInitialize({ protocolVersion: "1999-01-01" })["Protocol version"]).toContain(
      "not a revision",
    );
  });

  it("renders required and optional params compactly", () => {
    expect(renderParams(TOOLS_RESULT.tools[0].inputSchema)).toBe(
      "city: string (required), units: 'metric'|'imperial', coords: object{lat: number, lon: number}, tags: string[]",
    );
    expect(renderParams({ type: "object", properties: {} })).toBe("none");
  });

  it("summarizes a tools/list result", () => {
    const rows = summarizeTools(TOOLS_RESULT);
    expect(rows["Tool count"]).toBe("2");
    expect(rows["Next cursor"]).toBe("page2");
    expect(rows.get_weather).toContain("Get the current weather for a city. Uses a public");
    expect(rows.get_weather).toContain("city: string (required)");
    expect(rows.list_alerts).toContain("No description.");
    expect(rows.list_alerts).toContain("Params: none");
  });

  it("summarizes an empty tools list", () => {
    expect(summarizeTools({ tools: [] }).Tools).toContain("no tools");
  });

  it("summarizes a tool result with text, an error flag, and structured content", () => {
    const rows = summarizeToolResult({
      content: [
        { type: "text", text: "18C and clear" },
        { type: "text", text: "wind 6 km/h" },
        { type: "image", data: "..." },
      ],
      isError: true,
      structuredContent: { tempC: 18 },
    });
    expect(rows.Text).toBe("18C and clear\n\nwind 6 km/h");
    expect(rows["Is error"]).toBe("yes");
    expect(rows["Content blocks"]).toBe("2 text, 1 image");
    expect(rows["Structured content"]).toContain('"tempC": 18');
  });
});

describe("run parse mode", () => {
  it("auto-detects an initialize result", () => {
    const rows = run(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-03-26", serverInfo: { name: "srv", version: "0.1" } },
      }),
      {},
    );
    expect(rows["Message type"]).toBe("initialize result");
    expect(rows["Server name"]).toBe("srv");
    expect(rows["Request id"]).toBe("1");
  });

  it("auto-detects a tools/list result inside an SSE body", () => {
    const rows = run(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: TOOLS_RESULT })}\n`,
      {
        mode: "parse",
      },
    );
    expect(rows["Message type"]).toBe("tools/list result");
    expect(rows.get_weather).toContain("units: 'metric'|'imperial'");
  });

  it("auto-detects a tool result and a JSON-RPC error", () => {
    const call = run(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: "ok" }] },
      }),
      {},
    );
    expect(call["Message type"]).toBe("tools/call result");
    expect(call.Text).toBe("ok");

    const err = run(
      JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Unknown tool" } }),
      {},
    );
    expect(err["Message type"]).toBe("error response");
    expect(err["Error code"]).toBe("-32602");
    expect(err["Error message"]).toBe("Unknown tool");
  });

  it("prefixes rows when the body holds several messages", () => {
    const body = [
      'data: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"a","version":"1"}}}',
      'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}',
    ].join("\n");
    const rows = run(body, { mode: "parse" });
    expect(rows["Messages in body"]).toBe("2");
    expect(rows["1. Server name"]).toBe("a");
    expect(rows["2. Method"]).toBe("notifications/tools/list_changed");
  });

  it("throws bad-response on junk and empty-input on nothing", () => {
    expect(() => run("nope", {})).toThrowError(ToolError);
    try {
      run("nope", { mode: "parse" });
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-response");
    }
    try {
      run("   ", { mode: "parse" });
    } catch (err) {
      expect((err as ToolError).code).toBe("empty-input");
    }
  });
});

describe("run requests mode", () => {
  it("builds a full curl sequence", () => {
    const rows = run("https://example.com/mcp", { mode: "requests", clientName: "Inspector" });
    expect(rows.Endpoint).toBe("https://example.com/mcp");
    expect(rows["1. Initialize"]).toContain("curl -i -X POST 'https://example.com/mcp'");
    expect(rows["1. Initialize"]).toContain("-H 'Accept: application/json, text/event-stream'");
    expect(rows["1. Initialize"]).toContain(`-H 'MCP-Protocol-Version: ${MCP_PROTOCOL_VERSION}'`);
    expect(rows["1. Initialize"]).toContain('"method":"initialize"');
    expect(rows["1. Initialize"]).toContain('"name":"Inspector"');
    expect(rows["1. Initialize"]).not.toContain("Mcp-Session-Id");
    expect(rows["2. Initialized notification"]).toContain("-H 'Mcp-Session-Id: <session-id>'");
    expect(rows["2. Initialized notification"]).toContain('"notifications/initialized"');
    expect(rows["3. List tools"]).toContain('"method":"tools/list"');
    expect(rows["4. Call a tool"]).toContain('"arguments"');
    expect(rows.Ping).toContain('"method":"ping"');
    for (const value of Object.values(rows)) expect(value.includes("\n")).toBe(false);
  });

  it("throws bad-url on junk and on a non-http scheme", () => {
    try {
      run("not a url", { mode: "requests" });
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-url");
    }
    try {
      run("ws://example.com/mcp", { mode: "requests" });
    } catch (err) {
      expect((err as ToolError).code).toBe("bad-url");
    }
    expect(() => run("", { mode: "requests" })).toThrowError(/server URL/);
  });
});
