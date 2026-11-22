// Backup route, hosted off Cloudflare (Vercel). Spanish ISPs block Cloudflare IPs during football (LaLiga), so phones in Spain
// can't reach the Worker; this server is outside Spain and forwards to it.
// Passes /b/ (the encrypted task blob) and /i/ (Quick Capture inbox). Not titles or reminders: those catch up after a block.
// It sees what the Worker sees: addresses, keys, encrypted tasks, and captured text (plain until the app pulls it).
const UPSTREAM = "https://task-capture.tobias-naftali-337.workers.dev";
const MAX = 300 * 1024; // the Worker enforces its own limits; this only stops junk early
const PASS = ["Access-Control-Allow-Origin", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers", "Access-Control-Expose-Headers", "Cache-Control", "Vary", "ETag", "Content-Type"];

// `prefix` is the part of the path the host adds (Vercel: "/api").
export async function handle(req, upstream = fetch, prefix = "") {
  const url = new URL(req.url), path = url.pathname.slice(prefix.length);
  const m = path.match(/^\/(b|i)\/[0-9a-f]{64}$/);
  const allowed = { b: ["GET", "PUT", "OPTIONS"], i: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] };
  if (!m) return new Response("not found", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
  if (!allowed[m[1]].includes(req.method)) return new Response("method not allowed", { status: 405, headers: { "Access-Control-Allow-Origin": "*" } });

  const headers = new Headers();
  for (const h of ["If-Match", "X-Write-Key", "Content-Type", "Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"]) if (req.headers.has(h)) headers.set(h, req.headers.get(h));
  let body;
  if (req.method === "PUT" || req.method === "POST") {
    body = await req.text();
    if (body.length > MAX) return new Response("too large", { status: 413, headers: { "Access-Control-Allow-Origin": "*" } });
  }
  let res;
  try {
    res = await upstream(UPSTREAM + path + url.search, { method: req.method, headers, body, signal: AbortSignal.timeout(10000) });
  } catch {
    return new Response("upstream unreachable", { status: 502, headers: { "Access-Control-Allow-Origin": "*" } });
  }
  const out = new Headers(); // the Worker's own CORS answer, so the relay behaves exactly like it
  for (const h of PASS) if (res.headers.has(h)) out.set(h, res.headers.get(h));
  const text = await res.text();
  return new Response(res.status === 204 || res.status === 304 ? null : text, { status: res.status, headers: out }); // these must have no body
}
