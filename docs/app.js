import { workerOrigin } from "./config.js";

const byId = (id) => document.getElementById(id);
const form = byId("record-form");
const fields = byId("record-fields");
const save = byId("save");
const saveStatus = byId("save-status");
const monthInput = byId("history-month");
const historyList = byId("history-list");
const historyStatus = byId("history-status");
const sessionKey = "carrot-bp-session";
const loginKey = "carrot-bp-login";
const draftKey = "carrot-bp-pending-record";
const tabKey = "carrot-bp-tab";
const monthKey = "carrot-bp-month";
const monthPattern = /^20\d\d-(0[1-9]|1[0-2])$/;
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

let session = sessionStorage.getItem(sessionKey);
let pending = JSON.parse(sessionStorage.getItem(draftKey) ?? "null");
let saving = false;
let historyRequest = 0;
let measuredAtEdited = false;

function beijingInputTime(date = new Date()) {
  return new Date(date.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomToken() {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

function showWelcome(message, canLogin = true) {
  historyRequest += 1;
  historyList.replaceChildren();
  byId("book").hidden = true;
  byId("logout").hidden = true;
  byId("welcome").hidden = false;
  byId("welcome-message").textContent = message;
  byId("login").hidden = !canLogin;
}

function clearSession() {
  session = null;
  sessionStorage.removeItem(sessionKey);
}

async function api(path, { method = "GET", data, token = session } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(`${workerOrigin}${path}`, {
      method, headers, body: data === undefined ? undefined : JSON.stringify(data),
      cache: "no-store", signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function startLogin() {
  const verifier = randomToken();
  const state = randomToken();
  const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  sessionStorage.setItem(loginKey, JSON.stringify({ verifier, state }));
  const url = new URL("/login", workerOrigin);
  url.searchParams.set("challenge", challenge);
  url.searchParams.set("state", state);
  location.assign(url.href);
}

function resetForm() {
  form.reset();
  measuredAtEdited = false;
  byId("measured-at").value = beijingInputTime();
}

function displayPending() {
  byId("systolic").value = pending.systolic;
  byId("diastolic").value = pending.diastolic;
  byId("pulse").value = pending.pulse ?? "";
  byId("measured-at").value = beijingInputTime(new Date(pending.measuredAt));
  fields.disabled = true;
  save.textContent = "重试保存";
}

function showBook() {
  byId("welcome").hidden = true;
  byId("book").hidden = false;
  byId("logout").hidden = false;
  const month = sessionStorage.getItem(monthKey);
  monthInput.value = month && monthPattern.test(month) ? month : beijingInputTime().slice(0, 7);
  resetForm();
  if (pending) {
    displayPending();
    saveStatus.textContent = "有一条记录待确认，请重试保存。";
  }
  showTab(!pending && sessionStorage.getItem(tabKey) === "history");
}

function requireLogin() {
  clearSession();
  showWelcome("登录已过期，请重新登录。");
}

function releaseDraft() {
  pending = null;
  sessionStorage.removeItem(draftKey);
  fields.disabled = false;
  save.textContent = "保存记录";
}

async function saveRecord(event) {
  event.preventDefault();
  if (saving) return;
  if (!pending) {
    const measuredAt = measuredAtEdited ? new Date(`${byId("measured-at").value}+08:00`) : new Date();
    if (!Number.isFinite(measuredAt.valueOf())) {
      saveStatus.classList.add("error");
      saveStatus.textContent = "请选择有效的测量时间。";
      return;
    }
    byId("measured-at").value = beijingInputTime(measuredAt);
    pending = {
      id: crypto.randomUUID(),
      systolic: byId("systolic").valueAsNumber,
      diastolic: byId("diastolic").valueAsNumber,
      pulse: byId("pulse").value ? byId("pulse").valueAsNumber : null,
      measuredAt: measuredAt.toISOString(),
    };
    sessionStorage.setItem(draftKey, JSON.stringify(pending));
  }

  saving = true;
  save.disabled = true;
  byId("logout").disabled = true;
  fields.disabled = true;
  saveStatus.classList.remove("error");
  saveStatus.textContent = "正在保存…";
  try {
    const response = await api("/api/records", { method: "POST", data: pending });
    if (response.status === 401) {
      requireLogin();
      return;
    }
    if (response.status === 400 || response.status === 409) {
      releaseDraft();
      saveStatus.classList.add("error");
      saveStatus.textContent = "这次未能保存，请检查输入后重新提交。";
      return;
    }
    if (!response.ok) throw new Error("Save not confirmed");
    monthInput.value = beijingInputTime(new Date(pending.measuredAt)).slice(0, 7);
    sessionStorage.setItem(monthKey, monthInput.value);
    releaseDraft();
    resetForm();
    saveStatus.textContent = "已保存";
    if (!byId("history-panel").hidden) await loadHistory();
  } catch {
    saveStatus.classList.add("error");
    saveStatus.textContent = "暂时无法确认保存，请重试。同一条记录只会保存一次。";
    save.textContent = "重试保存";
  } finally {
    saving = false;
    save.disabled = false;
    byId("logout").disabled = false;
  }
}

function renderRecord(record) {
  const item = document.createElement("li");
  const timestamp = document.createElement("time");
  timestamp.dateTime = record.measuredAt;
  timestamp.textContent = timeFormat.format(new Date(record.measuredAt));
  const readings = document.createElement("strong");
  readings.textContent = `${record.systolic} / ${record.diastolic}`;
  const unit = document.createElement("span");
  unit.textContent = record.pulse ? `mmHg · 脉搏 ${record.pulse} 次/分钟` : "mmHg";
  item.append(timestamp, readings, unit);
  return item;
}

async function loadHistory() {
  const request = ++historyRequest;
  historyList.replaceChildren();
  historyStatus.classList.remove("error");
  const month = monthInput.value;
  if (!monthPattern.test(month)) {
    historyStatus.textContent = "请选择有效月份。";
    return;
  }
  sessionStorage.setItem(monthKey, month);
  historyStatus.textContent = "正在读取…";
  try {
    const response = await api(`/api/records?month=${encodeURIComponent(month)}`);
    if (request !== historyRequest) return;
    if (response.status === 401) {
      requireLogin();
      return;
    }
    if (!response.ok) throw new Error("History unavailable");
    const { records } = await response.json();
    if (request !== historyRequest) return;
    historyList.replaceChildren(...records.map(renderRecord));
    historyStatus.textContent = records.length ? `共 ${records.length} 条` : "这个月还没有记录。";
  } catch {
    if (request !== historyRequest) return;
    historyStatus.classList.add("error");
    historyStatus.textContent = "暂时无法读取记录，请刷新重试。";
  }
}

function showTab(history) {
  sessionStorage.setItem(tabKey, history ? "history" : "new");
  byId("new-panel").hidden = history;
  byId("history-panel").hidden = !history;
  byId("new-tab").setAttribute("aria-pressed", String(!history));
  byId("history-tab").setAttribute("aria-pressed", String(history));
  if (history) void loadHistory();
  else if (!pending && !measuredAtEdited) byId("measured-at").value = beijingInputTime();
}

async function logout() {
  const token = session;
  clearSession();
  releaseDraft();
  sessionStorage.removeItem(tabKey);
  sessionStorage.removeItem(monthKey);
  resetForm();
  saveStatus.textContent = "";
  showWelcome("已退出。需要时可以重新登录。");
  try {
    await api("/auth/logout", { method: "POST", token });
  } catch {
    // The local session is already cleared and the server session expires on its own.
  }
}

async function initialize() {
  if (!workerOrigin) {
    showWelcome("血压本还在配置中，请稍后再来。", false);
    return;
  }
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code || state) {
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    history.replaceState(null, "", url);
    const login = JSON.parse(sessionStorage.getItem(loginKey) ?? "null");
    sessionStorage.removeItem(loginKey);
    if (!code || !login || state !== login.state) {
      showWelcome("登录链接已失效，请重新登录。");
      return;
    }
    try {
      const response = await api("/auth/exchange", { method: "POST", data: { code, verifier: login.verifier }, token: null });
      if (!response.ok) throw new Error("Login failed");
      ({ session } = await response.json());
      sessionStorage.setItem(sessionKey, session);
    } catch {
      showWelcome("未能完成登录，请重新试一次。");
      return;
    }
  }
  if (session) showBook();
  else showWelcome("登录后就能记血压、看历史。");
}

byId("login").addEventListener("click", () => {
  startLogin().catch(() => showWelcome("暂时无法打开登录页，请重试。"));
});
byId("logout").addEventListener("click", logout);
byId("new-tab").addEventListener("click", () => showTab(false));
byId("history-tab").addEventListener("click", () => showTab(true));
byId("refresh").addEventListener("click", loadHistory);
monthInput.addEventListener("change", loadHistory);
byId("measured-at").addEventListener("input", () => { measuredAtEdited = true; });
form.addEventListener("submit", saveRecord);
initialize().catch(() => showWelcome("页面暂时无法打开，请刷新重试。"));
