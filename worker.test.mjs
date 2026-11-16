import test from "node:test";
import assert from "node:assert/strict";
import { titleOf } from "./worker/index.js";

test("titleOf: og:title first, either attribute order, entities decoded", () => {
  assert.equal(titleOf('<head><title>Plain</title><meta content="Tom &amp; Jerry&#39;s" property="og:title"></head>'), "Tom & Jerry's");
  assert.equal(titleOf("<title>\n Just  a title </title>"), "Just a title");
  assert.equal(titleOf('<meta name="twitter:title" content="Tw">'), "Tw");
});
test("titleOf: login walls give nothing", () => {
  assert.equal(titleOf("<title>Instagram</title>"), "");
  assert.equal(titleOf("<title>Login • Instagram</title>"), "");
  assert.equal(titleOf("<title>Log in to see this</title>"), "");
  assert.equal(titleOf("<html></html>"), "");
});
