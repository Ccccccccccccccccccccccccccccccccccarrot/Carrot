import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createHarness } from "../test-support/harness.mjs";

const pagesOrigin = "https://carrot.test";
const workerOrigin = "https://worker.test";

function setup(t) {
  const harness = createHarness();
  t.after(() => harness.worker.dispose());
  const send = (path, options) => harness.worker.dispatchFetch(`${workerOrigin}${path}`, options);
  const api = (path, { token, data, method, origin = pagesOrigin } = {}) => send(path, {
    method: method ?? (data ? "POST" : "GET"),
    headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const exchange = (code, verifier) => api("/auth/exchange", { data: { code, verifier } });

  async function enter(user, password = harness.passwords[user]) {
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const response = await send("/login", {
      method: "POST", redirect: "manual",
      headers: { Origin: workerOrigin, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: user, password, state, challenge }).toString(),
    });
    const location = response.headers.get("Location");
    if (!location) return { response };
    const redirect = new URL(location);
    assert.equal(redirect.origin, pagesOrigin);
    assert.equal(redirect.pathname, "/Carrot/");
    assert.equal(redirect.searchParams.get("state"), state);
    return { response, code: redirect.searchParams.get("code"), verifier };
  }

  async function login(user) {
    const { response, code, verifier } = await enter(user);
    assert.equal(response.status, 303);
    const redeemed = await exchange(code, verifier);
    assert.equal(redeemed.status, 200);
    return (await redeemed.json()).session;
  }
  return { ...harness, api, enter, exchange, login };
}

function record(overrides = {}) {
  return { id: randomUUID(), measuredAt: "2026-11-30T16:12:00.000Z", systolic: 137, diastolic: 84, pulse: null, ...overrides };
}

test("allowlist, CORS, one-time code binding, logout and unauthenticated requests", async (t) => {
  const { api, enter, exchange } = setup(t);
  assert.equal((await api("/api/records")).status, 401);
  assert.equal((await api("/api/records", { data: record() })).status, 401);
  assert.equal((await api("/api/records", { origin: "https://outside.test" })).status, 403);
  assert.equal((await enter("outside", randomBytes(16).toString("base64url"))).response.status, 401);
  assert.equal((await enter("baba", randomBytes(16).toString("base64url"))).response.status, 401);

  const { code, verifier } = await enter("baba");
  assert.equal((await exchange(code, randomBytes(32).toString("base64url"))).status, 401);
  const response = await exchange(code, verifier);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  const { session } = await response.json();
  assert.equal((await exchange(code, verifier)).status, 401);
  assert.equal((await api("/auth/logout", { method: "POST", token: session })).status, 200);
  assert.equal((await api("/api/records", { token: session })).status, 401);
});

test("login attempts are limited", async (t) => {
  const { enter } = setup(t);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await enter("unknown", "wrong")).response.status, 401);
  }
  assert.equal((await enter("baba")).response.status, 429);
});

test("two family sessions see the same encrypted record in the Beijing month", async (t) => {
  const { api, login, files, revoke, controls } = setup(t);
  const writer = await login("baba");
  const reader = await login("family");
  const data = record({ person: "father" });
  assert.equal((await api("/api/records", { token: writer, data })).status, 201);
  assert.equal((await api("/api/records", { token: writer, data })).status, 200);
  assert.equal((await api("/api/records", { token: writer, data: { ...data, person: "mother" } })).status, 409);
  const response = await api("/api/records?month=2026-12", { token: reader });
  assert.deepEqual(await response.json(), { records: [data] });
  assert.deepEqual(await (await api("/api/records?month=2026-11", { token: reader })).json(), { records: [] });
  const [[path, file]] = files;
  assert.ok(path.endsWith("2026-12.enc.json"));
  const envelope = JSON.parse(Buffer.from(file.content, "base64"));
  assert.deepEqual(Object.keys(envelope).sort(), ["ciphertext", "nonce", "v"]);
  assert.ok(!JSON.stringify(envelope).includes(data.id));
  assert.equal((await api("/api/records", { token: writer, data: record({ systolic: 0 }) })).status, 400);
  assert.equal((await api("/api/records", { token: writer, data: record({ person: "other" }) })).status, 400);
  assert.equal((await api("/api/records?month=2026-13", { token: writer })).status, 400);

  await revoke("family");
  assert.equal((await api("/api/records", { token: reader })).status, 401);
  assert.equal((await api("/api/records", { token: reader, data: record() })).status, 401);
  assert.equal((await api("/api/records?month=2026-12", { token: writer })).status, 200);
  controls.branchExists = false;
  assert.equal((await api("/api/records?month=2026-11", { token: writer })).status, 503);
});

test("lost save acknowledgement, duplicate submission and concurrent writes do not lose records", async (t) => {
  const { api, login, controls } = setup(t);
  const writer = await login("baba");
  const second = await login("family");
  const first = record();
  controls.failAfterWrite = true;
  assert.equal((await api("/api/records", { token: writer, data: first })).status, 503);
  assert.equal((await api("/api/records", { token: writer, data: first })).status, 200);
  assert.equal((await api("/api/records", { token: writer, data: { ...first, pulse: 72 } })).status, 409);

  const left = record({ measuredAt: "2026-12-01T00:12:00.000Z" });
  const right = record({ measuredAt: "2026-12-01T01:12:00.000Z", pulse: 68, person: "mother" });
  controls.conflicts = 1;
  const results = await Promise.all([
    api("/api/records", { token: writer, data: left }),
    api("/api/records", { token: second, data: right }),
  ]);
  assert.deepEqual(results.map((response) => response.status), [201, 201]);
  assert.ok(controls.conflictResponses >= 1);
  const history = await (await api("/api/records?month=2026-12", { token: second })).json();
  assert.deepEqual(history.records, [right, left, first]);
});

test("edits and deletes are authorized, guarded against stale data, and safe to retry", async (t) => {
  const { api, login, controls } = setup(t);
  const writer = await login("family");
  const original = record();
  const corrected = { ...original, systolic: 128, person: "father" };
  const edit = (from, to, token = writer) => api("/api/records", {
    method: "PATCH", token, data: { original: from, record: to },
  });
  const remove = (from, token = writer) => api("/api/records", {
    method: "DELETE", token, data: { original: from },
  });
  assert.equal((await edit(original, corrected, null)).status, 401);
  assert.equal((await remove(original, null)).status, 401);
  assert.equal((await api("/api/records", { token: writer, data: original })).status, 201);
  assert.equal((await edit(original, { ...corrected, id: randomUUID() })).status, 400);
  controls.failAfterWrite = true;
  assert.equal((await edit(original, corrected)).status, 503);
  assert.equal((await edit(original, corrected)).status, 200);
  assert.equal((await remove(original)).status, 409);
  assert.equal((await edit(original, { ...corrected, pulse: 72 })).status, 409);
  assert.deepEqual((await (await api("/api/records?month=2026-12", { token: writer })).json()).records, [corrected]);
  controls.failAfterWrite = true;
  assert.equal((await remove(corrected)).status, 503);
  assert.equal((await remove(corrected)).status, 200);
  assert.equal((await api("/api/records", { token: writer, data: original })).status, 409);
  assert.deepEqual((await (await api("/api/records?month=2026-12", { token: writer })).json()).records, []);
});

test("changing the Beijing month updates both files together and keeps the record ID", async (t) => {
  const { api, login, controls } = setup(t);
  const token = await login("family");
  const original = record({ person: "father" });
  const moved = { ...original, measuredAt: "2026-11-30T15:59:00.000Z" };
  const edit = (from, to) => api("/api/records", { method: "PATCH", token, data: { original: from, record: to } });
  const history = async (month) => (await (await api(`/api/records?month=${month}`, { token })).json()).records;
  const existing = record({ measuredAt: "2026-11-26T00:00:00.000Z", person: "mother" });
  for (const data of [original, existing]) assert.equal((await api("/api/records", { token, data })).status, 201);
  controls.conflicts = 1;
  controls.failAfterWrite = true;
  assert.equal((await edit(original, moved)).status, 503);
  assert.equal(controls.conflictResponses, 1);
  assert.equal((await edit(original, moved)).status, 200);
  assert.equal((await api("/api/records", { token, data: original })).status, 409);
  assert.deepEqual(await history("2026-12"), []);
  assert.deepEqual(await history("2026-11"), [moved, existing]);
  assert.equal((await edit(moved, original)).status, 200);
  assert.deepEqual(await history("2026-12"), [original]);
  assert.deepEqual(await history("2026-11"), [existing]);
});
