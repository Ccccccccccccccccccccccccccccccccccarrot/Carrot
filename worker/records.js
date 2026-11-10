import { base64, base64url, decryptRecords, encryptRecords, unbase64, unbase64url } from "./security.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const github = "https://api.github.com";
const repo = "/repos/Ccccccccccccccccccccccccccccccccccarrot/Carrot";
const branch = "records";
const apiVersion = "2026-03-10";
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timestampPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const beijingMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" });

let installation;

export const monthPattern = /^20\d\d-(0[1-9]|1[0-2])$/;

export function monthOf(date) {
  const parts = beijingMonth.formatToParts(date);
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}`;
}

export function normalizeRecord(value) {
  if (!value || typeof value.id !== "string" || !idPattern.test(value.id) ||
      typeof value.measuredAt !== "string" || !timestampPattern.test(value.measuredAt)) return null;
  const date = new Date(value.measuredAt);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value.measuredAt ||
      !monthPattern.test(monthOf(date))) return null;
  const isReading = (number) => Number.isInteger(number) && number >= 1 && number <= 999;
  if (!isReading(value.systolic) || !isReading(value.diastolic) ||
      (value.pulse != null && !isReading(value.pulse))) return null;
  return {
    id: value.id, measuredAt: value.measuredAt, systolic: value.systolic,
    diastolic: value.diastolic, pulse: value.pulse ?? null,
  };
}

function requestGitHub(path, token, options = {}) {
  return fetch(`${github}${path}`, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "User-Agent": "Carrot-Blood-Pressure",
      "X-GitHub-Api-Version": apiVersion,
    },
  });
}

async function createInstallationToken(env) {
  const key = await crypto.subtle.importKey(
    "pkcs8", unbase64(env.GITHUB_APP_KEY_PKCS8),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const encodeJson = (value) => base64url(encoder.encode(JSON.stringify(value)));
  const jwt = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
    iss: env.GITHUB_APP_ID, iat: now - 60, exp: now + 540,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(jwt));
  const response = await requestGitHub(`/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
    `${jwt}.${base64url(new Uint8Array(signature))}`, {
      method: "POST", body: JSON.stringify({ repositories: ["Carrot"], permissions: { contents: "write" } }),
    });
  if (!response.ok) throw new Error("GitHub App token unavailable");
  const { token, expires_at: expiresAt } = await response.json();
  if (typeof token !== "string" || !token || !(Date.parse(expiresAt) > Date.now())) {
    throw new Error("Invalid GitHub installation token");
  }
  return { token, expiresAt: Date.parse(expiresAt) };
}

async function getInstallationToken(env) {
  const id = `${env.GITHUB_APP_ID}/${env.GITHUB_INSTALLATION_ID}`;
  if (!installation || installation.id !== id || installation.expiresAt <= Date.now() + 60_000) {
    const entry = { id, expiresAt: Infinity, pending: createInstallationToken(env) };
    installation = entry;
    try {
      const result = await entry.pending;
      entry.expiresAt = result.expiresAt;
    } catch (error) {
      if (installation === entry) installation = undefined;
      throw error;
    }
  }
  return (await installation.pending).token;
}

async function githubFetch(env, path, options) {
  const token = await getInstallationToken(env);
  const response = await requestGitHub(path, token, options);
  if (response.status !== 401) return response;
  if (installation && (await installation.pending).token === token) installation = undefined;
  return requestGitHub(path, await getInstallationToken(env), options);
}

async function recordsKey(env) {
  const bytes = unbase64url(env.RECORDS_KEY);
  if (bytes.length !== 32) throw new Error("Invalid records key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function contentsPath(month) {
  return `${repo}/contents/bp/${month}.enc.json`;
}

async function readMonth(env, key, month) {
  const response = await githubFetch(env, `${contentsPath(month)}?ref=${branch}`);
  if (response.status === 404) {
    const ref = await githubFetch(env, `${repo}/git/ref/heads/${branch}`);
    if (!ref.ok) throw new Error("Records branch unavailable");
    return { records: [] };
  }
  if (!response.ok) throw new Error("Cannot read records");
  const { sha, content, encoding } = await response.json();
  if (typeof sha !== "string" || encoding !== "base64" || typeof content !== "string") {
    throw new Error("Invalid repository file response");
  }
  const envelope = JSON.parse(decoder.decode(unbase64(content)));
  const records = await decryptRecords(key, month, envelope);
  if (!Array.isArray(records)) throw new Error("Invalid records file");
  return { sha, records };
}

export async function listRecords(env, month) {
  const { records } = await readMonth(env, await recordsKey(env), month);
  return records.sort((a, b) => b.measuredAt.localeCompare(a.measuredAt));
}

export async function appendRecord(env, record) {
  const month = monthOf(new Date(record.measuredAt));
  const key = await recordsKey(env);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { sha, records } = await readMonth(env, key, month);
    const existing = records.find((item) => item.id === record.id);
    if (existing) {
      return JSON.stringify(existing) === JSON.stringify(record) ? "duplicate" : "id-conflict";
    }
    const envelope = await encryptRecords(key, month, [...records, record]);
    const response = await githubFetch(env, contentsPath(month), {
      method: "PUT",
      body: JSON.stringify({
        message: "Update encrypted records", branch, sha,
        content: base64(encoder.encode(JSON.stringify(envelope))),
      }),
    });
    if (response.ok) return "created";
    if (response.status !== 409 && !(response.status === 422 && !sha)) {
      throw new Error("GitHub write failed");
    }
  }
  return "retry";
}
