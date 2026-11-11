import { base64, base64url, decryptRecords, encryptRecords, unbase64, unbase64url } from "./security.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const github = "https://api.github.com";
const repo = "/repos/Ccccccccccccccccccccccccccccccccccarrot/Carrot";
const branch = "records";
const branchRef = `${repo}/git/ref/heads/${branch}`;
const apiVersion = "2026-03-10";
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timestampPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const beijingDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

let installation;

export const monthPattern = /^20\d\d-(0[1-9]|1[0-2])$/;

export function validDay(day) {
  if (!/^20\d\d-\d\d-\d\d$/.test(day)) return false;
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === day;
}

function dayOf(date) {
  const parts = beijingDate.formatToParts(date);
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type).value).join("-");
}

export function monthOf(date) {
  return dayOf(date).slice(0, 7);
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
  if (value.person !== undefined && value.person !== "father" && value.person !== "mother") return null;
  const record = {
    id: value.id, measuredAt: value.measuredAt, systolic: value.systolic,
    diastolic: value.diastolic, pulse: value.pulse ?? null,
  };
  // Older pages and pending submissions can still send records without a person.
  if (value.person !== undefined) record.person = value.person;
  return record;
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

function monthFile(month) {
  return `bp/${month}.enc.json`;
}

async function readMonth(env, key, month) {
  const response = await githubFetch(env, `${repo}/contents/${monthFile(month)}?ref=${branch}`);
  if (response.status === 404) {
    if (!(await githubFetch(env, branchRef)).ok) throw new Error("Records branch unavailable");
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

export async function listRecords(env, month, day) {
  const { records } = await readMonth(env, await recordsKey(env), month);
  return records
    .filter((record) => !record.removed && (day == null || dayOf(new Date(record.measuredAt)) === day))
    .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt));
}

function sameRecord(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function encryptedContents(key, month, records) {
  const envelope = await encryptRecords(key, month, records);
  return base64(encoder.encode(JSON.stringify(envelope)));
}

async function writeMonth(env, key, month, sha, records) {
  const response = await githubFetch(env, `${repo}/contents/${monthFile(month)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: "Update encrypted records", branch, sha,
      content: await encryptedContents(key, month, records),
    }),
  });
  if (response.ok) return true;
  if (response.status === 409 || (response.status === 422 && !sha)) return false;
  throw new Error("GitHub write failed");
}

export async function appendRecord(env, record) {
  const month = monthOf(new Date(record.measuredAt));
  const key = await recordsKey(env);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { sha, records } = await readMonth(env, key, month);
    const existing = records.find((item) => item.id === record.id);
    if (existing) {
      return sameRecord(existing, record) ? "duplicate" : "id-conflict";
    }
    if (await writeMonth(env, key, month, sha, [...records, record])) return "created";
  }
  return "retry";
}

export async function changeRecord(env, original, replacement) {
  const month = monthOf(new Date(original.measuredAt));
  const key = await recordsKey(env);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { sha, records } = await readMonth(env, key, month);
    const index = records.findIndex((item) => item.id === original.id);
    const current = records[index];
    if (replacement ? sameRecord(current, replacement) : current?.removed === "deleted") return "ok";
    if (!sameRecord(current, original)) return "conflict";
    // Keep the ID reserved so a retry of the original creation cannot restore it.
    records[index] = replacement ?? { id: original.id, removed: "deleted" };
    if (await writeMonth(env, key, month, sha, records)) return "ok";
  }
  return "retry";
}
