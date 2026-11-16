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

// 单次读数的提示沿用趋势视图的家庭血压界限，不作为诊断。
export function classifyReading({ systolic, diastolic }) {
  if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return [{ kind: "unknown", label: "无法判断" }];
  const high = [], low = [];
  if (systolic >= 135) high.push("高压");
  else if (systolic < 90) low.push("高压");
  if (diastolic >= 85) high.push("低压");
  else if (diastolic < 60) low.push("低压");
  const labels = [];
  if (high.length) labels.push({ kind: "high", label: `${high.length === 2 ? "高低压" : high[0]}偏高` });
  if (low.length) labels.push({ kind: "low", label: `${low.length === 2 ? "高低压" : low[0]}偏低` });
  return labels.length ? labels : [{ kind: "normal", label: "正常" }];
}

export function summarizeMonth(rows, person, period = "月") {
  const readings = rows.map(({ trend }) => trend).filter((record) => record?.person === person);
  if (!readings.length) return null;

  const mean = (key) => readings.reduce((sum, record) => sum + record[key], 0) / readings.length;
  const systolic = mean("systolic");
  const diastolic = mean("diastolic");
  const above = systolic >= 135 || diastolic >= 85;
  const below = systolic < 90 || diastolic < 60;
  let kind = "normal";
  let label = "正常";
  if (above && below) {
    kind = "mixed";
    label = "高低压差异大，测量数据可能有误";
  } else if (above) {
    kind = "high";
    label = `${period}均偏高`;
  } else if (below) {
    kind = "low";
    label = `${period}均偏低`;
  }
  return { kind, label, count: readings.length, systolic, diastolic };
}

function dailyAverages(rows, person, start) {
  const days = new Map();
  for (const { date, trend } of rows) {
    if (trend?.person !== person) continue;
    const day = Math.round((Date.parse(`${date}T00:00:00Z`) - start.valueOf()) / 86400000) + 1;
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

function paintTrend(chart, averages, selectedDay, lastDay, weekly) {
  const context = chart.getContext("2d");
  const { width, height } = chart.getBoundingClientRect();
  if (!context || !width || !height) return null;

  const ratio = window.devicePixelRatio || 1;
  chart.width = Math.round(width * ratio);
  chart.height = Math.round(height * ratio);
  context.scale(ratio, ratio);

  const values = averages.flatMap((point) => series.map(({ key }) => point[key]).filter(Number.isFinite));
  // 固定包含两段参考带，并在读数超出时自动扩展纵轴。
  const smallest = Math.min(60, ...values);
  const largest = Math.max(160, ...values);
  const step = Math.max(20, Math.ceil((largest - smallest) / 120) * 20);
  const min = Math.max(0, Math.floor(smallest / step) * step);
  const max = Math.ceil(largest / step) * step;
  const left = 35;
  const right = width - 78;
  const top = 13;
  const bottom = height - 24;
  const x = (day) => left + (day - 1) / (lastDay - 1) * (right - left);
  const y = (value) => bottom - (value - min) / (max - min) * (bottom - top);

  // 上边界为偏高阈值，区间含下限、不含上限。
  const bands = [
    { low: 90, high: 135, color: "rgba(180, 69, 56, 0.10)", ink: "#a42d27", name: "高压参考区间", bounds: "90–<135" },
    { low: 60, high: 85, color: "rgba(8, 123, 230, 0.10)", ink: "#205e9f", name: "低压参考区间", bounds: "60–<85" },
  ];
  for (const band of bands) {
    context.fillStyle = band.color;
    context.fillRect(left, y(band.high), right - left, y(band.low) - y(band.high));
  }
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
  for (const day of weekly ? [1, 2, 3, 4, 5, 6, 7] : [1, 5, 10, 15, 20, 25, lastDay]) {
    context.fillText(weekly ? ["一", "二", "三", "四", "五", "六", "日"][day - 1] : day, x(day), bottom + 15);
  }

  if (averages.length) {
    context.strokeStyle = "#9eafa6";
    context.setLineDash([4, 4]);
    context.beginPath();
    context.moveTo(x(selectedDay), top);
    context.lineTo(x(selectedDay), bottom);
    context.stroke();
    context.setLineDash([]);
  }

  for (const band of bands) {
    const middle = (y(band.low) + y(band.high)) / 2;
    context.font = "10px system-ui";
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillStyle = band.ink;
    context.fillText(band.name.slice(0, 2), right + 5, middle - 10);
    context.fillText(band.name.slice(2), right + 5, middle + 1);
    context.fillText(band.bounds, right + 5, middle + 12);
  }
  context.lineJoin = "round";
  context.lineCap = "round";
  const chartStyle = getComputedStyle(chart);
  for (const { key } of series) {
    const color = chartStyle.getPropertyValue(`--trend-${key}`).trim();
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 2.3;
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
  // 周视图的数据点较少，直接标注当天平均值，方便在手机上查看。
  if (weekly) {
    context.font = "600 11px system-ui";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineWidth = 3;
    context.lineJoin = "round";
    context.strokeStyle = "#fff";
    const placed = [];
    const segments = [];
    const points = [];
    for (const { key } of series) {
      let previous = null;
      for (const point of averages) {
        if (point[key] === null) { previous = null; continue; }
        const current = { x: x(point.day), y: y(point[key]) };
        points.push(current);
        if (previous) segments.push({ from: previous, to: current });
        previous = current;
      }
    }
    // 检查标签包围盒与每条线段及数据点，避免白色描边盖住折线。
    function overlapsLine(box) {
      if (points.some((point) => point.x >= box.left - 5 && point.x <= box.right + 5 &&
          point.y >= box.top - 5 && point.y <= box.bottom + 5)) return true;
      return segments.some(({ from, to }) => {
        const left = Math.max(box.left - 2, Math.min(from.x, to.x));
        const right = Math.min(box.right + 2, Math.max(from.x, to.x));
        if (left > right) return false;
        const lineY = (px) => from.y + (to.y - from.y) * (px - from.x) / (to.x - from.x);
        const y1 = lineY(left), y2 = lineY(right);
        return Math.max(y1, y2) >= box.top - 2 && Math.min(y1, y2) <= box.bottom + 2;
      });
    }
    for (const point of averages) {
      for (const { key } of series) {
        if (point[key] === null) continue;
        const label = String(point[key]);
        const halfWidth = context.measureText(label).width / 2 + 2;
        const px = x(point.day), py = y(point[key]);
        const candidates = [];
        for (const dy of [-12, 12, -24, 24, -36, 36, -48, 48, -60, 60]) {
          for (const dx of [0, -10, 10, -20, 20]) {
            const lx = Math.max(halfWidth + 2, Math.min(right - halfWidth + 5, px + dx));
            const ly = Math.max(7, Math.min(bottom - 6, py + dy));
            const box = { left: lx - halfWidth, right: lx + halfWidth, top: ly - 6, bottom: ly + 6 };
            const collides = placed.some((other) => box.left < other.right + 2 && box.right > other.left - 2 &&
              box.top < other.bottom + 1 && box.bottom > other.top - 1);
            candidates.push({ lx, ly, box, score: (overlapsLine(box) ? 10000 : 0) + (collides ? 10000 : 0) + Math.abs(dy) + Math.abs(dx) });
          }
        }
        candidates.sort((a, b) => a.score - b.score);
        const { lx, ly, box } = candidates[0];
        placed.push(box);
        context.fillStyle = chartStyle.getPropertyValue(`--trend-${key}`).trim();
        context.strokeText(label, lx, ly);
        context.fillText(label, lx, ly);
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
  let range = "week";
  let extra = [];
  let extraComplete = {};
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
    const selectedDate = new Date(`${month}-${String(selectedDay).padStart(2, "0")}T00:00:00Z`);
    const start = new Date(selectedDate);
    if (range === "week") start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
    else start.setUTCDate(1);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + (range === "week" ? 6 : lastDay - 1));
    const dateKey = (date) => date.toISOString().slice(0, 10);
    const formatDate = (date) => `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
    const spanning = start.toISOString().slice(0, 7) !== end.toISOString().slice(0, 7);
    const rangeComplete = complete && (!spanning || range !== "week" || Boolean(extraComplete[start.toISOString().slice(0, 7) === month ? end.toISOString().slice(0, 7) : start.toISOString().slice(0, 7)]));
    const rangeRows = (range === "week" ? rows.concat(extra) : rows).filter(({ date }) => date >= dateKey(start) && date <= dateKey(end));
    const averages = dailyAverages(rangeRows, person, start);
    const selectedIndex = Math.round((selectedDate - start) / 86400000) + 1;
    const period = range === "week" ? "周" : "月";
    byId("trend-title").textContent = range === "week" ? "周度趋势" : "月度趋势";
    byId("trend-date-range").textContent = `${formatDate(start)} — ${formatDate(end)}`;
    chart.setAttribute("aria-label", `高压、低压和脉搏的${period}度趋势图`);
    const name = personNames.get(person);
    const status = byId("monthly-status");
    const monthlySummary = byId("monthly-summary");
    const monthly = summarizeMonth(rangeRows, person, period);
    status.hidden = false;
    monthlySummary.hidden = !monthly || !rangeComplete;
    if (!rangeComplete) {
      status.className = "monthly-status empty";
      status.textContent = "数据未同步";
      monthlySummary.textContent = "";
    } else if (!monthly) {
      status.className = "monthly-status empty";
      status.textContent = "暂无数据";
      monthlySummary.textContent = "";
    } else {
      status.className = `monthly-status ${monthly.kind}`;
      status.textContent = monthly.label;
      const format = (value) => Number(value.toFixed(1)).toString();
      monthlySummary.textContent = `本${period} ${monthly.count} 次测量 · ${period}均 ${format(monthly.systolic)} / ${format(monthly.diastolic)} mmHg`;
    }
    const empty = averages.length === 0;
    chart.hidden = false;
    trendEmpty.hidden = !empty;
    trendPoint.hidden = empty;
    plot = null;
    if (empty) {
      trendEmpty.textContent = rangeComplete ? `${name}本${period}没有测量记录。` : `本机暂无完整的本${period}趋势数据。`;
      paintTrend(chart, averages, selectedIndex, range === "week" ? 7 : lastDay, range === "week");
      return;
    }

    const selected = averages.find(({ day }) => day === selectedIndex);
    const summary = selected
      ? series.map(({ key, label, unit }) => selected[key] === null
        ? `${label}未填`
        : `${label} ${selected[key]} ${unit}`).join(" · ")
      : "当天没有测量记录";
    const message = `${monthNumber}月${selectedDay}日 · ${name} · ${summary}`;
    if (trendPoint.textContent !== message) trendPoint.textContent = message;
    plot = paintTrend(chart, averages, selectedIndex, range === "week" ? 7 : lastDay, range === "week");
  }

  function show(value, date, items, isComplete, adjacent = [], adjacentComplete = {}) {
    if (month !== value) buildCalendar(value);
    rows = items;
    extra = adjacent;
    extraComplete = adjacentComplete;
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
  function setRange(value) {
    range = value;
    for (const item of document.querySelectorAll("[data-trend-range]")) {
      item.setAttribute("aria-pressed", String(item.dataset.trendRange === range));
    }
    renderTrend();
  }
  for (const button of document.querySelectorAll("[data-trend-range]")) {
    button.addEventListener("click", () => setRange(button.dataset.trendRange));
  }
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
    const index = Math.round(fraction * (plot.lastDay - 1));
    const date = new Date(`${month}-${String(selectedDay).padStart(2, "0")}T00:00:00Z`);
    if (range === "week") date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7 + index);
    else date.setUTCDate(index + 1);
    selectDay(date.toISOString().slice(0, 10));
  });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(renderTrend).observe(byId("trend-title").closest(".history-trend"));
  } else {
    window.addEventListener("resize", renderTrend);
  }

  return {
    show,
    setRange,
    clear() {
      month = "";
      rows = [];
      dayButtons = [];
      plot = null;
      calendar.replaceChildren();
      list.replaceChildren();
      trendPoint.textContent = "";
      byId("monthly-status").hidden = true;
      byId("monthly-summary").hidden = true;
      byId("monthly-summary").textContent = "";
      chart.width = 0;
    },
  };
}
