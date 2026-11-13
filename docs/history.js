const series = [
  { key: "systolic", label: "高压", unit: "mmHg" },
  { key: "diastolic", label: "低压", unit: "mmHg" },
  { key: "pulse", label: "脉搏", unit: "次/分" },
];
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  month: "long", day: "numeric", weekday: "short", timeZone: "UTC",
});
const byId = (id) => document.getElementById(id);

function dayNumber(date) {
  return Number(date.slice(8));
}

function dailyAverages(rows, person) {
  const days = new Map();
  for (const { date, trend } of rows) {
    if (trend?.person !== person) continue;
    const day = dayNumber(date);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(trend);
  }

  return [...days].sort(([a], [b]) => a - b).map(([day, records]) => {
    const point = { day };
    for (const { key } of series) {
      const values = records.map((record) => record[key]).filter(Number.isFinite);
      point[key] = values.length
        ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10
        : null;
    }
    return point;
  });
}

function paintTrend(chart, averages, selectedDay, lastDay) {
  const context = chart.getContext("2d");
  const { width, height } = chart.getBoundingClientRect();
  if (!context || !width || !height) return null;

  const ratio = window.devicePixelRatio || 1;
  chart.width = Math.round(width * ratio);
  chart.height = Math.round(height * ratio);
  context.scale(ratio, ratio);

  const values = averages.flatMap((point) => series.map(({ key }) => point[key]).filter(Number.isFinite));
  const smallest = Math.min(...values);
  const largest = Math.max(...values);
  const step = Math.max(20, Math.ceil((largest - smallest + 6) / 100) * 20);
  const min = Math.max(0, Math.floor((smallest - 3) / step) * step);
  const max = Math.ceil((largest + 3) / step) * step;
  const left = 35;
  const right = width - 13;
  const top = 13;
  const bottom = height - 24;
  const x = (day) => left + (day - 1) / (lastDay - 1) * (right - left);
  const y = (value) => bottom - (value - min) / (max - min) * (bottom - top);

  context.font = "12px system-ui";
  context.fillStyle = "#536b60";
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.strokeStyle = "#e3ece5";
  for (let value = min; value <= max; value += step) {
    context.beginPath();
    context.moveTo(left, y(value));
    context.lineTo(right, y(value));
    context.stroke();
    context.fillText(value, left - 7, y(value));
  }
  context.textAlign = "center";
  for (const day of [1, 5, 10, 15, 20, 25, lastDay]) {
    context.fillText(day, x(day), bottom + 15);
  }

  context.strokeStyle = "#9eafa6";
  context.setLineDash([4, 4]);
  context.beginPath();
  context.moveTo(x(selectedDay), top);
  context.lineTo(x(selectedDay), bottom);
  context.stroke();
  context.setLineDash([]);

  context.lineJoin = "round";
  context.lineCap = "round";
  const chartStyle = getComputedStyle(chart);
  for (const { key } of series) {
    const color = chartStyle.getPropertyValue(`--trend-${key}`).trim();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 2.3;
    if (key === "pulse") context.setLineDash([5, 4]);
    context.beginPath();
    let connected = false;
    for (const point of averages) {
      if (point[key] === null) {
        connected = false;
        continue;
      }
      const px = x(point.day);
      const py = y(point[key]);
      if (connected) context.lineTo(px, py);
      else context.moveTo(px, py);
      connected = true;
    }
    context.stroke();
    context.setLineDash([]);
    for (const point of averages) {
      if (point[key] === null) continue;
      context.beginPath();
      context.arc(x(point.day), y(point[key]), point.day === selectedDay ? 4.8 : 2.5, 0, Math.PI * 2);
      context.fill();
      if (point.day === selectedDay) {
        context.lineWidth = 1.5;
        context.strokeStyle = "#fff";
        context.stroke();
      }
    }
  }
  return { left, right, lastDay };
}

export function createHistoryView({ personNames, renderRecord, selectDay, changeMonth }) {
  const calendar = byId("history-days");
  const list = byId("history-list");
  const chart = byId("trend-chart");
  const personButtons = [...document.querySelectorAll("[data-trend-person]")];
  const trendEmpty = byId("trend-empty");
  const trendPoint = byId("trend-point");
  let person = "father";
  let month = "";
  let selectedDay = 0;
  let monthNumber = 0;
  let lastDay = 0;
  let dayButtons = [];
  let rows = [];
  let complete = false;
  let plot = null;

  function buildCalendar(value) {
    month = value;
    const [year, number] = value.split("-").map(Number);
    monthNumber = number;
    const first = new Date(Date.UTC(year, number - 1, 1));
    lastDay = new Date(Date.UTC(year, number, 0)).getUTCDate();
    const offset = (first.getUTCDay() + 6) % 7;
    byId("history-month-title").textContent = `${year}年${number}月`;
    const cells = document.createDocumentFragment();
    for (let index = 0; index < offset; index++) {
      const blank = document.createElement("span");
      blank.setAttribute("aria-hidden", "true");
      cells.append(blank);
    }
    dayButtons = [];
    for (let day = 1; day <= lastDay; day++) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.day = day;
      button.textContent = day;
      dayButtons.push(button);
      cells.append(button);
    }
    calendar.replaceChildren(cells);
  }

  function renderTrend() {
    if (!month) return;
    const averages = dailyAverages(rows, person);
    const name = personNames.get(person);
    const empty = averages.length === 0;
    chart.hidden = empty;
    trendEmpty.hidden = !empty;
    trendPoint.hidden = empty;
    plot = null;
    if (empty) {
      trendEmpty.textContent = complete ? `${name}本月没有测量记录。` : "本机暂无本月趋势数据。";
      return;
    }

    const selected = averages.find(({ day }) => day === selectedDay);
    const summary = selected
      ? series.map(({ key, label, unit }) => selected[key] === null
        ? `${label}未填`
        : `${label} ${selected[key]} ${unit}`).join(" · ")
      : "当天没有测量记录";
    const message = `${monthNumber}月${selectedDay}日 · ${name} · ${summary}`;
    if (trendPoint.textContent !== message) trendPoint.textContent = message;
    plot = paintTrend(chart, averages, selectedDay, lastDay);
  }

  function show(value, date, items, isComplete) {
    if (month !== value) buildCalendar(value);
    rows = items;
    complete = isComplete;
    selectedDay = dayNumber(date);

    const counts = new Map();
    for (const { date } of rows) counts.set(date, (counts.get(date) ?? 0) + 1);
    for (const [index, button] of dayButtons.entries()) {
      const day = index + 1;
      const count = counts.get(`${month}-${String(day).padStart(2, "0")}`) ?? 0;
      button.classList.toggle("has-readings", count > 0);
      button.setAttribute("aria-pressed", String(day === selectedDay));
      const label = count ? `${count} 条记录` : complete ? "无记录" : "本机暂无记录";
      button.setAttribute("aria-label", `${monthNumber}月${day}日，${label}`);
    }

    const visible = rows.filter((row) => row.date === date);
    byId("history-day-title").textContent = dateFormat.format(new Date(`${date}T00:00:00Z`));
    byId("history-status").textContent = visible.length ? `共 ${visible.length} 条` : "";
    const empty = byId("history-empty");
    empty.hidden = visible.length > 0;
    empty.textContent = complete ? "当天没有测量记录。" : "本机暂无当天记录，联网后会同步。";
    list.hidden = visible.length === 0;
    list.replaceChildren(...visible.map(renderRecord));
    renderTrend();
  }

  function chooseDay(day) {
    selectDay(`${month}-${String(day).padStart(2, "0")}`);
  }

  byId("previous-month").addEventListener("click", () => changeMonth(-1));
  byId("next-month").addEventListener("click", () => changeMonth(1));
  calendar.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-day]");
    if (button) chooseDay(Number(button.dataset.day));
  });
  for (const button of personButtons) {
    button.addEventListener("click", () => {
      person = button.dataset.trendPerson;
      for (const item of personButtons) item.setAttribute("aria-pressed", String(item === button));
      renderTrend();
    });
  }
  chart.addEventListener("click", (event) => {
    if (!plot) return;
    const position = event.clientX - chart.getBoundingClientRect().left;
    if (position < plot.left - 6 || position > plot.right + 6) return;
    const fraction = Math.max(0, Math.min(1, (position - plot.left) / (plot.right - plot.left)));
    chooseDay(Math.round(fraction * (plot.lastDay - 1)) + 1);
  });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(renderTrend).observe(byId("trend-title").closest(".history-trend"));
  } else {
    window.addEventListener("resize", renderTrend);
  }

  return {
    show,
    clear() {
      month = "";
      rows = [];
      dayButtons = [];
      plot = null;
      calendar.replaceChildren();
      list.replaceChildren();
      trendPoint.textContent = "";
      chart.width = 0;
    },
  };
}
