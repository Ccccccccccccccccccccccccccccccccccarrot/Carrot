import { createHmac, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
import { convertV4MiniflareOptions, Miniflare, Response } from "miniflare";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const repo = "/repos/Ccccccccccccccccccccccccccccccccccarrot/Carrot";

export function createHarness({ pagesUrl = "https://carrot.test/Carrot/", port } = {}) {
  const files = new Map();
  const controls = { failAfterWrite: false, branchExists: true, conflicts: 0, conflictResponses: 0 };
  const passwords = { baba: randomBytes(16).toString("base64url"), family: randomBytes(16).toString("base64url") };
  const pepper = randomBytes(32);
  const accounts = Object.fromEntries(Object.entries(passwords).map(([name, password]) => [
    name, createHmac("sha256", pepper).update(`${name}\0${password}`).digest("base64url"),
  ]));
  let revision = 0;
  const head = () => revision.toString(16).padStart(40, "0");
  const snapshots = new Map([[head(), new Map()]]);

  async function mockGitHub(request) {
    const url = new URL(request.url);
    assert.equal(url.origin, "https://api.github.com");
    const token = request.headers.get("Authorization")?.slice(7);
    if (url.pathname === "/app/installations/202/access_tokens" && request.method === "POST") {
      const [header, claims, signature] = token.split(".");
      assert.equal(JSON.parse(Buffer.from(claims, "base64url")).iss, "101");
      assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")));
      assert.deepEqual(await request.json(), { repositories: ["Carrot"], permissions: { contents: "write" } });
      return Response.json({ token: "test-installation-token", expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    assert.equal(token, "test-installation-token");
    if (url.pathname === `${repo}/git/ref/heads/records`) {
      return controls.branchExists ? Response.json({ object: { sha: head() } }) : new Response(null, { status: 404 });
    }
    if (url.pathname === "/graphql") {
      assert.equal(request.method, "POST");
      const { query, variables: { input } } = await request.json();
      assert.match(query, /createCommitOnBranch/);
      assert.deepEqual(input.branch, { repositoryNameWithOwner: repo.slice("/repos/".length), branchName: "records" });
      assert.equal(input.message.headline, "Update encrypted records");
      if (input.expectedHeadOid !== head() || controls.conflicts > 0) {
        if (controls.conflicts > 0) controls.conflicts -= 1;
        controls.conflictResponses += 1;
        return Response.json({ errors: [{ type: "STALE_DATA" }] });
      }
      assert.equal(input.fileChanges.additions.length, 2);
      revision += 1;
      for (const { path, contents } of input.fileChanges.additions) {
        assert.match(path, /^bp\/20\d\d-\d\d\.enc\.json$/);
        files.set(`${repo}/contents/${path}`, { sha: String(revision), content: contents });
      }
      snapshots.set(head(), new Map(files));
      if (controls.failAfterWrite) {
        controls.failAfterWrite = false;
        return new Response(null, { status: 504 });
      }
      return Response.json({ data: { createCommitOnBranch: { commit: { oid: head() } } } });
    }
    assert.ok(url.pathname.startsWith(`${repo}/contents/bp/`));
    if (request.method === "GET") {
      const ref = url.searchParams.get("ref");
      const snapshot = ref === "records" ? files : snapshots.get(ref);
      assert.ok(snapshot);
      const file = snapshot.get(url.pathname);
      return file ? Response.json({ ...file, encoding: "base64" }) : new Response(null, { status: 404 });
    }
    assert.equal(request.method, "PUT");
    const body = await request.json();
    assert.equal(body.branch, "records");
    assert.equal(body.message, "Update encrypted records");
    if (controls.conflicts > 0) {
      controls.conflicts -= 1;
      controls.conflictResponses += 1;
      return new Response(null, { status: 409 });
    }
    const latest = files.get(url.pathname);
    if (body.sha !== latest?.sha) {
      controls.conflictResponses += 1;
      return new Response(null, { status: body.sha ? 409 : 422 });
    }
    files.set(url.pathname, { sha: String(++revision), content: body.content });
    snapshots.set(head(), new Map(files));
    if (controls.failAfterWrite) {
      controls.failAfterWrite = false;
      return new Response(null, { status: 504 });
    }
    return new Response(null, { status: latest ? 200 : 201 });
  }

  const options = {
    rootPath,
    modulesRoot: rootPath,
    modules: ["index", "auth", "security", "records"].map((name) => ({
      type: "ESModule", path: join(rootPath, "worker", `${name}.js`),
    })),
    compatibilityDate: "2025-11-01",
    port,
    bindings: {
      PAGES_URL: pagesUrl,
      PASSWORD_PEPPER: pepper.toString("base64url"),
      FAMILY_ACCOUNTS: JSON.stringify(accounts),
      RECORDS_KEY: randomBytes(32).toString("base64url"),
      GITHUB_APP_ID: "101",
      GITHUB_INSTALLATION_ID: "202",
      GITHUB_APP_KEY_PKCS8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    },
    durableObjects: { AUTH: { className: "FamilyAuth", useSQLite: true } },
    outboundService: mockGitHub,
  };
  const worker = new Miniflare(convertV4MiniflareOptions(options));
  async function revoke(user) {
    delete accounts[user];
    await worker.setOptions(convertV4MiniflareOptions({
      ...options, bindings: { ...options.bindings, FAMILY_ACCOUNTS: JSON.stringify(accounts) },
    }));
  }
  return { worker, passwords, files, controls, revoke };
}
