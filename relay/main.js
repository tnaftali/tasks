// Backup route for task sync, hosted off Cloudflare (Deno Deploy). On football match days Spanish ISPs block
// Cloudflare IPs, so the app can't reach the Worker; it retries here and this server forwards to the Worker.
// Only /b/ (the encrypted task blob) passes: the relay sees an address, a write key and ciphertext, never readable data.
const UPSTREAM = "https://task-capture.tobias-naftali-337.workers.dev";
const ORIGINS = ["https://tnaftali.github.io", "http://localhost:8000", "http://localhost:8731"];
const MAX = 300 * 1024; // the Worker enforces 256 KB; this only stops junk early

export async function handle(req, upstream = fetch) {
  const origin = req.headers.get("Origin");
  const cors = {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "If-Match, Content-Type, X-Write-Key",
    "Access-Control-Expose-Headers": "ETag",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  const reply = (body, status) => new Response(body, { status, headers: cors });
  if (req.method === "OPTIONS") return reply(null, 204);
  const path = new URL(req.url).pathname;
  if (!/^\/b\/[0-9a-f]{64}$/.test(path)) return reply("not found", 404);
  if (req.method !== "GET" && req.method !== "PUT") return reply("method not allowed", 405);

  const headers = new Headers();
  for (const h of ["If-Match", "X-Write-Key", "Content-Type"]) if (req.headers.has(h)) headers.set(h, req.headers.get(h));
  let body;
  if (req.method === "PUT") {
    body = await req.text();
    if (body.length > MAX) return reply("too large", 413);
  }
  let res;
  try {
    res = await upstream(UPSTREAM + path, { method: req.method, headers, body, signal: AbortSignal.timeout(10000) });
  } catch {
    return reply("upstream unreachable", 502);
  }
  const out = new Headers(cors);
  if (res.headers.has("ETag")) out.set("ETag", res.headers.get("ETag"));
  if (res.headers.has("Content-Type")) out.set("Content-Type", res.headers.get("Content-Type"));
  const text = await res.text();
  return new Response(res.status === 204 || res.status === 304 ? null : text, { status: res.status, headers: out }); // these must have no body
}

if (globalThis.Deno) Deno.serve((req) => handle(req));
