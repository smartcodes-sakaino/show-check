import type { Env } from "./types";
export { RoomMonitor } from "./roomMonitor";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(env.ADMIN_TOKEN) && timingSafeEqual(token, env.ADMIN_TOKEN);
}

function getMonitorStub(env: Env) {
  const id = env.ROOM_MONITOR.idFromName("singleton");
  return env.ROOM_MONITOR.get(id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (!isAuthorized(request, env)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      const stub = getMonitorStub(env);
      const doPath = url.pathname.replace(/^\/api/, "") || "/status";
      const doUrl = new URL(doPath, "https://internal.do");
      const doRequest = new Request(doUrl.toString(), {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        body: request.method === "POST" ? await request.text() : undefined,
      });
      return stub.fetch(doRequest);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
