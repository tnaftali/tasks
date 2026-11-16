// Dumb encrypted-blob store. The client hashes its sync code to get the key and encrypts the
// body, so the server sees only opaque bytes. GET/PUT /b/<64 hex>. ETag = version counter.
import { sendPush } from "./push.js";

const ORIGINS = ["https://tnaftali.github.io", "http://localhost:8000", "http://localhost:8731"];
const MAX = 256 * 1024;
const PUSH_HOSTS = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/; // the Worker POSTs to a client-supplied URL, so only real push services
const LATE = 3600e3; // a reminder this far past due is not worth sending

// Reminders: `p:<id>` holds { subs: { endpoint: sub }, rem: [{ k, at, b }] }; `idx` maps id -> the earliest due time, so the cron job reads one key.
// `b` is the title, encrypted by the client: the server sees times only. shortcut: idx is read-modify-write, so two racing writers can lose an entry; the next upload restores it.
const getJSON = async (env, k) => JSON.parse((await env.BLOBS.get(k)) ?? "{}");
async function setNext(env, id, rem) {
  const idx = await getJSON(env, "idx");
  if (rem.length) idx[id] = Math.min(...rem.map((r) => r.at)); else delete idx[id];
  await env.BLOBS.put("idx", JSON.stringify(idx));
}

// Page titles: fetch like the link preview bot of a chat app (many sites, Instagram among them, serve Open Graph tags to it) and read og:title, twitter:title, then <title>.
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const unent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m));
const GENERIC = /^(instagram|tiktok|facebook|youtube)$|^(log ?in\b|sign ?in\b|just a moment|attention required|access denied|403|404|error)/i; // a login wall or error page, not a title
export function titleOf(html) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const prop = (n) => {
    for (const m of metas) {
      if (!new RegExp(`(?:property|name)\\s*=\\s*["']${n}["']`, "i").test(m)) continue;
      const c = m.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      if (c) return c[1] ?? c[2];
    }
  };
  const t = prop("og:title") ?? prop("twitter:title") ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const s = unent(t).replace(/\s+/g, " ").trim().slice(0, 200);
  return GENERIC.test(s) && s.length < 40 ? "" : s;
}
async function pageTitle(raw) {
  let u;
  try { u = new URL(raw); } catch { return ""; }
  const h = u.hostname;
  if (u.protocol !== "https:" || !h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || /(^|\.)(local|localhost|internal|lan)$/i.test(h)) return ""; // public names only
  try {
    const res = await fetch(u, { headers: { "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", Accept: "text/html" }, signal: AbortSignal.timeout(4000), redirect: "follow" });
    if (!res.ok || !/text\/html/i.test(res.headers.get("Content-Type") ?? "")) return "";
    const rd = res.body.getReader(), dec = new TextDecoder();
    let html = "";
    while (html.length < 128 * 1024) { const { done, value } = await rd.read(); if (done) break; html += dec.decode(value, { stream: true }); if (/<\/head>/i.test(html)) break; }
    rd.cancel().catch(() => {});
    return titleOf(html);
  } catch { return ""; }
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "If-Match, Content-Type, X-Write-Key",
      "Access-Control-Expose-Headers": "ETag",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Vary: "Origin",
    };
    const reply = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...cors, ...extra } });

    if (req.method === "OPTIONS") return reply(null, 204);
    const tm = new URL(req.url).pathname.match(/^\/t\/([0-9a-f]{64})$/);
    if (tm) { // GET /t/<id>?url=: the title of a page, for a link the app captured. Only a holder of the sync code may ask, so this is not an open proxy.
      const { metadata } = await env.BLOBS.getWithMetadata(tm[1]);
      if (!metadata?.w || metadata.w !== req.headers.get("X-Write-Key")) return reply("forbidden", 403);
      return reply(JSON.stringify({ title: await pageTitle(new URL(req.url).searchParams.get("url")) }), 200, { "Content-Type": "application/json" });
    }
    const pm = new URL(req.url).pathname.match(/^\/p\/([0-9a-f]{64})$/);
    if (pm) { // PUT /p/<id>: this device's push subscription and the reminders due, replacing the old list
      if (req.method !== "PUT") return reply("method not allowed", 405);
      const id = pm[1], { metadata } = await env.BLOBS.getWithMetadata(id);
      if (!metadata?.w || metadata.w !== req.headers.get("X-Write-Key")) return reply("forbidden", 403); // only someone who holds the sync code
      const text = await req.text();
      if (text.length > 64 * 1024) return reply("too large", 413);
      let j;
      try { j = JSON.parse(text); } catch { return reply("bad json", 400); }
      const { endpoint, keys } = j.sub ?? {};
      let host = "";
      try { const u = new URL(endpoint); host = u.protocol === "https:" ? u.hostname : ""; } catch {}
      if (!PUSH_HOSTS.test(host) || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") return reply("bad subscription", 400);
      const cur = await getJSON(env, "p:" + id), subs = cur.subs ?? {};
      if (j.off) delete subs[endpoint]; else subs[endpoint] = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
      const rem = j.off || !Array.isArray(j.rem) ? [] : j.rem.filter((r) => typeof r?.k === "string" && Number.isFinite(r.at) && typeof r.b === "string").slice(0, 100).map((r) => ({ k: r.k.slice(0, 64), at: r.at, b: r.b.slice(0, 2000) }));
      if (Object.keys(subs).length) await env.BLOBS.put("p:" + id, JSON.stringify({ subs, rem })); else await env.BLOBS.delete("p:" + id);
      await setNext(env, id, Object.keys(subs).length ? rem : []);
      return reply(null, 204);
    }
    const im = new URL(req.url).pathname.match(/^\/i\/([0-9a-f]{64})$/);
    if (im) { // Capture inbox: anyone with the capture key (?k=) can add; only the app, with the write key, can read, clear or set the key. Items are plain text until the app pulls them.
      const id = im[1], url = new URL(req.url), q = await getJSON(env, "q:" + id), items = q.items ?? [], open = { "Access-Control-Allow-Origin": "*" };
      if (req.method === "POST") {
        if (!q.ck || q.ck !== url.searchParams.get("k")) return reply("forbidden", 403, open);
        let text = (await req.text()).slice(0, 5000);
        if (text.startsWith("{")) try { const j = JSON.parse(text); text = String(j.text ?? j.url ?? text).slice(0, 5000); } catch {}
        text = text.trim();
        if (!text) return reply("empty", 400, open);
        if (items.length >= 100) return reply("inbox full", 429, open);
        await env.BLOBS.put("q:" + id, JSON.stringify({ ck: q.ck, items: [...items, { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), text }] })); // shortcut: read-modify-write, two captures in the same instant can lose one
        return reply(null, 204, open);
      }
      const { metadata } = await env.BLOBS.getWithMetadata(id);
      if (!metadata?.w || metadata.w !== req.headers.get("X-Write-Key")) return reply("forbidden", 403);
      if (req.method === "GET") return reply(JSON.stringify(items), 200, { "Content-Type": "application/json" });
      if (req.method === "PUT") {
        const ck = await req.text();
        if (!/^[0-9a-f]{64}$/.test(ck)) return reply("bad key", 400);
        await env.BLOBS.put("q:" + id, JSON.stringify({ ck, items }));
        return reply(null, 204);
      }
      if (req.method === "DELETE") { // drop the first n items: the ones the app just took
        await env.BLOBS.put("q:" + id, JSON.stringify({ ck: q.ck, items: items.slice(Math.max(0, +url.searchParams.get("n") || 0)) }));
        return reply(null, 204);
      }
      return reply("method not allowed", 405);
    }
    const m = new URL(req.url).pathname.match(/^\/b\/([0-9a-f]{64})$/);
    if (!m) return reply("not found", 404);
    const key = m[1];

    if (req.method === "GET") {
      const { value, metadata } = await env.BLOBS.getWithMetadata(key);
      if (value === null) return reply("not found", 404);
      return reply(value, 200, { ETag: `"${metadata?.v ?? 0}"`, "Content-Type": "text/plain" });
    }

    if (req.method === "PUT") {
      // The address (key) is not enough to write: the first PUT stores a hash-derived write key, later PUTs must repeat it.
      const w = req.headers.get("X-Write-Key") ?? "";
      if (!/^[0-9a-f]{64}$/.test(w)) return reply("write key required", 401);
      if (Number(req.headers.get("Content-Length")) > MAX) return reply("too large", 413);
      const body = await req.text();
      if (body.length > MAX) return reply("too large", 413);
      const { metadata } = await env.BLOBS.getWithMetadata(key);
      if (metadata?.w && metadata.w !== w) return reply("forbidden", 403);
      const cur = metadata?.v ?? 0;
      const want = req.headers.get("If-Match"); // shortcut: KV has no atomic CAS, so a race can slip through; the client merges on the next sync
      // Cloudflare turns the ETag weak (W/"1") when it compresses the body, so accept both forms.
      if (want !== null && want.replace(/^W\//, "") !== `"${cur}"`) return reply("conflict", 412, { ETag: `"${cur}"` });
      await env.BLOBS.put(key, body, { metadata: { v: cur + 1, w } });
      return reply(null, 204, { ETag: `"${cur + 1}"` });
    }

    return reply("method not allowed", 405);
  },

  // Cron, every minute: send the reminders that came due.
  async scheduled(_event, env) {
    if (!env.VAPID_JWK) return console.warn("VAPID_JWK is not set; no reminders sent");
    const jwk = JSON.parse(env.VAPID_JWK), now = Date.now(), idx = await getJSON(env, "idx");
    for (const id of Object.keys(idx).filter((i) => idx[i] <= now)) {
      const rec = await getJSON(env, "p:" + id), subs = rec.subs ?? {}, rem = rec.rem ?? [];
      for (const r of rem.filter((x) => x.at <= now && now - x.at < LATE)) {
        for (const [ep, sub] of Object.entries(subs)) {
          const status = await sendPush(sub, JSON.stringify({ k: r.k, b: r.b }), jwk).catch(() => 0);
          if (status === 404 || status === 410) delete subs[ep]; // the device unsubscribed
        }
      }
      const rest = rem.filter((r) => r.at > now);
      if (Object.keys(subs).length) await env.BLOBS.put("p:" + id, JSON.stringify({ subs, rem: rest })); else await env.BLOBS.delete("p:" + id);
      await setNext(env, id, Object.keys(subs).length ? rest : []);
    }
  },
};
