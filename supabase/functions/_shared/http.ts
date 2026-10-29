import { env } from "./env.ts";

/** CORS for browser calls. Set ALLOWED_ORIGINS to your site (comma separated) in production. */
export function cors(req: Request): Record<string, string> {
  const allowed = env.allowedOrigins().split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") ?? "";
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

export class UserError extends Error {}

export type Handler = (body: Record<string, unknown>, req: Request) => Promise<unknown>;

/** Routes {action, ...payload} POST bodies to handlers. Returns {ok,data} or {ok:false,error}. */
export function serveActions(actions: Record<string, Handler>) {
  Deno.serve(async (req) => {
    const h = cors(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers: h });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...h, "Content-Type": "application/json" } });
    if (req.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request." }, 400); }
    const fn = actions[String(body.action ?? "")];
    if (!fn) return json({ ok: false, error: "Unknown action." }, 400);
    try { return json({ ok: true, data: (await fn(body, req)) ?? null }); }
    catch (e) {
      if (e instanceof UserError) return json({ ok: false, error: e.message });
      console.error(body.action, e);
      return json({ ok: false, error: "Something went wrong on our side. Try again in a moment." });
    }
  });
}
