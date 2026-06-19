import { describe, expect, it, beforeEach, vi } from "vitest";
import { McpClient, McpError, parseRetryAfterHeader } from "../src/mcp-client";

describe("McpClient.registerAgentSession", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: McpClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "test-key",
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it("POSTs JSON-RPC tools/call with Bearer auth and returns session_id", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ session_id: "sess-123" }) },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await client.registerAgentSession({ clientId: "cloudflare-agent" });

    expect(result).toEqual({ sessionId: "sess-123" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.test/api/v1/mcp");
    expect((init as RequestInit).method).toBe("POST");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toContain("application/json");
    expect(headers.get("accept")).toContain("text/event-stream");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("register_agent_session");
    expect(body.params.arguments).toEqual({
      client_id: "cloudflare-agent",
      capabilities: {},
    });
  });
});

describe("McpClient.waitForAssignment", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: McpClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "test-key",
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it("returns dispatchId:null on a timeout response", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify({ dispatch_id: null }) }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await client.waitForAssignment({
      sessionId: "sess-123",
      timeoutSeconds: 25,
    });

    expect(result).toEqual({ dispatchId: null });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.params.name).toBe("wait_for_assignment");
    expect(body.params.arguments).toEqual({
      timeout_seconds: 25,
      agent_session_id: "sess-123",
    });
  });

  it("parses an SSE response with a final data event into the dispatch hit", async () => {
    const sse = [
      ": keepalive",
      "",
      "data: " +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  dispatch_id: "d-1",
                  work_item_id: "w-1",
                  payload: { title: "T", description: "D" },
                }),
              },
            ],
          },
        }),
      "",
      "",
    ].join("\n");
    fetchMock.mockResolvedValue(
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    const result = await client.waitForAssignment({
      sessionId: "sess-123",
      timeoutSeconds: 25,
    });

    expect(result).toEqual({
      dispatchId: "d-1",
      workItemId: "w-1",
      payload: { title: "T", description: "D" },
    });
  });
});

describe("McpClient.endAgentSession", () => {
  it("POSTs end_agent_session with session_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "test-key",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.endAgentSession({ sessionId: "sess-123" });

    expect(result).toEqual({ ok: true });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.params.name).toBe("end_agent_session");
    expect(body.params.arguments).toEqual({ session_id: "sess-123" });
  });
});

describe("McpClient error handling", () => {
  it("throws when the server returns non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("nope", { status: 401, headers: { "content-type": "text/plain" } }),
    );
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "bad",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.registerAgentSession({ clientId: "x" })).rejects.toThrow(/MCP 401/);
  });

  it("throws when JSON-RPC payload carries an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: "boom" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.registerAgentSession({ clientId: "x" })).rejects.toThrow(/boom/);
  });

  it("throws McpError on non-2xx carrying the HTTP status and the parsed Retry-After header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("server overloaded", {
        status: 503,
        headers: {
          "content-type": "text/plain",
          "Retry-After": "7",
        },
      }),
    );
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.registerAgentSession({ clientId: "x" })).rejects.toMatchObject({
      name: "McpError",
      status: 503,
      retryAfterMs: 7000,
    });
  });

  it("throws McpError on non-2xx with NO Retry-After header (retryAfterMs undefined)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("internal", { status: 500 }),
    );
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    try {
      await client.registerAgentSession({ clientId: "x" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).status).toBe(500);
      expect((err as McpError).retryAfterMs).toBeUndefined();
    }
  });

  it("throws McpError on a JSON-RPC error envelope carrying error.data.retry_after (seconds → ms)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32000,
            message: "db down",
            data: { retry_after: 12 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    try {
      await client.registerAgentSession({ clientId: "x" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).status).toBe(0); // application-level error
      expect((err as McpError).retryAfterMs).toBe(12000);
    }
  });
});

describe("parseRetryAfterHeader", () => {
  it("returns undefined for null/empty/whitespace input", () => {
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader("")).toBeUndefined();
    expect(parseRetryAfterHeader("   ")).toBeUndefined();
  });

  it("parses delta-seconds (a bare non-negative integer) as seconds → ms", () => {
    expect(parseRetryAfterHeader("0")).toBe(0);
    expect(parseRetryAfterHeader("7")).toBe(7_000);
    expect(parseRetryAfterHeader("3600")).toBe(3_600_000);
  });

  it("parses an HTTP-date as ms-until-that-date, clamped to >= 0", () => {
    const now = new Date("2026-05-30T20:00:00Z").getTime();
    const future = "Sat, 30 May 2026 20:00:30 GMT";
    expect(parseRetryAfterHeader(future, now)).toBe(30_000);
    const past = "Sat, 30 May 2026 19:59:00 GMT";
    expect(parseRetryAfterHeader(past, now)).toBe(0);
  });

  it("returns undefined for clearly-unparseable values (the safe default — caller falls through to computed backoff)", () => {
    expect(parseRetryAfterHeader("not-a-date")).toBeUndefined();
    expect(parseRetryAfterHeader("abc123")).toBeUndefined();
  });
});

describe("McpClient.claimAssignedTask", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: McpClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "test-key",
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it("POSTs JSON-RPC tools/call claim_assigned_task and returns workItemId on ok", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ ok: true, work_item_id: "wi-1" }) },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await client.claimAssignedTask({
      dispatchId: "d-1",
      sessionId: "s-1",
    });

    expect(result).toEqual({ ok: true, workItemId: "wi-1" });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.params.name).toBe("claim_assigned_task");
    expect(body.params.arguments).toEqual({
      dispatch_id: "d-1",
      agent_session_id: "s-1",
    });
  });

  it.each(["lost_race", "superseded"] as const)(
    "passes through ok:false with reason:%s",
    async (reason) => {
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [
                { type: "text", text: JSON.stringify({ ok: false, reason }) },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const result = await client.claimAssignedTask({
        dispatchId: "d-1",
        sessionId: "s-1",
      });

      expect(result).toEqual({ ok: false, reason });
    },
  );
});

describe("McpClient.reportArtifact", () => {
  it("POSTs JSON-RPC tools/call report_artifact with itemId+url+kind+title and returns ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  artifact_id: "art-1",
                  posted_at: "2026-05-17T11:00:00.000Z",
                }),
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.reportArtifact({
      itemId: "wi-1",
      url: "https://example.com/fake",
      kind: "pr",
      title: "hello",
    });

    expect(result).toEqual({
      artifactId: "art-1",
      postedAt: "2026-05-17T11:00:00.000Z",
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.params.name).toBe("report_artifact");
    expect(body.params.arguments).toEqual({
      itemId: "wi-1",
      url: "https://example.com/fake",
      kind: "pr",
      title: "hello",
    });
  });
});

describe("McpClient.moveItem", () => {
  it("POSTs JSON-RPC tools/call move_item and returns blessingRequested flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: null, blessingRequested: true }),
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.moveItem({
      itemId: "wi-1",
      fromState: "in_progress",
      toState: "done",
    });

    expect(result).toEqual({ error: null, blessingRequested: true });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.params.name).toBe("move_item");
    expect(body.params.arguments).toEqual({
      itemId: "wi-1",
      fromState: "in_progress",
      toState: "done",
    });
  });
});

describe("McpClient.postAgentComment", () => {
  it("POSTs JSON-RPC tools/call post_agent_comment with itemId+note and returns ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.postAgentComment({
      itemId: "wi-1",
      note: "rate-limited; retry tomorrow",
    });

    expect(result).toEqual({ ok: true });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.params.name).toBe("post_agent_comment");
    expect(body.params.arguments).toEqual({
      itemId: "wi-1",
      note: "rate-limited; retry tomorrow",
    });
  });
});

describe("McpClient transport-layer back-off (slice 1 carry-over)", () => {
  it("retries on network error (fetch throws) using the configured schedule", async () => {
    const attempts: number[] = [];
    const fetchMock = vi.fn().mockImplementation(() => {
      attempts.push(Date.now());
      if (attempts.length < 3) {
        return Promise.reject(new TypeError("fetch failed: ECONNREFUSED"));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [
                { type: "text", text: JSON.stringify({ session_id: "s-1" }) },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
      backoffSchedule: [0, 0, 0], // skip actual waits in tests
    });

    const result = await client.registerAgentSession({ clientId: "x" });

    expect(result).toEqual({ sessionId: "s-1" });
    expect(attempts).toHaveLength(3); // 2 network errors + 1 success
  });

  it("does NOT retry on HTTP non-2xx (slice 2 retry layer handles those)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("server error", {
        status: 503,
        headers: { "content-type": "text/plain" },
      }),
    );
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
      backoffSchedule: [0, 0, 0],
    });

    await expect(
      client.registerAgentSession({ clientId: "x" }),
    ).rejects.toThrow(/MCP 503/);
    expect(fetchMock).toHaveBeenCalledOnce(); // no transport-layer retry
  });

  it("schedule caps at the last entry across many consecutive failures", async () => {
    let count = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      count += 1;
      if (count <= 5) return Promise.reject(new TypeError("connection reset"));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [
                { type: "text", text: JSON.stringify({ session_id: "s-1" }) },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
      backoffSchedule: [0, 0], // 2-step schedule; 3rd+ failures reuse last (still 0 in tests)
    });

    const result = await client.registerAgentSession({ clientId: "x" });

    expect(result).toEqual({ sessionId: "s-1" });
    expect(count).toBe(6); // 5 failures + 1 success — the loop never gives up
  });
});

describe("McpClient.getItem", () => {
  it("POSTs JSON-RPC tools/call get_item and returns the work item with currentState", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  id: "wi-1",
                  title: "Hello",
                  currentState: "backlog",
                }),
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new McpClient({
      mcpUrl: "https://example.test/api/v1/mcp",
      apiKey: "k",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.getItem({ itemId: "wi-1" });

    expect(result.id).toBe("wi-1");
    expect(result.currentState).toBe("backlog");
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.params.name).toBe("get_item");
    expect(body.params.arguments).toEqual({ itemId: "wi-1" });
  });
});

describe("McpClient default-fetch binding (Workers regression)", () => {
  // Workers' built-in fetch throws `Illegal invocation` if `this` isn't globalThis; Node's fetch doesn't, so this guard catches what mocked tests can't.
  it("calls globalThis.fetch with `this` bound to globalThis when no fetch override is provided", async () => {
    const originalFetch = globalThis.fetch;
    let capturedThis: unknown = "<never-called>";
    globalThis.fetch = function (this: unknown) {
      capturedThis = this;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: JSON.stringify({ session_id: "s" }) }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    } as typeof fetch;

    try {
      const client = new McpClient({
        mcpUrl: "https://example.test/api/v1/mcp",
        apiKey: "k",
      });
      await client.registerAgentSession({ clientId: "x" });
      expect(capturedThis).toBe(globalThis);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
