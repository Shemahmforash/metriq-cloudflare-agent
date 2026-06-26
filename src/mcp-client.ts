import type {
  ClaimResponse,
  EndSessionResponse,
  MoveItemResponse,
  RegisterSessionResponse,
  ReportArtifactResponse,
  WaitResponse,
  WorkItemSummary,
} from "./types";

export interface McpClientOptions {
  mcpUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /**
   * Delays (ms) between consecutive transport-error retries. After the last
   * entry the loop stays at that delay (caps). Production schedule:
   * [5000, 30000, 300000] (5s → 30s → 5min). Tests override with [0, ...].
   */
  backoffSchedule?: number[];
}

const DEFAULT_BACKOFF_MS = [5000, 30000, 300000];

// Tail of HTTP error bodies kept in thrown error messages.
const ERROR_TAIL_CHARS = 200;

interface JsonRpcResult {
  jsonrpc: "2.0";
  id: number | string;
  result?: { content: Array<{ type: string; text: string }> };
  error?: {
    code: number;
    message: string;
    /**
     * Optional server-supplied retry hint inside the JSON-RPC error body
     * (preferred when there is no HTTP `Retry-After` header). Value is in
     * SECONDS, mirroring the HTTP convention. Per the upstream Metriq
     * documented agent runtime.
     */
    data?: { retry_after?: number; [k: string]: unknown };
  };
}

/**
 * Carries the structured failure context for an MCP call so the DO-side
 * `attemptWithBackoff` wrapper can derive a Retry-After-aware backoff without
 * re-parsing strings. Two failure modes normalize to this single shape:
 *   - HTTP non-2xx ⇒ `status` is the HTTP status; `retryAfterMs` is the parsed
 *     `Retry-After` header (if present).
 *   - JSON-RPC error envelope ⇒ `status` is 0 (transport-level success but
 *     application-level failure); `retryAfterMs` is the parsed
 *     `error.data.retry_after` field (if present, seconds → ms).
 *
 * Header precedence over JSON-RPC field is enforced at the call site (the HTTP
 * branch never reaches the JSON-RPC parser).
 */
export class McpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "McpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse a `Retry-After` header value into milliseconds. Per RFC 7231:
 *   - delta-seconds (a non-negative integer) ⇒ `value * 1000`,
 *   - HTTP-date ⇒ `ms-until-that-date` (clamped to >= 0).
 * Returns `undefined` for anything unparseable / negative so the caller falls
 * through to the computed exponential backoff (the safe default).
 */
export function parseRetryAfterHeader(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    return undefined;
  }
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) return Math.max(0, ts - now);
  return undefined;
}

export class McpClient {
  private readonly mcpUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly backoffSchedule: number[];
  private nextId = 1;

  constructor(opts: McpClientOptions) {
    this.mcpUrl = opts.mcpUrl;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.backoffSchedule = opts.backoffSchedule ?? DEFAULT_BACKOFF_MS;
  }

  async registerAgentSession(args: {
    clientId: string;
    capabilities?: Record<string, unknown>;
  }): Promise<{ sessionId: string }> {
    const payload = await this.callTool<RegisterSessionResponse>(
      "register_agent_session",
      {
        client_id: args.clientId,
        capabilities: args.capabilities ?? {},
      },
    );
    return { sessionId: payload.session_id };
  }

  async waitForAssignment(args: {
    sessionId: string;
    timeoutSeconds: number;
  }): Promise<{
    dispatchId: string | null;
    workItemId?: string;
    payload?: { title?: string; description?: string; model?: string };
  }> {
    const r = await this.callTool<WaitResponse>("wait_for_assignment", {
      timeout_seconds: args.timeoutSeconds,
      agent_session_id: args.sessionId,
    });
    return {
      dispatchId: r.dispatch_id,
      workItemId: r.work_item_id,
      payload: r.payload,
    };
  }

  async claimAssignedTask(args: {
    dispatchId: string;
    sessionId: string;
  }): Promise<
    | { ok: true; workItemId: string }
    | { ok: false; reason: "superseded" | "lost_race" }
  > {
    const r = await this.callTool<ClaimResponse>("claim_assigned_task", {
      dispatch_id: args.dispatchId,
      agent_session_id: args.sessionId,
    });
    if (r.ok) return { ok: true, workItemId: r.work_item_id };
    return { ok: false, reason: r.reason };
  }

  async reportArtifact(args: {
    itemId: string;
    url: string;
    kind: string;
    title?: string;
  }): Promise<{ artifactId: string; postedAt: string }> {
    const r = await this.callTool<ReportArtifactResponse>("report_artifact", {
      itemId: args.itemId,
      url: args.url,
      kind: args.kind,
      ...(args.title !== undefined ? { title: args.title } : {}),
    });
    return { artifactId: r.artifact_id, postedAt: r.posted_at };
  }

  async moveItem(args: {
    itemId: string;
    fromState: "backlog" | "ready" | "in_progress" | "done";
    toState: "backlog" | "ready" | "in_progress" | "done";
  }): Promise<MoveItemResponse> {
    return this.callTool<MoveItemResponse>("move_item", {
      itemId: args.itemId,
      fromState: args.fromState,
      toState: args.toState,
    });
  }

  async getItem(args: { itemId: string }): Promise<WorkItemSummary> {
    return this.callTool<WorkItemSummary>("get_item", { itemId: args.itemId });
  }

  async postAgentComment(args: {
    itemId: string;
    note: string;
  }): Promise<{ ok: boolean }> {
    return this.callTool<{ ok: boolean }>("post_agent_comment", {
      itemId: args.itemId,
      note: args.note,
    });
  }

  async endAgentSession(args: {
    sessionId: string;
  }): Promise<{ ok: boolean }> {
    return this.callTool<EndSessionResponse>("end_agent_session", {
      session_id: args.sessionId,
    });
  }

  private async callTool<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const res = await this.fetchWithBackoff({
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.apiKey}`,
      },
      body,
    });
    return parseToolResult<T>(res);
  }

  /**
   * Retry on TRANSPORT errors only — fetch throwing (DNS, refused, TLS, reset).
   * HTTP status codes (5xx, 401, etc.) flow through unchanged so the
   * application-layer retry (or the caller) decides what to do with them.
   */
  private async fetchWithBackoff(init: RequestInit): Promise<Response> {
    let attempt = 0;
    while (true) {
      try {
        return await this.fetchImpl(this.mcpUrl, init);
      } catch (err) {
        const delayMs =
          this.backoffSchedule[
            Math.min(attempt, this.backoffSchedule.length - 1)
          ] ?? 0;
        console.warn(
          `MCP transport unreachable (attempt ${attempt + 1}), backing off ${delayMs}ms: ${err instanceof Error ? err.message : err}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        attempt += 1;
      }
    }
  }
}

async function parseToolResult<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // HTTP non-2xx: surface the status + Retry-After header so the
    // application-level backoff wrapper (attemptWithBackoff in agent-loop.ts)
    // can honor the server's hint. Header precedence over JSON-RPC field is
    // ENFORCED here — once we throw on the HTTP branch we never parse the
    // body's JSON-RPC envelope.
    const errBody = await res.text().catch(() => "");
    const retryAfterMs = parseRetryAfterHeader(res.headers.get("Retry-After"));
    throw new McpError(
      `MCP ${res.status}: ${errBody.slice(0, ERROR_TAIL_CHARS)}`,
      res.status,
      retryAfterMs,
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  let rpc: JsonRpcResult;
  if (contentType.includes("text/event-stream")) {
    rpc = await readJsonRpcFromSse(res);
  } else {
    rpc = (await res.json()) as JsonRpcResult;
  }
  if (rpc.error) {
    // JSON-RPC error envelope: transport succeeded but the application failed.
    // status=0 distinguishes this from an HTTP error; retryAfterMs comes from
    // the JSON-RPC `error.data.retry_after` field (SECONDS → ms).
    const seconds = rpc.error.data?.retry_after;
    const retryAfterMs =
      typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1000
        : undefined;
    throw new McpError(
      `MCP RPC error: ${rpc.error.message}`,
      0,
      retryAfterMs,
    );
  }
  const text = rpc.result?.content?.find((c) => c.type === "text")?.text;
  if (!text) throw new McpError("MCP response missing text content", 0);
  return JSON.parse(text) as T;
}

async function readJsonRpcFromSse(res: Response): Promise<JsonRpcResult> {
  if (!res.body) throw new Error("MCP SSE response missing body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastData = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const e of events) {
      for (const line of e.split("\n")) {
        if (line.startsWith("data:")) lastData = line.slice(5).trim();
      }
    }
  }
  if (!lastData) throw new Error("MCP SSE stream closed without data");
  return JSON.parse(lastData) as JsonRpcResult;
}
