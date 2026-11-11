import { workerOrigin } from "./config.js";
import { cacheMonth, clearHistory, discardChanges, enqueue, finishChange, queuedChanges, readMonth } from "./storage.js?v=6";

const byId = (id) => document.getElementById(id);
const form = byId("record-form");
const fields = byId("record-fields");
const personInput = byId("person");
const save = byId("save");
const saveStatus = byId("save-status");
const monthInput = byId("history-month");
const dayInput = byId("history-day");
const monthLabel = byId("history-month-label");
const dayLabel = byId("history-day-label");
const historyList = byId("history-list");
const historyStatus = byId("history-status");
const historyNotice = byId("history-notice");
const editDialog = byId("edit-dialog");
const editForm = byId("edit-form");
const editStatus = byId("edit-status");
const editTime = byId("edit-time");
const loginForm = byId("login-form");
const syncStatus = byId("sync-status");
const sessionKey = "carrot-bp-session";
const appSessionKey = "carrot-bp-app-session";
const loginKey = "carrot-bp-login";
const draftKey = "carrot-bp-pending-record";
const tabKey = "carrot-bp-tab";
const monthKey = "carrot-bp-month";
const dayKey = "carrot-bp-day";
const monthPattern = /^20\d\d-(0[1-9]|1[0-2])$/;
const personNames = new Map([["father", "爸爸"], ["mother", "妈妈"]]);
const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

let account = null;
let syncTask = null;
let syncAgain = false;
let saving = false;
let historyRequest = 0;
let measuredAtEdited = false;
let editing = null;
let changingHistory = false;

function beijingInputTime(date = new Date()) {
  return new Date(date.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function rememberHistoryDate() {
  sessionStorage.setItem(monthKey, monthInput.value);
  if (dayInput?.value) sessionStorage.setItem(dayKey, dayInput.value);
  else sessionStorage.removeItem(dayKey);
}

function updateCalendarLabels() {
  if (monthLabel) {
    const [year, month] = monthInput.value.split("-");
    monthLabel.textContent = month ? `${year}年${Number(month)}月` : "yyyy/mm";
  }
  if (dayLabel) dayLabel.textContent = dayInput.value.replaceAll("-", "/") || "yyyy/mm/日";
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomToken() {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

function newRecordId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function showWelcome(message, canLogin = true) {
  historyRequest += 1;
  if (editDialog?.open) editDialog.close();
  historyList.replaceChildren();
  byId("book").hidden = true;
  byId("logout").hidden = true;
  byId("welcome").hidden = false;
  byId("welcome-message").textContent = message;
  if (loginForm) loginForm.hidden = !canLogin;
  else byId("login").hidden = !canLogin;
}

function clearSession() {
  account = null;
  try { localStorage.removeItem(appSessionKey); } catch {}
  sessionStorage.removeItem(sessionKey);
}

function acceptSession(value) {
  if (!value || typeof value.session !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.session) ||
      typeof value.username !== "string" || !/^[a-z0-9_-]{1,32}$/.test(value.username) ||
      !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) return false;
  account = value;
  try { localStorage.setItem(appSessionKey, JSON.stringify(value)); } catch {}
  sessionStorage.removeItem(sessionKey);
  return true;
}

async function api(path, { method = "GET", data, token = account?.session } = {}) {
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

async function showBook() {
  byId("welcome").hidden = true;
  byId("book").hidden = false;
  byId("logout").hidden = false;
  const month = sessionStorage.getItem(monthKey);
  monthInput.value = month && monthPattern.test(month) ? month : beijingInputTime().slice(0, 7);
  const day = sessionStorage.getItem(dayKey);
  if (dayInput) dayInput.value = day?.startsWith(`${monthInput.value}-`) ? day : "";
  updateCalendarLabels();
  resetForm();
  saveStatus.textContent = "";
  historyNotice.textContent = "";
  const draft = sessionStorage.getItem(draftKey);
  if (draft) {
    try {
      await saveLocally("POST", null, JSON.parse(draft));
      sessionStorage.removeItem(draftKey);
    } catch {
      saveStatus.textContent = "旧版的待保存记录暂时无法迁移，请刷新重试。";
    }
  }
  showTab(sessionStorage.getItem(tabKey) === "history", false);
  void resumeSync();
}

function requireLogin() {
  clearSession();
  showWelcome("登录已过期，请重新登录。");
}

function saveLocally(method, original, record) {
  const target = record ?? original;
  return enqueue({ user: account.username, month: beijingInputTime(new Date(target.measuredAt)).slice(0, 7),
    id: target.id, method, original, record });
}

async function saveRecord(event) {
  event.preventDefault();
  if (saving || changingHistory || !account) return;
  const measuredAt = measuredAtEdited ? new Date(`${byId("measured-at").value}+08:00`) : new Date();
  if (!Number.isFinite(measuredAt.valueOf())) {
    saveStatus.classList.add("error");
    saveStatus.textContent = "请选择有效的测量时间。";
    return;
  }
  const record = {
    id: newRecordId(),
    systolic: byId("systolic").valueAsNumber,
    diastolic: byId("diastolic").valueAsNumber,
    pulse: byId("pulse").value ? byId("pulse").valueAsNumber : null,
    measuredAt: measuredAt.toISOString(),
    person: personInput?.value,
  };

  saving = true;
  save.disabled = true;
  byId("logout").disabled = true;
  fields.disabled = true;
  saveStatus.classList.remove("error");
  saveStatus.textContent = "正在保存…";
  try {
    await saveLocally("POST", null, record);
    const savedDay = beijingInputTime(measuredAt).slice(0, 10);
    monthInput.value = savedDay.slice(0, 7);
    if (dayInput?.value) dayInput.value = savedDay;
    rememberHistoryDate();
    resetForm();
    saveStatus.textContent = "已保存到本机";
    void resumeSync();
  } catch {
    saveStatus.classList.add("error");
    saveStatus.textContent = "本机存储不可用，记录尚未保存，请重试。";
  } finally {
    saving = false;
    save.disabled = false;
    fields.disabled = false;
    byId("logout").disabled = false;
  }
}

function renderRecord({ record, state }) {
  const item = document.createElement("li");
  const summary = document.createElement("div");
  const metadata = document.createElement("div");
  metadata.className = "record-meta";
  const person = document.createElement("span");
  person.textContent = personNames.get(record.person) ?? "未标注";
  const timestamp = document.createElement("time");
  timestamp.dateTime = record.measuredAt;
  timestamp.textContent = timeFormat.format(new Date(record.measuredAt));
  metadata.append(person, timestamp);
  if (state) {
    const badge = document.createElement("span");
    badge.className = `record-state ${state}`;
    badge.textContent = { pending: "待同步", deleting: "待同步删除", conflict: "同步冲突", invalid: "同步失败" }[state];
    metadata.append(badge);
  }
  const values = document.createElement("div");
  values.className = "record-values";
  const pressure = document.createElement("div");
  pressure.className = "record-pressure";
  const readings = document.createElement("strong");
  readings.textContent = `${record.systolic} / ${record.diastolic}`;
  const unit = document.createElement("span");
  unit.textContent = "mmHg";
  pressure.append(readings, unit);
  values.append(pressure);
  if (record.pulse) {
    const pulse = document.createElement("span");
    pulse.textContent = `· 脉搏 ${record.pulse} 次/分钟`;
    values.append(pulse);
  }
  summary.append(metadata, values);
  item.append(summary);
  if (editDialog && state !== "deleting") {
    const actions = document.createElement("div");
    actions.className = "record-actions";
    if (state === "conflict" || state === "invalid") {
      const discard = document.createElement("button");
      discard.type = "button";
      discard.className = "secondary";
      discard.textContent = "撤销本机更改";
      discard.addEventListener("click", async () => {
        if (!account || !window.confirm("撤销这条记录在本机尚未同步的更改？")) return;
        try {
          await discardChanges(account.username, record.id);
          historyNotice.textContent = "已撤销本机更改";
          void resumeSync();
        } catch {
          historyNotice.textContent = "暂时无法撤销，请重试。";
        }
      });
      actions.append(discard);
      item.append(actions);
      return item;
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => openEdit(record));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary danger";
    remove.textContent = "删除";
    remove.addEventListener("click", () => {
      if (saving || changingHistory) return;
      const label = personNames.get(record.person) ?? "未标注";
      if (window.confirm(`确定删除这条记录？\n${label} · ${timestamp.textContent} · ${readings.textContent} mmHg`)) {
        void changeHistory(record, null);
      }
    });
    actions.append(edit, remove);
    item.append(actions);
  }
  return item;
}

function openEdit(record) {
  if (saving || changingHistory) return;
  if (!editDialog.showModal) {
    historyNotice.textContent = "当前浏览器不支持编辑弹窗，请更新浏览器。";
    return;
  }
  editing = record;
  const input = editForm.elements;
  input.person.value = record.person ?? "";
  input.person.options[0].disabled = Boolean(record.person);
  input.systolic.value = record.systolic;
  input.diastolic.value = record.diastolic;
  input.pulse.value = record.pulse ?? "";
  const time = beijingInputTime(new Date(record.measuredAt));
  if (editTime) {
    editTime.dateTime = record.measuredAt;
    editTime.textContent = time.replace("T", " ");
  }
  // Older cached HTML can still contain the previous time input.
  if (input.measuredAt) {
    input.measuredAt.value = time;
    input.measuredAt.readOnly = true;
  }
  editStatus.textContent = "";
  editStatus.classList.remove("error");
  const heading = byId("edit-heading");
  heading.tabIndex = -1;
  heading.setAttribute("autofocus", "");
  editDialog.showModal();
  heading.focus({ preventScroll: true });
}

function submitEdit(event) {
  event.preventDefault();
  if (!editing || changingHistory || !account) return;
  const input = editForm.elements;
  void changeHistory(editing, {
    id: editing.id,
    measuredAt: editing.measuredAt,
    systolic: input.systolic.valueAsNumber,
    diastolic: input.diastolic.valueAsNumber,
    pulse: input.pulse.value ? input.pulse.valueAsNumber : null,
    person: input.person.value || undefined,
  });
}

async function changeHistory(original, replacement) {
  if (!account || saving || changingHistory) return;
  const status = replacement ? editStatus : historyNotice;
  const controls = ["logout", "new-tab", "history-tab", "history-month", "refresh",
    "history-day", "clear-day", "edit-fields", "edit-save", "edit-cancel"].map(byId).filter(Boolean);
  changingHistory = true;
  controls.forEach((control) => { control.disabled = true; });
  historyList.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  status.classList.remove("error");
  status.textContent = replacement ? "正在保存修改…" : "正在删除…";
  try {
    await saveLocally(replacement ? "PATCH" : "DELETE", original, replacement);
    if (replacement) editDialog.close();
    historyNotice.classList.remove("error");
    historyNotice.textContent = replacement ? "修改已保存到本机" : "删除已登记到本机";
    void resumeSync();
  } catch {
    status.classList.add("error");
    status.textContent = "本机存储不可用，更改尚未保存，请重试。";
  } finally {
    changingHistory = false;
    controls.forEach((control) => { control.disabled = false; });
    historyList.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

async function loadHistory(owner, remote = false) {
  const request = ++historyRequest;
  const month = monthInput.value;
  const day = dayInput?.value;
  const current = () => owner === account && request === historyRequest &&
    monthInput.value === month && dayInput?.value === day;
  updateCalendarLabels();
  const parsedDay = day && new Date(`${day}T00:00:00Z`);
  const validMonth = monthPattern.test(month);
  if (!validMonth || (day && (!dayInput.validity.valid || !day.startsWith(`${month}-`) ||
      !Number.isFinite(parsedDay.valueOf()) || parsedDay.toISOString().slice(0, 10) !== day))) {
    historyList.replaceChildren();
    historyStatus.textContent = validMonth ? "请选择有效日期。" : "请选择有效月份。";
    return false;
  }
  rememberHistoryDate();
  if (remote) {
    const response = await api(`/api/records?month=${month}`, { token: owner.session });
    if (!current()) return false;
    if (response.status === 401) {
      requireLogin();
      return false;
    }
    if (!response.ok) throw new Error("History unavailable");
    const { records } = await response.json();
    if (!current()) return false;
    await cacheMonth(owner.username, month, records);
  }
  const { cache, changes } = await readMonth(owner.username, month);
  if (!current()) return false;
  const rows = new Map((cache?.records ?? []).map((record) => [record.id, { record }]));
  for (const { id, record, original, reason } of changes) {
    const previous = rows.get(id);
    if (previous?.state === "conflict" || previous?.state === "invalid") continue;
    rows.set(id, { record: record ?? previous?.record ?? original, state: reason ?? (record ? "pending" : "deleting") });
  }
  const visible = [...rows.values()].filter(({ record }) => !day || beijingInputTime(new Date(record.measuredAt)).startsWith(day))
    .sort((a, b) => b.record.measuredAt.localeCompare(a.record.measuredAt));
  historyList.replaceChildren(...visible.map(renderRecord));
  historyStatus.textContent = visible.length ? `共 ${visible.length} 条`
    : cache?.complete ? (day ? "这一天还没有记录。" : "这个月还没有记录。")
      : "本机还没有这段历史，联网后会同步。";
  return remote;
}

async function syncChanges(owner) {
  const changes = await queuedChanges(owner.username);
  const blocked = new Set();
  for (const change of changes) {
    if (owner !== account) return;
    if (change.reason) blocked.add(change.id);
    if (blocked.has(change.id)) continue;
    const { method, original, record } = change;
    const response = await api("/api/records", { method, token: owner.session,
      data: method === "POST" ? record : { original, record } });
    if (owner !== account) return;
    if (response.status === 401) {
      requireLogin();
      return;
    }
    if (response.status === 400 || response.status === 409) {
      blocked.add(change.id);
      await finishChange(change, response.status === 409 ? "conflict" : "invalid");
    } else {
      if (!response.ok) throw new Error("Upload unavailable");
      await finishChange(change);
    }
  }
}

function setSyncStatus(message) {
  if (syncStatus) syncStatus.textContent = message;
}

function resumeSync() {
  if (!account) return;
  if (syncTask) {
    syncAgain = true;
    return;
  }
  const owner = account;
  syncTask = (async () => {
    do {
      syncAgain = false;
      if (owner.expiresAt <= Date.now()) {
        requireLogin();
        return;
      }
      setSyncStatus(navigator.onLine ? "正在同步…" : "当前离线，可保存到本机。");
      await loadHistory(owner);
      if (owner !== account) return;
      let updated = false;
      if (navigator.onLine) {
        try {
          await syncChanges(owner);
          if (owner !== account) return;
          updated = await loadHistory(owner, true);
        } catch {
          if (owner !== account) return;
          await loadHistory(owner);
        }
      }
      if (owner !== account) return;
      const changes = await queuedChanges(owner.username);
      if (owner !== account) return;
      const blocked = new Set(changes.filter((change) => change.reason).map((change) => change.id));
      const remaining = new Set(changes.filter((change) => !blocked.has(change.id)).map((change) => change.id));
      const messages = [];
      if (remaining.size) messages.push(`${remaining.size} 条记录待同步，重新打开或联网后会重试。`);
      if (blocked.size) messages.push(`${blocked.size} 条记录需要处理，请查看历史。`);
      setSyncStatus(messages.join(" ") || (updated ? "已同步" : "暂未同步，当前显示本机记录。"));
    } while (syncAgain && owner === account);
  })().catch(() => {
    if (owner === account) setSyncStatus("暂时无法访问本机存储，请刷新重试。");
  }).finally(() => {
    syncTask = null;
    if (syncAgain && account) resumeSync();
  });
}

function showTab(history, refresh = true) {
  sessionStorage.setItem(tabKey, history ? "history" : "new");
  byId("new-panel").hidden = history;
  byId("history-panel").hidden = !history;
  byId("new-tab").setAttribute("aria-pressed", String(!history));
  byId("history-tab").setAttribute("aria-pressed", String(history));
  if (history && refresh) resumeSync();
  else if (!history && !measuredAtEdited) byId("measured-at").value = beijingInputTime();
}

async function logout() {
  const previous = account;
  clearSession();
  sessionStorage.removeItem(tabKey);
  sessionStorage.removeItem(monthKey);
  sessionStorage.removeItem(dayKey);
  resetForm();
  saveStatus.textContent = "";
  showWelcome("已退出。需要时可以重新登录。");
  if (!previous) return;
  await Promise.allSettled([
    clearHistory(previous.username),
    api("/auth/logout", { method: "POST", token: previous.session }),
  ]);
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
      if (!response.ok || !acceptSession(await response.json())) throw new Error("Login failed");
    } catch {
      showWelcome("未能完成登录，请重新试一次。");
      return;
    }
  } else {
    try { acceptSession(JSON.parse(localStorage.getItem(appSessionKey))); } catch {}
    const legacy = sessionStorage.getItem(sessionKey);
    if (!account && legacy) {
      try {
        const response = await api("/auth/session", { token: legacy });
        if (response.ok) acceptSession({ ...await response.json(), session: legacy });
      } catch {}
    }
  }
  if (account) await showBook();
  else showWelcome("登录后就能记血压、看历史。");
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("login");
    if (button.disabled) return;
    button.disabled = true;
    const { username, password } = loginForm.elements;
    const message = byId("welcome-message");
    message.textContent = "正在登录…";
    try {
      const response = await api("/auth/session", { method: "POST", token: null,
        data: { username: username.value.trim(), password: password.value } });
      if (response.status === 401) message.textContent = "账号或密码不正确，请再试一次。";
      else if (response.status === 429) message.textContent = "尝试次数过多，请稍后再试。";
      else if (!response.ok || !acceptSession(await response.json())) throw new Error("Login failed");
      else {
        password.value = "";
        await showBook();
      }
    } catch {
      message.textContent = "暂时无法登录，请检查网络后重试。";
    } finally {
      button.disabled = false;
    }
  });
} else {
  byId("login").addEventListener("click", () => {
    startLogin().catch(() => showWelcome("暂时无法打开登录页，请重试。"));
  });
}
byId("logout").addEventListener("click", logout);
byId("new-tab").addEventListener("click", () => showTab(false));
byId("history-tab").addEventListener("click", () => showTab(true));
byId("refresh").addEventListener("click", resumeSync);
for (const input of [monthInput, dayInput]) {
  if (input && input.type !== "text") {
    input.closest(".calendar-field")?.classList.add("calendar-enhanced");
    input.addEventListener("input", updateCalendarLabels);
  }
}
monthInput.addEventListener("change", () => {
  if (dayInput) dayInput.value = "";
  resumeSync();
});
dayInput?.addEventListener("change", () => {
  if (dayInput.type === "text") dayInput.value = dayInput.value.trim().replaceAll("/", "-");
  if (dayInput.value && dayInput.validity.valid) monthInput.value = dayInput.value.slice(0, 7);
  resumeSync();
});
byId("clear-day")?.addEventListener("click", () => {
  dayInput.value = "";
  resumeSync();
});
byId("measured-at").addEventListener("input", () => { measuredAtEdited = true; });
form.addEventListener("submit", saveRecord);
if (editDialog) {
  editForm.addEventListener("submit", submitEdit);
  byId("edit-cancel").addEventListener("click", () => editDialog.close());
  editDialog.addEventListener("cancel", (event) => {
    if (changingHistory) event.preventDefault();
  });
}
initialize().catch(() => showWelcome("页面暂时无法打开，请刷新重试。"));
window.addEventListener("online", resumeSync);
window.addEventListener("pageshow", (event) => { if (event.persisted) resumeSync(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) resumeSync(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
