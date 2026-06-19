import { fetchMock } from "cloudflare:test";

/**
 * Shared test helpers for queuing MCP responses against the mocked
 * fetch and recording what the agent code sent. Used by every test
 * that exercises agent-loop's MCP interactions.
 *
 * vitest.config.ts sets METRIQ_MCP_URL to https://example.test/api/v1/mcp;
 * these helpers intercept exactly that target. If the production URL
 * changes, update the MCP_HOST/MCP_PATH constants here in one place.
 */

const MCP_HOST = "https://example.test";
const MCP_PATH = "/api/v1/mcp";

export interface CapturedCall {
  body: string;
  headers: Record<string, string>;
}

export type McpResponse =
  | { kind: "ok"; payload: unknown }
  | { kind: "http"; statusCode: number; body: string };

/**
 * Wrap a JSON-RPC tool-call payload in Metriq's standard envelope for
 * `application/json` responses (the streamable-HTTP transport also
 * returns this shape outside of long-polled SSE).
 */
export function jsonReply(payload: unknown, id: number) {
  return {
    statusCode: 200,
    data: JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    }),
    responseOptions: { headers: { "content-type": "application/json" } },
  };
}

/**
 * Queue an ordered sequence of MCP responses (mix of successful
 * JSON-RPC payloads and raw HTTP errors). Each subsequent agent fetch
 * to the MCP endpoint consumes one response in queue order; the
 * `calls` array records the request that triggered each.
 */
export function queueResponses(
  calls: CapturedCall[],
  responses: McpResponse[],
): void {
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i]!;
    fetchMock
      .get(MCP_HOST)
      .intercept({ path: MCP_PATH, method: "POST" })
      .reply((opts) => {
        calls.push({
          body: String(opts.body),
          headers:
            opts.headers instanceof Headers
              ? Object.fromEntries(opts.headers.entries())
              : (opts.headers as Record<string, string>),
        });
        if (r.kind === "ok") return jsonReply(r.payload, i + 1);
        return {
          statusCode: r.statusCode,
          data: r.body,
          responseOptions: { headers: { "content-type": "text/plain" } },
        };
      });
  }
}

/**
 * Common case: every response is a successful JSON-RPC reply. Pass
 * the payloads directly without the {kind:"ok"} wrapper.
 */
export function queueOk(
  calls: CapturedCall[],
  payloads: unknown[],
): void {
  queueResponses(calls, asOk(payloads));
}

/**
 * Wrap raw payloads in the McpResponse `ok` discriminator. Use when
 * mixing successful replies (e.g. the standard pre-container fixture)
 * with HTTP-error responses inside one `queueResponses` call.
 */
export function asOk(payloads: unknown[]): McpResponse[] {
  return payloads.map((payload) => ({ kind: "ok", payload }));
}
