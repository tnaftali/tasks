import test from "node:test";
import assert from "node:assert/strict";
import { merge, normalize } from "./logic.js";
import { newCode, parseCode, derive, encrypt, decrypt, sync, API, limits, relay, captureUrl, pullInbox } from "./sync.js";
import { handle as relayHandle } from "./relay/main.js";
import worker from "./worker/index.js";

const T = (id, u, extra = {}) => ({ id, text: id, done: false, u, ...extra });
const S = (tasks, tomb = {}, ou = 0) => ({ tasks, tomb, ou });
const ids = (s) => s.tasks.map((t) => t.id).join("");

test("merge: newest edit wins per task, both new tasks survive", () => {
  const a = S([T("x", 5, { text: "new" }), T("a", 1)]);
  const b = S([T("x", 3, { text: "old" }), T("b", 2)]);
  const m = merge(a, b);
  assert.equal(m.tasks.find((t) => t.id === "x").text, "new");
  assert.deepEqual(ids(m).split("").sort(), ["a", "b", "x"]);
});

test("merge: delete beats an older edit, a newer edit beats the delete", () => {
  const gone = merge(S([T("x", 2)]), S([], { x: 5 }));
  assert.equal(gone.tasks.length, 0);
  const back = merge(S([T("x", 9)]), S([], { x: 5 }));
  assert.equal(back.tasks.length, 1);
});

test("merge: newer ou sets the order, unknown tasks go on top", () => {
  const a = S([T("1", 1), T("2", 1), T("3", 1)], {}, 10);
  const b = S([T("n", 1), T("3", 1), T("2", 1), T("1", 1)], {}, 5);
  assert.equal(ids(merge(a, b)), "n123");
  assert.equal(ids(merge(b, a)), "n123"); // same result from either side
});

test("normalize: drops malformed tasks and tombstones", () => {
  const s = normalize({ tasks: [{ id: "a", text: "ok" }, { id: 1, text: "x" }, null, { id: "b", text: " " }], tomb: { a: "x", b: 3 } });
  assert.equal(s.tasks.length, 1);
  assert.deepEqual(s.tomb, { b: 3 });
  assert.equal(s.ou, 0);
});

test("code: 22 chars, parses from a link, rejects junk", () => {
  const c = newCode();
  assert.equal(c.length, 22);
  assert.equal(parseCode(`https://x.github.io/braindump/#sync=${c}`), c);
  assert.equal(parseCode(" " + c + " "), c);
  assert.equal(parseCode("short"), null);
});

test("crypto: round trip, wrong key fails", async () => {
  const a = await derive(newCode()), b = await derive(newCode());
  const text = await encrypt(a.key, { hi: "there" });
  assert.deepEqual(await decrypt(a.key, text), { hi: "there" });
  await assert.rejects(decrypt(b.key, text));
});

// Two devices talk to the real Worker code through an in-memory KV.
function fakeWorker() {
  const kv = new Map();
  const env = {
    BLOBS: {
      async getWithMetadata(k) { const e = kv.get(k); return e ? { value: e.value, metadata: e.metadata } : { value: null, metadata: null }; },
      async get(k) { return kv.get(k)?.value ?? null; },
      async put(k, value, opts) { kv.set(k, { value, metadata: opts?.metadata }); },
    },
  };
  globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), env);
  return kv;
}

test("two devices converge through the Worker", async () => {
  const kv = fakeWorker();
  const code = newCode();
  let phone = S([T("p", 1)]);
  let laptop = S([T("l", 2)]);
  phone = await sync(code, phone);         // creates the blob
  laptop = await sync(code, laptop);       // merges
  phone = await sync(code, phone);         // sees the laptop task
  assert.deepEqual(ids(phone).split("").sort(), ["l", "p"]);
  assert.equal(ids(phone).length, 2);
  laptop = { ...laptop, tasks: [], tomb: { ...laptop.tomb, l: 9, p: 9 } }; // laptop deletes both
  laptop = await sync(code, laptop);
  phone = await sync(code, phone);
  assert.equal(phone.tasks.length, 0);
  assert.equal(kv.size, 1);
  for (const { value } of kv.values()) assert.ok(!value.includes("\"p\""), "stored blob is not plaintext");
});

test("Worker: bad path 404, stale If-Match 412, oversize 413", async () => {
  fakeWorker();
  const key = "a".repeat(64), w = { "X-Write-Key": "b".repeat(64) };
  assert.equal((await fetch(API + "nope")).status, 404);
  assert.equal((await fetch(API + key, { method: "PUT", headers: { ...w, "If-Match": '"0"' }, body: "x" })).status, 204);
  assert.equal((await fetch(API + key, { method: "PUT", headers: { ...w, "If-Match": '"0"' }, body: "y" })).status, 412);
  assert.equal((await fetch(API + key, { method: "PUT", headers: w, body: "z".repeat(300 * 1024) })).status, 413);
});

test("Worker: weak ETag (W/\"1\", as Cloudflare sends after compression) still matches", async () => {
  fakeWorker();
  const key = "d".repeat(64), w = { "X-Write-Key": "b".repeat(64) };
  await fetch(API + key, { method: "PUT", headers: { ...w, "If-Match": '"0"' }, body: "x" });
  assert.equal((await fetch(API + key, { method: "PUT", headers: { ...w, "If-Match": 'W/"1"' }, body: "y" })).status, 204);
});

test("Worker: writes need the write key the first PUT stored", async () => {
  fakeWorker();
  const key = "c".repeat(64);
  const put = (w) => fetch(API + key, { method: "PUT", headers: w ? { "X-Write-Key": w } : {}, body: "x" });
  assert.equal((await put(null)).status, 401);
  assert.equal((await put("d".repeat(64))).status, 204);
  assert.equal((await put("e".repeat(64))).status, 403); // someone who only knows the address
  assert.equal((await put("d".repeat(64))).status, 204);
  assert.equal((await fetch(API + key)).status, 200); // reads stay open to anyone with the address
});

test("sync: a stalled request times out instead of hanging", async () => {
  const real = globalThis.fetch, ms = limits.ms;
  globalThis.fetch = (_url, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
  limits.ms = 20;
  try {
    await assert.rejects(sync(newCode(), S([])), /timed out/);
  } finally { globalThis.fetch = real; limits.ms = ms; }
});

test("sync: Worker blocked, the relay carries the sync and is used for a while", async () => {
  const kv = fakeWorker(), toWorker = globalThis.fetch, R = "https://relay.example/api";
  const hits = { worker: 0, relay: 0 };
  globalThis.fetch = (url, init) => {
    if (url.startsWith(API)) { hits.worker++; return Promise.reject(new TypeError("Failed to fetch")); } // the ISP block
    hits.relay++;
    return relayHandle(new Request(url, init), toWorker, "/api"); // relay -> Worker
  };
  relay.url = R; relay.until = 0;
  try {
    const out = await sync(newCode(), S([T("a", 1)]));
    assert.equal(ids(out), "a");
    assert.equal(kv.size, 1); // the blob reached the Worker's KV
    assert.equal(hits.worker, 1); // tried once, then stuck to the relay
    assert.equal(hits.relay, 2); // GET + PUT
  } finally { globalThis.fetch = toWorker; relay.url = ""; relay.until = 0; }
});

test("sync: no relay set, a blocked Worker still fails the sync", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  try { await assert.rejects(sync(newCode(), S([])), /Failed to fetch/); } finally { globalThis.fetch = real; }
});

test("relay: passes tasks and capture with the Worker's answer; not titles or reminders", async () => {
  const seen = [];
  const up = async (u, i) => { seen.push(`${i.method} ${u}`); return new Response("ok", { status: 200, headers: { ETag: '"3"', "Access-Control-Allow-Origin": "*" } }); };
  const id = "a".repeat(64), r = (p, m = "GET") => relayHandle(new Request("https://relay.example/api" + p, { method: m, ...(m === "POST" ? { body: "x" } : {}) }), up, "/api");
  for (const p of [`/t/${id}`, `/p/${id}`, "/b/short", "/"]) assert.equal((await r(p)).status, 404);
  assert.equal((await r(`/b/${id}`, "DELETE")).status, 405);
  const ok = await r(`/b/${id}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("ETag"), '"3"');
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal((await r(`/i/${id}?k=abc&to=today`, "POST")).status, 200);
  assert.deepEqual(seen, [`GET https://task-capture.tobias-naftali-337.workers.dev/b/${id}`, `POST https://task-capture.tobias-naftali-337.workers.dev/i/${id}?k=abc&to=today`]);
});

test("capture: the Shortcut URL points at the relay, and a capture posted there reaches the app", async () => {
  fakeWorker();
  const toWorker = globalThis.fetch, R = "https://relay.example/api";
  globalThis.fetch = (url, init) => (url.startsWith(R) ? relayHandle(new Request(url, init), toWorker, "/api") : toWorker(url, init));
  relay.url = R; relay.until = 0;
  try {
    const code = newCode();
    await sync(code, S([])); // sync on: the write key is stored
    const url = await captureUrl(code);
    assert.ok(url.startsWith(R + "/i/"));
    assert.equal((await fetch(url, { method: "POST", body: "dentist friday 10am" })).status, 204);
    assert.deepEqual((await pullInbox(code)).map((i) => i.text), ["dentist friday 10am"]);
  } finally { globalThis.fetch = toWorker; relay.url = ""; relay.until = 0; }
});
