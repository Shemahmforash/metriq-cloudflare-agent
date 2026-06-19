import { MetriqAgentLoop, type Env } from "./agent-loop";
import { AgentContainer } from "./agent-container";

export { MetriqAgentLoop, AgentContainer };

const PROTECTED = new Set(["/wake", "/stop", "/pause", "/resume", "/debug"]);

/** Constant-time string compare — avoids leaking the token via response timing. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isAuthorized(req: Request, env: Env): boolean {
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const presented = header.slice(prefix.length);
  // Fail closed: an unset CONTROL_TOKEN must never authorize anyone.
  if (!env.CONTROL_TOKEN) return false;
  return tokensMatch(presented, env.CONTROL_TOKEN);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return new Response("ok", { status: 200 });
    }

    if (PROTECTED.has(url.pathname) && !isAuthorized(req, env)) {
      return new Response("unauthorized", { status: 401 });
    }

    if (
      url.pathname === "/wake" ||
      url.pathname === "/stop" ||
      url.pathname === "/pause" ||
      url.pathname === "/resume"
    ) {
      const id = env.AGENT_LOOP.idFromName("singleton");
      const stub = env.AGENT_LOOP.get(id);
      return stub.fetch(`http://do${url.pathname}`, { method: "POST" });
    }

    if (url.pathname === "/debug" && req.method === "GET") {
      const id = env.AGENT_LOOP.idFromName("singleton");
      const stub = env.AGENT_LOOP.get(id);
      return stub.fetch(`http://do/debug`, { method: "GET" });
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
