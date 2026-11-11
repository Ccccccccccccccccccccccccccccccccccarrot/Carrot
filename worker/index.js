import { hash, passwordPattern, randomToken, tokenPattern, usernamePattern, verifyPassword } from "./security.js";
import { appendRecord, changeRecord, listRecords, monthOf, monthPattern, normalizeRecord } from "./records.js";

export { FamilyAuth } from "./auth.js";

const securityHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

class BadRequest extends Error {}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new BadRequest();
  const bytes = new Uint8Array(4096);
  let offset = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) {
        await reader.cancel();
        throw new BadRequest();
      }
      bytes.set(value, offset);
      offset += value.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } catch {
    throw new BadRequest();
  } finally {
    reader.releaseLock();
  }
}

async function readJson(request) {
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") throw new BadRequest();
  try {
    return JSON.parse(await readBody(request));
  } catch {
    throw new BadRequest();
  }
}

function loginPage(pagesOrigin, challenge, state, message = "", status = 200) {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · 家庭血压本</title><style>
:root{color-scheme:light;font:18px system-ui,sans-serif;color:#17362d;background:#f1f7f3}*{box-sizing:border-box}
main{max-width:28rem;margin:10vh auto;padding:1.5rem}h1{font-size:2rem;margin:0 0 .7rem}p{line-height:1.5}
label{display:block;font-weight:650;margin-top:1rem}input,button{display:block;width:100%;min-height:3rem;border-radius:.55rem;font:inherit;margin-top:.4rem}
input{border:1px solid #84968a;padding:.5rem .75rem;background:#fff}button{background:#155c43;color:#fff;border:0;margin-top:1.4rem;font-weight:650} .error{color:#9a3021}
</style></head><body><main><h1>家庭血压本</h1><p>使用家人发给你的账号登录。</p>
${message ? `<p class="error" role="alert">${message}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="challenge" value="${challenge}"><input type="hidden" name="state" value="${state}">
<label>账号<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="32"></label>
<label>密码<input name="password" type="password" autocomplete="current-password" required maxlength="22"></label>
<button type="submit">登录</button></form></main></body></html>`;
  return new Response(html, { status, headers: {
    ...securityHeaders,
    "Referrer-Policy": "same-origin",
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${pagesOrigin}; frame-ancestors 'none'; base-uri 'none'`,
  } });
}

function getVerifier(env, username) {
  const accounts = JSON.parse(env.FAMILY_ACCOUNTS);
  const verifier = Object.hasOwn(accounts, username) ? accounts[username] : null;
  return typeof verifier === "string" && tokenPattern.test(verifier) ? verifier : null;
}

function isActive(env, account) {
  return account && getVerifier(env, account.user) === account.verifier;
}

async function login(request, url, env, pages, auth) {
  const isPost = request.method === "POST";
  if (isPost && request.headers.get("Origin") !== url.origin) return new Response("Forbidden", { status: 403 });
  if (isPost && request.headers.get("Content-Type")?.split(";")[0] !== "application/x-www-form-urlencoded") {
    throw new BadRequest();
  }
  const form = isPost ? new URLSearchParams(await readBody(request)) : url.searchParams;
  const challenge = form.get("challenge");
  const state = form.get("state");
  if (!challenge || !state || !tokenPattern.test(challenge) || !tokenPattern.test(state)) {
    return new Response("请从家庭血压本的网址重新打开登录页。", { status: 400, headers: securityHeaders });
  }
  if (!isPost) return loginPage(pages.origin, challenge, state);

  const source = await hash(request.headers.get("CF-Connecting-IP") ?? "local");
  if (!await auth.allowAttempt(source)) return loginPage(pages.origin, challenge, state, "尝试次数过多，请稍后再试。", 429);
  const username = (form.get("username") ?? "").trim().toLowerCase();
  const password = form.get("password") ?? "";
  const verifier = usernamePattern.test(username) ? getVerifier(env, username) : null;
  if (!verifier || !passwordPattern.test(password) || !await verifyPassword(env.PASSWORD_PEPPER, username, password, verifier)) {
    return loginPage(pages.origin, challenge, state, "账号或密码不正确。", 401);
  }
  const code = randomToken();
  await auth.issueCode(await hash(code), challenge, username, verifier);
  const redirect = new URL(pages);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", state);
  return new Response(null, { status: 303, headers: { ...securityHeaders, Location: redirect.href } });
}

function apiResponder(origin, pages) {
  const headers = { ...securityHeaders, Vary: "Origin" };
  if (origin === pages.origin) headers["Access-Control-Allow-Origin"] = origin;
  return (payload, status = 200) => Response.json(payload, { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pages = new URL(env.PAGES_URL);
    const origin = request.headers.get("Origin");
    const reply = apiResponder(origin, pages);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path === "/login" && (method === "GET" || method === "POST")) {
        return await login(request, url, env, pages, env.AUTH.getByName("family"));
      }
      if (path !== "/auth/exchange" && path !== "/auth/logout" && path !== "/api/records") {
        return reply({ error: "not_found" }, 404);
      }
      if (origin && origin !== pages.origin) return reply({ error: "forbidden" }, 403);
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: {
          ...securityHeaders, Vary: "Origin", "Access-Control-Allow-Origin": pages.origin,
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        } });
      }
      const auth = env.AUTH.getByName("family");
      if (path === "/auth/exchange" && method === "POST") {
        const data = await readJson(request);
        if (typeof data?.code !== "string" || typeof data?.verifier !== "string" ||
            !tokenPattern.test(data.code) || !tokenPattern.test(data.verifier)) throw new BadRequest();
        const session = randomToken();
        const account = await auth.exchangeCode(await hash(data.code), await hash(data.verifier), await hash(session));
        if (!isActive(env, account)) return reply({ error: "invalid_code" }, 401);
        return reply({ session });
      }

      const token = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!token) return reply({ error: "unauthorized" }, 401);
      const sessionHash = await hash(token);
      if (!isActive(env, await auth.getSession(sessionHash))) return reply({ error: "unauthorized" }, 401);
      if (path === "/auth/logout" && method === "POST") {
        await auth.removeSession(sessionHash);
        return reply({ ok: true });
      }
      if (path === "/api/records" && method === "GET") {
        const month = url.searchParams.get("month") ?? monthOf(new Date());
        if (!monthPattern.test(month)) throw new BadRequest();
        return reply({ records: await listRecords(env, month) });
      }
      if (path === "/api/records" && method === "POST") {
        const record = normalizeRecord(await readJson(request));
        if (!record) throw new BadRequest();
        const result = await appendRecord(env, record);
        if (result === "retry") return reply({ error: "try_again" }, 503);
        if (result === "id-conflict") return reply({ error: "id_conflict" }, 409);
        return reply({ record }, result === "created" ? 201 : 200);
      }
      if (path === "/api/records" && (method === "PATCH" || method === "DELETE")) {
        const data = await readJson(request);
        const original = normalizeRecord(data?.original);
        const replacement = method === "PATCH" ? normalizeRecord(data?.record) : null;
        if (!original || (method === "PATCH" && replacement?.id !== original.id)) throw new BadRequest();
        const result = await changeRecord(env, original, replacement);
        if (result === "retry") return reply({ error: "try_again" }, 503);
        if (result === "conflict") return reply({ error: "record_changed" }, 409);
        return reply({ ok: true });
      }
      return reply({ error: "method_not_allowed" }, 405);
    } catch (error) {
      if (error instanceof BadRequest) return reply({ error: "invalid_request" }, 400);
      console.error("Carrot request failed", method, path);
      return reply({ error: "unavailable" }, 503);
    }
  },
};
