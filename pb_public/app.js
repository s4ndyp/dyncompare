const PERIODS = {
  day: { label: "Laatste 24 uur", days: 1, hours: 24, syncDays: 1 },
  week: { label: "Laatste 7 dagen", days: 7, syncDays: 7 },
  month: { label: "Afgelopen maand", days: 31, syncDays: 31 },
  halfyear: { label: "Afgelopen 6 maanden", days: 183, syncDays: 183 },
  year: { label: "Afgelopen jaar", days: 366, syncDays: 366 },
};

const STATS_HISTORY_DAYS = 730;

const AMS_TZ = "Europe/Amsterdam";

function amsterdamYearMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AMS_TZ,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === "year").value);
  const month = Number(parts.find((p) => p.type === "month").value);
  return { year, month };
}

function amsterdamCalendarParts(date = new Date()) {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: AMS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const [year, month, day] = key.split("-").map(Number);
  return { year, month, day };
}

function amsterdamLocalToDate(year, month, day, hour = 0, minute = 0, second = 0) {
  let t = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 5; i++) {
    const d = new Date(t);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: AMS_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
        .formatToParts(d)
        .map((p) => [p.type, p.value])
    );
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    const actual = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const diffMs = target - actual;
    if (diffMs === 0) return d;
    t += diffMs;
  }
  return new Date(t);
}

function amsterdamDaysFromMonday(date) {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: AMS_TZ, weekday: "short" }).format(date);
  const map = { Sun: 6, Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5 };
  return map[w] ?? 0;
}

function addAmsterdamCalendarDays({ year, month, day }, deltaDays) {
  const anchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  anchor.setUTCDate(anchor.getUTCDate() + deltaDays);
  return amsterdamCalendarParts(anchor);
}

function amsterdamWeekStart(date = new Date()) {
  const today = amsterdamCalendarParts(date);
  const anchor = amsterdamLocalToDate(today.year, today.month, today.day, 12, 0);
  const fromMon = amsterdamDaysFromMonday(anchor);
  return addAmsterdamCalendarDays(today, -fromMon);
}

function weekRangeLabel(weekStart) {
  const end = addAmsterdamCalendarDays(weekStart, 6);
  const fmt = new Intl.DateTimeFormat("nl-NL", {
    timeZone: AMS_TZ,
    day: "numeric",
    month: "short",
  });
  const startD = amsterdamLocalToDate(weekStart.year, weekStart.month, weekStart.day, 12, 0);
  const endD = amsterdamLocalToDate(end.year, end.month, end.day, 12, 0);
  const year = new Intl.DateTimeFormat("nl-NL", { timeZone: AMS_TZ, year: "numeric" }).format(startD);
  return `${fmt.format(startD)} – ${fmt.format(endD)} ${year}`;
}

function isInAmsterdamWeek(date, weekStart) {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: AMS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  for (let i = 0; i < 7; i++) {
    const d = addAmsterdamCalendarDays(weekStart, i);
    const dk = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
    if (key === dk) return true;
  }
  return false;
}

const state = {
  view: "compare",
  period: "month",
  settings: null,
  consumption: [],
  prices: [],
  chartMonth: amsterdamYearMonth(),
  chartGranularity: "month",
  chartWeekStart: amsterdamWeekStart(),
  chartConsumption: [],
  chartPrices: [],
  statsConsumption: [],
  statsPrices: [],
  priceChart: null,
  diffChart: null,
  loading: false,
  syncing: false,
  syncPollId: null,
  syncStartedAt: null,
  exportBusy: false,
  importBusy: false,
};

const PRICE_SLOT_SOURCES = new Set(["market", "home_assistant", "manual"]);

/** Tarieven uit Instellingen zijn all-in (incl. BTW); geen extra BTW in berekeningen. */
function applyTariffAmount(n) {
  return n;
}

const SETTINGS_IMPORT_FIELDS = [
  "label",
  "fixed_tariff_eur_kwh",
  "export_tariff_eur_kwh",
  "market_markup_eur_kwh",
  "sensor_import_t1",
  "sensor_import_t2",
  "sensor_export_t1",
  "sensor_export_t2",
  "price_statistic_id",
  "market_sync_missing_only",
  "include_export_in_avg",
  "sync_include_ha",
  "ha_url",
];

const appEl = document.getElementById("app");
const pageTitle = document.getElementById("pageTitle");
const periodLabel = document.getElementById("periodLabel");
const refreshBtn = document.getElementById("refreshBtn");
const syncBanner = document.getElementById("syncBanner");
const syncBannerTitle = document.getElementById("syncBannerTitle");
const syncBannerDetail = document.getElementById("syncBannerDetail");

function toast(message, durationMs = 3200) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}

function formatSyncElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

function formatSyncTimestamp(value) {
  const d = parsePbDate(value);
  if (!d) return "—";
  return new Intl.DateTimeFormat("nl-NL", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

function setSyncBanner(mode, title, detail) {
  if (!syncBanner) return;
  syncBanner.classList.remove("is-hidden", "is-ok", "is-error");
  if (mode === "hidden") {
    syncBanner.classList.add("is-hidden");
    syncBanner.setAttribute("aria-busy", "false");
    return;
  }
  if (mode === "ok") syncBanner.classList.add("is-ok");
  if (mode === "error") syncBanner.classList.add("is-error");
  syncBanner.setAttribute("aria-busy", mode === "busy" ? "true" : "false");
  if (syncBannerTitle) syncBannerTitle.textContent = title;
  if (syncBannerDetail) syncBannerDetail.textContent = detail || "";
}

function syncIncludeHa() {
  return state.settings?.sync_include_ha !== false;
}

function syncPrimaryButtonLabel() {
  return syncIncludeHa() ? "Synchroniseer met Home Assistant" : "Alleen marktprijzen ophalen";
}

function setSyncControlsDisabled(disabled) {
  if (refreshBtn) refreshBtn.disabled = disabled;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.disabled = disabled;
  });
  const syncBtn = document.getElementById("syncBtn");
  if (syncBtn) {
    syncBtn.disabled = disabled;
    syncBtn.textContent = disabled ? "Bezig met synchroniseren…" : syncPrimaryButtonLabel();
  }
}

function stopSyncPoll() {
  if (state.syncPollId != null) {
    clearInterval(state.syncPollId);
    state.syncPollId = null;
  }
}

function startSyncPoll() {
  stopSyncPoll();
  state.syncPollId = setInterval(async () => {
    if (!state.syncing) return;
    try {
      await loadSettings();
      const msg = (state.settings?.last_sync_message || "").trim();
      const elapsed = formatSyncElapsed(Date.now() - (state.syncStartedAt || Date.now()));
      const detail = msg.startsWith("Bezig:")
        ? `${msg} (${elapsed})`
        : `Nog bezig… (${elapsed})`;
      setSyncBanner("busy", "Synchroniseren", detail);
    } catch (_) {
      /* poll mag falen zonder sync te stoppen */
    }
  }, 2000);
}

function euro(n, digits = 2) {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

function kwh(n, digits = 1) {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)} kWh`;
}

function parsePbDate(value) {
  if (!value) return null;
  const raw = String(value).replace(" ", "T");
  const d = new Date(raw.endsWith("Z") ? raw : `${raw}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function pbRequest(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err.message || err.detail ? `: ${err.message || err.detail}` : "";
    } catch (_) { /* ignore */ }
    throw new Error(`PocketBase ${res.status}${detail}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function listAll(collection, params = {}) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  do {
    const q = new URLSearchParams({
      page: String(page),
      perPage: "500",
      ...params,
    });
    const data = await pbRequest(`/api/collections/${collection}/records?${q}`);
    items.push(...(data.items || []));
    totalPages = data.totalPages || 1;
    page += 1;
  } while (page <= totalPages);
  return items;
}

function periodStartDate() {
  const period = PERIODS[state.period];
  const end = new Date();
  const start = new Date(end);
  if (period.hours) {
    start.setTime(end.getTime() - period.hours * 3600_000);
    return start;
  }
  start.setUTCDate(start.getUTCDate() - period.days);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

function syncDaysForPeriod() {
  const period = PERIODS[state.period];
  return Math.max(1, period.syncDays ?? period.days ?? 1);
}

function periodSegmentLabel(key, period) {
  if (key === "day") return "24 uur";
  if (key === "week") return "7 dagen";
  return period.label.replace("Laatste ", "").replace("Afgelopen ", "");
}

function pbFilterFrom(date) {
  const iso = date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
  return iso.slice(0, 19).replace("T", " ");
}

const DEFAULT_SETTINGS = {
  label: "Standaard",
  fixed_tariff_eur_kwh: 0.28,
  export_tariff_eur_kwh: 0.1,
  market_markup_eur_kwh: 0,
  vat_rate: 0,
  sensor_import_t1: "sensor.p1_energy_consumption_tarif_1",
  sensor_import_t2: "sensor.p1_energy_consumption_tarif_2",
  sensor_export_t1: "sensor.p1_energy_production_tarif_1",
  sensor_export_t2: "sensor.p1_energy_production_tarif_2",
};

async function loadSettings() {
  let rows = await listAll("settings", { sort: "id" });
  if (!rows.length) {
    const created = await pbRequest("/api/collections/settings/records", {
      method: "POST",
      body: JSON.stringify(DEFAULT_SETTINGS),
    });
    rows = [created];
  }
  state.settings = rows[0] || null;
}

async function loadData() {
  const from = periodStartDate();
  const filter = `period_start >= "${pbFilterFrom(from)}"`;
  state.consumption = await listAll("consumption_hours", {
    filter,
    sort: "period_start",
  });
  state.prices = await listAll("price_slots", {
    filter,
    sort: "period_start",
  });
}

async function loadMonthData(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  const filter = `period_start >= "${pbFilterFrom(start)}" && period_start < "${pbFilterFrom(end)}"`;
  state.chartConsumption = await listAll("consumption_hours", {
    filter,
    sort: "period_start",
  });
  state.chartPrices = await listAll("price_slots", {
    filter,
    sort: "period_start",
  });
}

async function loadWeekData(weekStart) {
  const weekEndStart = addAmsterdamCalendarDays(weekStart, 7);
  const start = amsterdamLocalToDate(weekStart.year, weekStart.month, weekStart.day, 0, 0);
  const end = amsterdamLocalToDate(weekEndStart.year, weekEndStart.month, weekEndStart.day, 0, 0);
  const filter = `period_start >= "${pbFilterFrom(start)}" && period_start < "${pbFilterFrom(end)}"`;
  state.chartConsumption = await listAll("consumption_hours", {
    filter,
    sort: "period_start",
  });
  state.chartPrices = await listAll("price_slots", {
    filter,
    sort: "period_start",
  });
}

async function loadChartRangeData() {
  if (state.chartGranularity === "week") {
    await loadWeekData(state.chartWeekStart);
  } else {
    await loadMonthData(state.chartMonth.year, state.chartMonth.month);
  }
}

function chartRangeTitle() {
  if (state.chartGranularity === "week") {
    return weekRangeLabel(state.chartWeekStart);
  }
  return monthLabel(state.chartMonth.year, state.chartMonth.month);
}

function monthLabel(year, month) {
  return new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 15)));
}

function isInAmsterdamMonth(date, year, month) {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
  }).format(date);
  return key === `${year}-${String(month).padStart(2, "0")}`;
}

function buildMarketOnlyIndex(priceRows) {
  const market = priceRows.filter((p) => p.source === "market");
  return buildPriceIndex(market.length ? market : priceRows);
}

function hourlyMarketRateEurKwh(hourStartMs, priceSlots) {
  return priceForHour(hourStartMs, 1, priceSlots);
}

function collectChartHourStarts(consumption, prices, year, month) {
  const keys = new Set();
  const addRow = (row) => {
    const start = parsePbDate(row.period_start);
    if (!start || !isInAmsterdamMonth(start, year, month)) return;
    const hour = new Date(start);
    hour.setUTCMinutes(0, 0, 0);
    keys.add(hour.getTime());
  };
  consumption.forEach(addRow);
  prices.forEach(addRow);
  return [...keys].sort((a, b) => a - b);
}

function calcChartContext() {
  const settings = state.settings || {};
  const fixed = Number(settings.fixed_tariff_eur_kwh ?? 0.28);
  const markup = Number(settings.market_markup_eur_kwh ?? 0);
  return {
    fixed,
    markup,
    applyVat: applyTariffAmount,
    priceSlots: buildPriceIndex(state.chartPrices || []),
  };
}

function buildWeekCostPoints(weekStart) {
  const ctx = calcChartContext();
  const { fixed, markup, applyVat, priceSlots } = ctx;
  const points = [];

  for (const row of state.chartConsumption || []) {
    const start = parsePbDate(row.period_start);
    if (!start || !isInAmsterdamWeek(start, weekStart)) continue;
    const kwh = importKwh(row);
    if (kwh <= 0) continue;
    const ms = start.getTime();
    const energyCost = priceForHour(ms, kwh, priceSlots);
    if (energyCost == null) continue;

    const fixedCost = applyVat(kwh * fixed);
    const dynamicCost = applyVat(energyCost + kwh * markup);
    points.push({
      ms,
      label: formatHourLabel(start),
      kwh,
      fixedCost,
      dynamicCost,
      diffEur: fixedCost - dynamicCost,
    });
  }

  points.sort((a, b) => a.ms - b.ms);
  return points;
}

function buildMonthChartPoints(year, month) {
  const ctx = calcChartContext();
  const fixedAllIn = ctx.applyVat(ctx.fixed);
  const slots = buildMarketOnlyIndex(state.chartPrices || []);
  const hours = collectChartHourStarts(
    state.chartConsumption || [],
    state.chartPrices || [],
    year,
    month
  );
  return hours
    .map((ms) => {
      const raw = hourlyMarketRateEurKwh(ms, slots);
      if (raw == null) return null;
      const market = ctx.applyVat(raw + ctx.markup);
      return {
        ms,
        label: formatHourLabel(new Date(ms)),
        market,
        fixed: fixedAllIn,
        diff: fixedAllIn - market,
      };
    })
    .filter(Boolean);
}

function destroyCharts() {
  if (state.priceChart) {
    state.priceChart.destroy();
    state.priceChart = null;
  }
  if (state.diffChart) {
    state.diffChart.destroy();
    state.diffChart = null;
  }
}

const chartFixedShadePlugin = {
  id: "fixedPriceShade",
  beforeDatasetsDraw(chart, _args, opts) {
    const fixed = opts?.fixedPrice;
    if (!Number.isFinite(fixed)) return;
    const { ctx, chartArea, scales } = chart;
    const yFixed = scales.y.getPixelForValue(fixed);
    const top = chartArea.top;
    const bottom = chartArea.bottom;
    ctx.save();
    ctx.fillStyle = "rgba(251, 146, 60, 0.22)";
    ctx.fillRect(chartArea.left, top, chartArea.width, Math.max(0, yFixed - top));
    ctx.fillStyle = "rgba(74, 222, 128, 0.22)";
    ctx.fillRect(chartArea.left, yFixed, chartArea.width, Math.max(0, bottom - yFixed));
    ctx.restore();
  },
};

function mountCharts() {
  if (typeof Chart === "undefined") {
    toast("Grafiek-library niet geladen");
    return;
  }
  if (state.chartGranularity === "week") {
    mountWeekCharts();
    return;
  }
  mountMonthCharts();
}

function mountMonthCharts() {
  const points = buildMonthChartPoints(state.chartMonth.year, state.chartMonth.month);
  const priceCanvas = document.getElementById("priceChartCanvas");
  const diffCanvas = document.getElementById("diffChartCanvas");
  if (!priceCanvas || !diffCanvas || !points.length) return;

  const labels = points.map((p) => p.label);
  const marketData = points.map((p) => p.market);
  const fixedData = points.map((p) => p.fixed);
  const diffData = points.map((p) => p.diff);

  const commonX = {
    ticks: { color: "#9aa3b8", maxTicksLimit: 8, font: { size: 10 } },
    grid: { color: "rgba(42,49,66,0.6)" },
  };
  const commonY = {
    ticks: { color: "#9aa3b8", font: { size: 10 } },
    grid: { color: "rgba(42,49,66,0.6)" },
  };

  state.priceChart = new Chart(priceCanvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Markt day-ahead",
          data: marketData,
          borderColor: "#7c9cff",
          backgroundColor: "rgba(124,156,255,0.08)",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.15,
        },
        {
          label: "Vast (all-in)",
          data: fixedData,
          borderColor: "#f4f6fb",
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        fixedPriceShade: { fixedPrice: fixedData[0] },
        tooltip: {
          callbacks: {
            label(ctx) {
              return `${ctx.dataset.label}: ${euro(ctx.parsed.y, 4)}/kWh`;
            },
          },
        },
      },
      scales: {
        x: commonX,
        y: {
          ...commonY,
          title: { display: true, text: "€/kWh", color: "#9aa3b8", font: { size: 11 } },
        },
      },
    },
    plugins: [chartFixedShadePlugin],
  });

  state.diffChart = new Chart(diffCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Verschil vast − markt",
          data: diffData,
          backgroundColor: diffData.map((d) =>
            d >= 0 ? "rgba(74, 222, 128, 0.75)" : "rgba(251, 146, 60, 0.75)"
          ),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = ctx.parsed.y;
              return `${v >= 0 ? "+" : ""}${euro(v, 4)}/kWh (positief = markt goedkoper)`;
            },
          },
        },
      },
      scales: {
        x: commonX,
        y: {
          ...commonY,
          title: { display: true, text: "€/kWh verschil", color: "#9aa3b8", font: { size: 11 } },
        },
      },
    },
  });
}

function mountWeekCharts() {
  const points = buildWeekCostPoints(state.chartWeekStart);
  const priceCanvas = document.getElementById("priceChartCanvas");
  const diffCanvas = document.getElementById("diffChartCanvas");
  if (!priceCanvas || !diffCanvas || !points.length) return;

  const labels = points.map((p) => p.label);
  const fixedCosts = points.map((p) => p.fixedCost);
  const dynamicCosts = points.map((p) => p.dynamicCost);
  const diffEur = points.map((p) => p.diffEur);

  const commonX = {
    ticks: { color: "#9aa3b8", maxTicksLimit: 14, font: { size: 9 }, autoSkip: true },
    grid: { color: "rgba(42,49,66,0.6)" },
  };
  const commonY = {
    ticks: { color: "#9aa3b8", font: { size: 10 } },
    grid: { color: "rgba(42,49,66,0.6)" },
  };

  state.priceChart = new Chart(priceCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Kosten vast",
          data: fixedCosts,
          backgroundColor: "rgba(244, 246, 251, 0.55)",
          borderColor: "rgba(244, 246, 251, 0.9)",
          borderWidth: 1,
        },
        {
          label: "Kosten dynamisch",
          data: dynamicCosts,
          backgroundColor: "rgba(124, 156, 255, 0.75)",
          borderColor: "#7c9cff",
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              return `${ctx.dataset.label}: ${euro(ctx.parsed.y, 3)}`;
            },
            afterBody(items) {
              const i = items[0]?.dataIndex;
              if (i == null || !points[i]) return [];
              return [`Verbruik: ${kwh(points[i].kwh, 2)}`];
            },
          },
        },
      },
      scales: {
        x: commonX,
        y: {
          ...commonY,
          title: { display: true, text: "€ per uur", color: "#9aa3b8", font: { size: 11 } },
        },
      },
    },
  });

  state.diffChart = new Chart(diffCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Verschil vast − dynamisch",
          data: diffEur,
          backgroundColor: diffEur.map((d) =>
            d >= 0 ? "rgba(74, 222, 128, 0.75)" : "rgba(251, 146, 60, 0.75)"
          ),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const v = ctx.parsed.y;
              return `${v >= 0 ? "+" : ""}${euro(v, 3)} (positief = dynamisch goedkoper)`;
            },
          },
        },
      },
      scales: {
        x: commonX,
        y: {
          ...commonY,
          title: { display: true, text: "€ verschil per uur", color: "#9aa3b8", font: { size: 11 } },
        },
      },
    },
  });
}

function shiftChartMonth(delta) {
  let { year, month } = state.chartMonth;
  month += delta;
  if (month > 12) {
    month = 1;
    year += 1;
  } else if (month < 1) {
    month = 12;
    year -= 1;
  }
  state.chartMonth = { year, month };
}

function shiftChartWeek(deltaWeeks) {
  state.chartWeekStart = addAmsterdamCalendarDays(state.chartWeekStart, deltaWeeks * 7);
}

async function refreshChartView() {
  state.loading = true;
  try {
    await loadSettings();
    await loadChartRangeData();
  } catch (e) {
    toast(e.message);
  } finally {
    state.loading = false;
    render();
  }
}

function importKwh(row) {
  return (row.import_t1_kwh || 0) + (row.import_t2_kwh || 0);
}

function exportKwh(row) {
  return (row.export_t1_kwh || 0) + (row.export_t2_kwh || 0);
}

function buildPriceIndex(priceRows) {
  const slots = priceRows
    .map((p) => ({
      start: parsePbDate(p.period_start)?.getTime(),
      minutes: p.interval_minutes || 60,
      price: Number(p.price_eur_kwh),
      source: p.source,
    }))
    .filter((p) => p.start != null && Number.isFinite(p.price))
    .sort((a, b) => a.start - b.start);

  // Combineer markt (Energy-Charts) en HA: per tijdstip wint HA, rest vult gaten.
  const byStart = new Map();
  for (const slot of slots) {
    const existing = byStart.get(slot.start);
    if (!existing || slot.source === "home_assistant") {
      byStart.set(slot.start, slot);
    }
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

function priceSourceCounts(priceRows) {
  const counts = { market: 0, home_assistant: 0, manual: 0, other: 0 };
  for (const row of priceRows) {
    const key = row.source in counts ? row.source : "other";
    counts[key] += 1;
  }
  return counts;
}

function priceForHour(hourStartMs, hourKwh, priceSlots) {
  const hourEnd = hourStartMs + 3600_000;
  const overlapping = priceSlots.filter((s) => {
    const slotEnd = s.start + s.minutes * 60_000;
    return s.start < hourEnd && slotEnd > hourStartMs;
  });
  if (!overlapping.length) return null;

  let cost = 0;
  let weightedMinutes = 0;
  for (const slot of overlapping) {
    const slotEnd = slot.start + slot.minutes * 60_000;
    const overlapStart = Math.max(hourStartMs, slot.start);
    const overlapEnd = Math.min(hourEnd, slotEnd);
    const overlapMin = Math.max(0, overlapEnd - overlapStart) / 60_000;
    if (overlapMin <= 0) continue;
    const share = overlapMin / 60;
    cost += hourKwh * share * slot.price;
    weightedMinutes += overlapMin;
  }
  if (weightedMinutes <= 0) return null;
  return cost;
}

function calcContext() {
  const settings = state.settings || {};
  const fixed = Number(settings.fixed_tariff_eur_kwh ?? 0.28);
  const exportFixed = Number(settings.export_tariff_eur_kwh ?? 0);
  const markup = Number(settings.market_markup_eur_kwh ?? 0);
  return {
    fixed,
    exportFixed,
    markup,
    applyVat: applyTariffAmount,
    priceSlots: buildPriceIndex(state.prices),
  };
}

function isExportInAvg() {
  return Boolean(state.settings?.include_export_in_avg);
}

function formatHourLabel(date) {
  return new Intl.DateTimeFormat("nl-NL", {
    timeZone: "Europe/Amsterdam",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function computeHourlyRows(limit = 200) {
  const ctx = calcContext();
  const rows = [];

  for (const row of state.consumption) {
    const start = parsePbDate(row.period_start);
    if (!start) continue;
    const kwh = importKwh(row);
    if (kwh <= 0) continue;

    const fixedCost = ctx.applyVat(kwh * ctx.fixed);
    const energyCost = priceForHour(start.getTime(), kwh, ctx.priceSlots);
    if (energyCost == null) {
      rows.push({
        start,
        label: formatHourLabel(start),
        kwh,
        fixedEurKwh: ctx.applyVat(ctx.fixed),
        dynamicEurKwh: null,
        delta: null,
        missingPrice: true,
      });
      continue;
    }

    const dynamicCost = ctx.applyVat(energyCost + kwh * ctx.markup);
    const dynamicEurKwh = dynamicCost / kwh;
    const fixedEurKwh = fixedCost / kwh;
    const delta = fixedCost - dynamicCost;

    rows.push({
      start,
      label: formatHourLabel(start),
      kwh,
      fixedEurKwh,
      dynamicEurKwh,
      delta,
      missingPrice: false,
    });
  }

  rows.sort((a, b) => b.start.getTime() - a.start.getTime());
  const truncated = rows.length > limit;
  return { rows: rows.slice(0, limit), truncated, total: rows.length };
}

function computeSummary() {
  const ctx = calcContext();
  const { fixed, exportFixed, markup, applyVat, priceSlots } = ctx;
  let totalKwh = 0;
  let totalExportKwh = 0;
  let fixedImportCost = 0;
  let dynamicImportCost = 0;
  let fixedExportRevenue = 0;
  let dynamicExportRevenue = 0;
  let matchedKwh = 0;
  let matchedExportKwh = 0;
  let missingPriceHours = 0;

  for (const row of state.consumption) {
    const start = parsePbDate(row.period_start);
    if (!start) continue;
    const ms = start.getTime();
    const kwh = importKwh(row);
    const exp = exportKwh(row);

    if (kwh > 0) {
      totalKwh += kwh;
      fixedImportCost += kwh * fixed;
    }
    if (exp > 0) {
      totalExportKwh += exp;
      fixedExportRevenue += exp * exportFixed;
    }

    const hourCost =
      kwh > 0 ? priceForHour(ms, kwh, priceSlots) : null;
    if (kwh > 0) {
      if (hourCost == null) {
        missingPriceHours += 1;
      } else {
        matchedKwh += kwh;
        dynamicImportCost += hourCost + kwh * markup;
      }
    }

    if (exp > 0) {
      const exportEnergy = priceForHour(ms, exp, priceSlots);
      if (exportEnergy != null) {
        matchedExportKwh += exp;
        dynamicExportRevenue += exportEnergy + exp * markup;
      }
    }
  }

  fixedImportCost = applyVat(fixedImportCost);
  dynamicImportCost = applyVat(dynamicImportCost);
  fixedExportRevenue = applyVat(fixedExportRevenue);
  dynamicExportRevenue = applyVat(dynamicExportRevenue);

  const netFixedCost = fixedImportCost - fixedExportRevenue;
  const netDynamicCost = dynamicImportCost - dynamicExportRevenue;

  const includeExport = isExportInAvg();
  const avgDynamicImportOnly = matchedKwh > 0 ? dynamicImportCost / matchedKwh : null;
  const avgDynamicNet =
    includeExport && totalKwh > 0 ? netDynamicCost / totalKwh : avgDynamicImportOnly;
  const avgFixedNet =
    includeExport && totalKwh > 0 ? netFixedCost / totalKwh : null;

  const delta = netFixedCost - netDynamicCost;

  return {
    fixed,
    exportFixed,
    exportFixedAllIn: applyVat(exportFixed),
    fixedAllIn: applyVat(fixed),
    markup,
    totalKwh,
    totalExportKwh,
    matchedKwh,
    matchedExportKwh,
    missingPriceHours,
    fixedImportCost,
    dynamicImportCost,
    fixedExportRevenue,
    dynamicExportRevenue,
    netFixedCost,
    netDynamicCost,
    avgDynamic: avgDynamicNet,
    avgDynamicImportOnly,
    avgFixedNet,
    includeExportInAvg: includeExport,
    delta,
    priceSlotCount: priceSlots.length,
  };
}

function amsterdamMonthKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AMS_TZ,
    year: "numeric",
    month: "2-digit",
  }).format(date);
}

function monthKeyLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("nl-NL", {
    timeZone: AMS_TZ,
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(y, m - 1, 15)));
}

function calcStatsContext() {
  const settings = state.settings || {};
  const fixed = Number(settings.fixed_tariff_eur_kwh ?? 0.28);
  const exportFixed = Number(settings.export_tariff_eur_kwh ?? 0);
  const markup = Number(settings.market_markup_eur_kwh ?? 0);
  return {
    fixed,
    exportFixed,
    markup,
    applyVat: applyTariffAmount,
    priceSlots: buildPriceIndex(state.statsPrices || []),
  };
}

function emptyMonthBucket() {
  return {
    importKwh: 0,
    exportKwh: 0,
    fixedImportEx: 0,
    fixedExportEx: 0,
    dynamicImportEx: 0,
    dynamicExportEx: 0,
  };
}

function formatMonthNetCostDiff(diff) {
  if (!Number.isFinite(diff)) return "—";
  const cls = diff <= 0 ? "ok-text" : "warn-text";
  const prefix = diff > 0 ? "+" : "";
  return `<span class="${cls}">${prefix}${euro(diff)}</span>`;
}

function computeMonthlyStatistics() {
  const ctx = calcStatsContext();
  const { fixed, exportFixed, markup, applyVat, priceSlots } = ctx;
  const buckets = new Map();

  for (const row of state.statsConsumption || []) {
    const start = parsePbDate(row.period_start);
    if (!start) continue;
    const monthKey = amsterdamMonthKey(start);
    if (!buckets.has(monthKey)) buckets.set(monthKey, emptyMonthBucket());
    const b = buckets.get(monthKey);
    const ms = start.getTime();
    const kwh = importKwh(row);
    const exp = exportKwh(row);

    if (kwh > 0) {
      b.importKwh += kwh;
      b.fixedImportEx += kwh * fixed;
      const hourCost = priceForHour(ms, kwh, priceSlots);
      if (hourCost != null) {
        b.dynamicImportEx += hourCost + kwh * markup;
      }
    }
    if (exp > 0) {
      b.exportKwh += exp;
      b.fixedExportEx += exp * exportFixed;
      const exportEnergy = priceForHour(ms, exp, priceSlots);
      if (exportEnergy != null) {
        b.dynamicExportEx += exportEnergy + exp * markup;
      }
    }
  }

  const rows = [...buckets.entries()]
    .map(([monthKey, b]) => {
      const fixedImport = applyVat(b.fixedImportEx);
      const fixedExport = applyVat(b.fixedExportEx);
      const dynamicImport = applyVat(b.dynamicImportEx);
      const dynamicExport = applyVat(b.dynamicExportEx);
      const netFixed = fixedImport - fixedExport;
      const netDynamic = dynamicImport - dynamicExport;
      const avgFixedNet = b.importKwh > 0 ? netFixed / b.importKwh : null;
      const avgDynamicNet = b.importKwh > 0 ? netDynamic / b.importKwh : null;
      return {
        monthKey,
        label: monthKeyLabel(monthKey),
        importKwh: b.importKwh,
        exportKwh: b.exportKwh,
        fixedImport,
        fixedExport,
        dynamicImport,
        dynamicExport,
        avgFixedNet,
        avgDynamicNet,
        netFixed,
        netDynamic,
        netCostDiff: netDynamic - netFixed,
      };
    })
    .filter((r) => r.importKwh > 0 || r.exportKwh > 0)
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey));

  return { rows };
}

async function loadStatisticsData() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - STATS_HISTORY_DAYS);
  const filter = `period_start >= "${pbFilterFrom(start)}"`;
  state.statsConsumption = await listAll("consumption_hours", {
    filter,
    sort: "period_start",
  });
  state.statsPrices = await listAll("price_slots", {
    filter,
    sort: "period_start",
  });
}

async function refreshStatisticsView() {
  state.loading = true;
  try {
    await loadSettings();
    await loadStatisticsData();
  } catch (e) {
    toast(e.message);
  } finally {
    state.loading = false;
    render();
  }
}

function settingsForExport(settings) {
  if (!settings) return null;
  const {
    id: _id,
    collectionId: _c,
    collectionName: _n,
    created: _cr,
    updated: _up,
    expand: _ex,
    ha_token,
    ...rest
  } = settings;
  return {
    ...rest,
    ha_token: ha_token ? "[redacted]" : "",
  };
}

function consumptionForExport(row) {
  return {
    period_start: row.period_start,
    import_t1_kwh: row.import_t1_kwh ?? 0,
    import_t2_kwh: row.import_t2_kwh ?? 0,
    export_t1_kwh: row.export_t1_kwh ?? 0,
    export_t2_kwh: row.export_t2_kwh ?? 0,
  };
}

function priceSlotForExport(row) {
  return {
    period_start: row.period_start,
    price_eur_kwh: row.price_eur_kwh,
    source: row.source,
    interval_minutes: row.interval_minutes ?? 60,
  };
}

function priceIntervalSummary(priceRows) {
  const byMinutes = {};
  const bySource = {};
  for (const row of priceRows) {
    const mins = Number(row.interval_minutes) || 60;
    byMinutes[String(mins)] = (byMinutes[String(mins)] || 0) + 1;
    const src = row.source || "unknown";
    bySource[src] = bySource[src] || { count: 0, interval_minutes: {} };
    bySource[src].count += 1;
    bySource[src].interval_minutes[String(mins)] =
      (bySource[src].interval_minutes[String(mins)] || 0) + 1;
  }
  const hasSubHourly = Object.keys(byMinutes).some((m) => Number(m) > 0 && Number(m) < 60);
  return { byMinutes, bySource, hasSubHourly };
}

function buildJsonExportPayload(consumption, prices, rangeLabel, fromDate, toDate) {
  const priceMeta = priceIntervalSummary(prices);
  return {
    schema_version: 1,
    app: "DynCompare",
    exported_at: new Date().toISOString(),
    range_label: rangeLabel,
    period_from: pbFilterFrom(fromDate),
    period_to_exclusive: toDate.toISOString(),
    price_storage: {
      description:
        "Markt- en HA-prijzen staan als losse slots in price_slots met interval_minutes (vaak 15 of 60 voor day-ahead; 5 of 60 bij Nordpool/HA). Verbruik (consumption_hours) is per uur. In de app worden uurkosten berekend door slots binnen dat uur tijds-gewogen te combineren; er is geen aparte uurprijs-tabel.",
      interval_minutes_counts: priceMeta.byMinutes,
      by_source: priceMeta.bySource,
      has_sub_hourly_slots: priceMeta.hasSubHourly,
      export_includes: priceMeta.hasSubHourly
        ? "Originele slot-interval (o.a. kwartier) zoals opgeslagen"
        : "Alleen uur-slots (interval_minutes=60) in database",
    },
    settings: settingsForExport(state.settings),
    consumption_hours: consumption.map(consumptionForExport),
    price_slots: prices.map(priceSlotForExport),
  };
}

function downloadJsonExport(filename, payload) {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportFilenameSuffix() {
  const d = amsterdamCalendarParts();
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

async function fetchRecordsForExport(fromDate, toDate) {
  const filter = `period_start >= "${pbFilterFrom(fromDate)}" && period_start < "${pbFilterFrom(toDate)}"`;
  const [consumption, prices] = await Promise.all([
    listAll("consumption_hours", { filter, sort: "period_start" }),
    listAll("price_slots", { filter, sort: "period_start" }),
  ]);
  return { consumption, prices };
}

async function runJsonExport(scope) {
  if (state.exportBusy) return;
  state.exportBusy = true;
  try {
    await loadSettings();
    const toDate = new Date();
    let fromDate;
    let rangeLabel;
    if (scope === "full") {
      fromDate = new Date(toDate);
      fromDate.setUTCDate(fromDate.getUTCDate() - STATS_HISTORY_DAYS);
      rangeLabel = `Laatste ${STATS_HISTORY_DAYS} dagen`;
    } else {
      fromDate = periodStartDate();
      rangeLabel = PERIODS[state.period].label;
    }
    toast("Export laden…");
    const { consumption, prices } = await fetchRecordsForExport(fromDate, toDate);
    const payload = buildJsonExportPayload(consumption, prices, rangeLabel, fromDate, toDate);
    const scopeTag = scope === "full" ? "730d" : state.period;
    downloadJsonExport(`dyncompare-export-${exportFilenameSuffix()}-${scopeTag}.json`, payload);
    toast(
      `JSON export: ${consumption.length} uren, ${prices.length} prijs-slots` +
        (payload.price_storage.has_sub_hourly_slots ? " (incl. kwartier/slot)" : ""),
      5000
    );
  } catch (e) {
    toast(e.message || "Export mislukt");
  } finally {
    state.exportBusy = false;
  }
}

function bindJsonExportButtons(root = appEl) {
  root.querySelectorAll("[data-json-export]").forEach((btn) => {
    btn.addEventListener("click", () => {
      runJsonExport(btn.dataset.jsonExport);
    });
  });
}

function jsonTransferBusy() {
  return state.exportBusy || state.importBusy;
}

function pbPeriodFilterValue(periodStart) {
  return String(periodStart).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function findRecordByPeriod(collection, periodStart) {
  const filter = `period_start="${pbPeriodFilterValue(periodStart)}"`;
  const q = new URLSearchParams({ filter, perPage: "1" });
  const data = await pbRequest(`/api/collections/${collection}/records?${q}`);
  return (data.items && data.items[0]) || null;
}

async function upsertByPeriod(collection, periodStart, payload) {
  const existing = await findRecordByPeriod(collection, periodStart);
  if (existing?.id) {
    await pbRequest(`/api/collections/${collection}/records/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    return "updated";
  }
  await pbRequest(`/api/collections/${collection}/records`, {
    method: "POST",
    body: JSON.stringify({ period_start: periodStart, ...payload }),
  });
  return "created";
}

function parseImportPayload(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Geen geldige JSON");
  }
  if (!data || data.schema_version !== 1) {
    throw new Error("Onbekend exportbestand (schema_version 1 vereist)");
  }
  if (!Array.isArray(data.consumption_hours) || !Array.isArray(data.price_slots)) {
    throw new Error("consumption_hours en price_slots moeten arrays zijn");
  }
  return data;
}

function normalizeConsumptionImportRow(row) {
  const period = row?.period_start;
  if (!period) throw new Error("Verbruiksregel zonder period_start");
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    period_start: period,
    payload: {
      import_t1_kwh: num(row.import_t1_kwh),
      import_t2_kwh: num(row.import_t2_kwh),
      export_t1_kwh: num(row.export_t1_kwh),
      export_t2_kwh: num(row.export_t2_kwh),
    },
  };
}

function normalizePriceImportRow(row) {
  const period = row?.period_start;
  if (!period) throw new Error("Prijsregel zonder period_start");
  const price = Number(row.price_eur_kwh);
  if (!Number.isFinite(price)) throw new Error(`Ongeldige prijs voor ${period}`);
  const source = PRICE_SLOT_SOURCES.has(row.source) ? row.source : "market";
  const interval = Number(row.interval_minutes);
  const interval_minutes = Number.isFinite(interval) && interval >= 1 ? interval : 60;
  return {
    period_start: period,
    payload: {
      price_eur_kwh: price,
      source,
      interval_minutes,
    },
  };
}

async function applyImportedSettings(exportedSettings) {
  if (!exportedSettings || !state.settings?.id) return 0;
  const patch = {};
  for (const key of SETTINGS_IMPORT_FIELDS) {
    if (exportedSettings[key] === undefined || exportedSettings[key] === null) continue;
    if (key === "ha_token") continue;
    patch[key] = exportedSettings[key];
  }
  if (!Object.keys(patch).length) return 0;
  await pbRequest(`/api/collections/settings/records/${state.settings.id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return Object.keys(patch).length;
}

async function refreshAfterDataImport() {
  if (state.view === "charts") await refreshChartView();
  else if (state.view === "statistics") await refreshStatisticsView();
  else await refresh();
}

async function runJsonImport(file, mergeSettings) {
  if (jsonTransferBusy() || state.syncing) return;
  if (!file) return;

  state.importBusy = true;
  setSyncControlsDisabled(true);

  try {
    const text = await file.text();
    const data = parseImportPayload(text);
    await loadSettings();

    const consumptionRows = data.consumption_hours.map(normalizeConsumptionImportRow);
    const priceRows = data.price_slots.map(normalizePriceImportRow);
    const totalSteps = consumptionRows.length + priceRows.length;
    let step = 0;

    setSyncBanner("busy", "JSON importeren", `0 / ${totalSteps} records…`);

    for (const row of consumptionRows) {
      await upsertByPeriod("consumption_hours", row.period_start, row.payload);
      step += 1;
      if (step % 40 === 0 || step === totalSteps) {
        setSyncBanner("busy", "JSON importeren", `${step} / ${totalSteps} records…`);
      }
    }

    for (const row of priceRows) {
      await upsertByPeriod("price_slots", row.period_start, row.payload);
      step += 1;
      if (step % 40 === 0 || step === totalSteps) {
        setSyncBanner("busy", "JSON importeren", `${step} / ${totalSteps} records…`);
      }
    }

    let settingsFields = 0;
    if (mergeSettings) {
      settingsFields = await applyImportedSettings(data.settings);
      await loadSettings();
    }

    const importedAt = new Date().toISOString();
    const msg = `Import JSON: ${consumptionRows.length} uren, ${priceRows.length} prijs-slots` +
      (data.exported_at ? ` (export ${data.exported_at})` : "");
    if (state.settings?.id) {
      await pbRequest(`/api/collections/settings/records/${state.settings.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          last_sync_at: importedAt,
          last_sync_message: msg,
        }),
      });
    }

    setSyncBanner(
      "ok",
      "Import voltooid",
      `${msg}${settingsFields ? ` · ${settingsFields} instellingen` : ""}`
    );
    toast(msg, 7000);
    setTimeout(() => {
      if (!state.importBusy) setSyncBanner("hidden");
    }, 10000);

    await refreshAfterDataImport();
  } catch (e) {
    setSyncBanner("error", "Import mislukt", e.message || "Onbekende fout");
    toast(e.message || "Import mislukt", 8000);
  } finally {
    state.importBusy = false;
    setSyncControlsDisabled(false);
  }
}

function bindJsonImportControls(root = appEl) {
  const input = root.querySelector("#jsonImportInput");
  if (!input) return;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const mergeSettings = Boolean(root.querySelector("#jsonImportMergeSettings")?.checked);
    runJsonImport(file, mergeSettings);
  });
}

function bindJsonTransferControls(root = appEl) {
  bindJsonExportButtons(root);
  bindJsonImportControls(root);
}

function syncServiceUrl() {
  const fromSettings = (state.settings?.sync_service_url || "").trim();
  if (fromSettings) return fromSettings.replace(/\/$/, "");
  const host = window.location.hostname;
  const proto = window.location.protocol;
  return `${proto}//${host}:8098`;
}

function isMarketMissingOnly() {
  return Boolean(state.settings?.market_sync_missing_only);
}

async function persistMarketSyncMode(missingOnly) {
  if (!state.settings?.id) return;
  await pbRequest(`/api/collections/settings/records/${state.settings.id}`, {
    method: "PATCH",
    body: JSON.stringify({ market_sync_missing_only: missingOnly }),
  });
  state.settings.market_sync_missing_only = missingOnly;
}

async function persistIncludeExportInAvg(include) {
  if (!state.settings?.id) return;
  await pbRequest(`/api/collections/settings/records/${state.settings.id}`, {
    method: "PATCH",
    body: JSON.stringify({ include_export_in_avg: include }),
  });
  state.settings.include_export_in_avg = include;
}

async function persistSyncIncludeHa(includeHa) {
  if (!state.settings?.id) return;
  await pbRequest(`/api/collections/settings/records/${state.settings.id}`, {
    method: "PATCH",
    body: JSON.stringify({ sync_include_ha: includeHa }),
  });
  state.settings.sync_include_ha = includeHa;
}

async function triggerSync() {
  if (state.syncing) return;

  const url = `${syncServiceUrl()}/sync`;
  const withHa = syncIncludeHa();
  state.syncing = true;
  state.syncStartedAt = Date.now();
  setSyncControlsDisabled(true);
  setSyncBanner(
    "busy",
    "Synchroniseren",
    withHa
      ? "Verbruik en prijzen ophalen (kan enkele minuten duren)…"
      : "Alleen marktprijzen ophalen (geen HA-verbruik)…"
  );
  startSyncPoll();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        days: syncDaysForPeriod(),
        include_market_prices: true,
        market_missing_only: isMarketMissingOnly(),
        sync_ha: withHa,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail || data.message || `Sync mislukt (${res.status})`);
    }
    await loadSettings();
    await loadData();
    const doneMsg = data.message || state.settings?.last_sync_message || "Sync voltooid";
    const when = formatSyncTimestamp(state.settings?.last_sync_at);
    setSyncBanner("ok", "Synchronisatie voltooid", `${doneMsg}${when !== "—" ? ` · ${when}` : ""}`);
    toast(doneMsg, 7000);
    render();
    setTimeout(() => {
      if (!state.syncing) setSyncBanner("hidden");
    }, 12000);
  } catch (err) {
    const message = err.message || "Sync mislukt";
    setSyncBanner("error", "Synchronisatie mislukt", message);
    toast(message, 8000);
    try {
      await loadSettings();
    } catch (_) {
      /* ignore */
    }
    render();
  } finally {
    state.syncing = false;
    stopSyncPoll();
    setSyncControlsDisabled(false);
  }
}

async function saveSettings(form) {
  if (!state.settings?.id) throw new Error("Geen settings record");
  const payload = {
    label: form.label.value.trim() || "Standaard",
    fixed_tariff_eur_kwh: Number(form.fixed_tariff_eur_kwh.value),
    export_tariff_eur_kwh: Number(form.export_tariff_eur_kwh.value) || 0,
    market_markup_eur_kwh: Number(form.market_markup_eur_kwh.value) || 0,
    vat_rate: 0,
    ha_url: form.ha_url.value.trim(),
    ha_token: form.ha_token.value.trim(),
    sync_service_url: form.sync_service_url.value.trim(),
    sensor_import_t1: form.sensor_import_t1.value.trim(),
    sensor_import_t2: form.sensor_import_t2.value.trim(),
    sensor_export_t1: form.sensor_export_t1.value.trim(),
    sensor_export_t2: form.sensor_export_t2.value.trim(),
    price_statistic_id: form.price_statistic_id.value.trim(),
    market_sync_missing_only: form.market_sync_missing_only.checked,
    sync_include_ha: form.sync_include_ha.checked,
  };
  await pbRequest(`/api/collections/settings/records/${state.settings.id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  toast("Instellingen opgeslagen");
  await loadSettings();
}

function renderCompare() {
  const summary = computeSummary();
  const cheaper = summary.delta > 0 ? "dynamisch" : summary.delta < 0 ? "vast" : "gelijk";
  const fixedHeroRate = summary.includeExportInAvg
    ? summary.avgFixedNet
    : summary.fixedAllIn;
  const fixedHeroLabel = summary.includeExportInAvg
    ? "Vast (gewogen netto)"
    : "Vast contract (ingesteld)";
  const avgLabel = summary.includeExportInAvg
    ? "Gewogen gemiddelde netto per geïmporteerde kWh (incl. BTW)"
    : "Gewogen gemiddelde import dynamisch (incl. BTW)";

  appEl.innerHTML = `
    <section class="panel">
      <div class="segment" role="tablist" aria-label="Periode">
        ${Object.entries(PERIODS)
          .map(
            ([key, p]) =>
              `<button type="button" class="segment-btn ${state.period === key ? "is-active" : ""}" data-period="${key}">${periodSegmentLabel(key, p)}</button>`
          )
          .join("")}
      </div>
    </section>

    <section class="hero card">
      <p class="muted">${avgLabel}</p>
      <p class="hero-value">${summary.avgDynamic != null ? euro(summary.avgDynamic, 4) : "—"}<span class="unit">/kWh</span></p>
      <p class="muted small">${fixedHeroLabel}: <strong>${fixedHeroRate != null ? euro(fixedHeroRate, 4) : "—"}/kWh</strong> incl. BTW</p>
      <p class="muted small" style="margin-top:10px">Export in gemiddelde:</p>
      <div class="segment segment-2" role="group" aria-label="Export in gewogen gemiddelde">
        <button type="button" class="segment-btn ${!summary.includeExportInAvg ? "is-active" : ""}" data-export-avg="off" ${state.syncing ? "disabled" : ""}>Alleen import</button>
        <button type="button" class="segment-btn ${summary.includeExportInAvg ? "is-active" : ""}" data-export-avg="on" ${state.syncing ? "disabled" : ""}>Netto (import − export)</button>
      </div>
      ${summary.includeExportInAvg ? `<p class="muted small">(importkosten − exportopbrengst) ÷ ${kwh(summary.totalKwh)} import — vast én dynamisch.</p>` : ""}
    </section>

    <section class="grid-2">
      <article class="card stat">
        <p class="muted">Kosten import dynamisch</p>
        <p class="stat-value">${summary.matchedKwh > 0 ? euro(summary.dynamicImportCost) : "—"}</p>
        <p class="muted small">${kwh(summary.matchedKwh)} met prijsdata</p>
      </article>
      <article class="card stat">
        <p class="muted">Kosten import vast</p>
        <p class="stat-value">${euro(summary.fixedImportCost)}</p>
        <p class="muted small">${kwh(summary.totalKwh)} import</p>
      </article>
    </section>

    <section class="grid-2">
      <article class="card stat">
        <p class="muted">Opbrengst export dynamisch</p>
        <p class="stat-value ok-text">${summary.matchedExportKwh > 0 ? euro(summary.dynamicExportRevenue) : "—"}</p>
        <p class="muted small">${kwh(summary.matchedExportKwh)} met prijsdata · ${kwh(summary.totalExportKwh)} totaal export</p>
      </article>
      <article class="card stat">
        <p class="muted">Opbrengst export vast</p>
        <p class="stat-value ok-text">${summary.totalExportKwh > 0 ? euro(summary.fixedExportRevenue) : "—"}</p>
        <p class="muted small">${kwh(summary.totalExportKwh)} export · ${euro(summary.exportFixedAllIn, 4)}/kWh incl. BTW</p>
      </article>
    </section>

    <section class="card highlight ${summary.delta >= 0 ? "ok" : "warn"}">
      <p class="muted">Netto verschil in periode (${cheaper} voordeliger)</p>
      <p class="stat-value">${euro(Math.abs(summary.delta))}</p>
      <p class="muted small">Import − export: vast ${euro(summary.netFixedCost)} vs dynamisch ${summary.matchedKwh > 0 ? euro(summary.netDynamicCost) : "—"}</p>
      <p class="muted small">${summary.delta >= 0 ? "Je zou met dynamisch minder betalen (simulatie)" : "Vast is goedkoper in deze simulatie"}</p>
    </section>

    <section class="card">
      <h2 class="card-title">Toelichting</h2>
      <ul class="notes">
        <li>Verbruik: P1 import én export tarief 1 + 2 per uur uit Home Assistant. Export dynamisch = zelfde day-ahead + opslag als import; vast export = ingestelde vergoeding.</li>
        <li>Netto gemiddelde (knop): (totale importkosten − exportopbrengst) gedeeld door alle geïmporteerde kWh — voor vast én dynamisch.</li>
        <li>Prijzen: day-ahead NL (Energy-Charts) + optioneel HA prijssensor. Uurverbruik wordt evenredig over prijs-slots in dat uur verdeeld.</li>
        <li>Opslag: stel <strong>markt-opslag</strong> in onder Instellingen (incl. BTW), bovenop day-ahead voor vergelijkbare all-in tarieven.</li>
        ${summary.missingPriceHours ? `<li class="warn-text">${summary.missingPriceHours} uren zonder prijsdata (niet meegeteld in dynamisch). Laat het veld Nordpool/HA-prijs leeg en synchroniseer opnieuw om NL day-ahead (Energy-Charts) te gebruiken — zie tab Data.</li>` : ""}
      </ul>
      <p class="muted small sync-meta">Laatste sync: ${formatSyncTimestamp(state.settings?.last_sync_at)} · ${state.settings?.last_sync_message || "—"}</p>
      <p class="muted small">Sync-inhoud:</p>
      <div class="segment segment-2" role="group" aria-label="Sync inhoud">
        <button type="button" class="segment-btn ${syncIncludeHa() ? "is-active" : ""}" data-sync-scope="full" ${state.syncing ? "disabled" : ""}>HA + markt</button>
        <button type="button" class="segment-btn ${!syncIncludeHa() ? "is-active" : ""}" data-sync-scope="market" ${state.syncing ? "disabled" : ""}>Alleen markt</button>
      </div>
      <p class="muted small">Marktprijzen (Energy-Charts/ENTSO-E):</p>
      <div class="segment segment-2" role="group" aria-label="Marktprijzen synchronisatie">
        <button type="button" class="segment-btn ${isMarketMissingOnly() ? "is-active" : ""}" data-market-mode="missing" ${state.syncing ? "disabled" : ""}>Alleen ontbrekende dagen</button>
        <button type="button" class="segment-btn ${!isMarketMissingOnly() ? "is-active" : ""}" data-market-mode="full" ${state.syncing ? "disabled" : ""}>Hele periode opnieuw</button>
      </div>
      <button type="button" class="btn primary" id="syncBtn" ${state.syncing ? "disabled" : ""}>${state.syncing ? "Bezig met synchroniseren…" : syncPrimaryButtonLabel()}</button>
      <p class="muted small">${syncIncludeHa() ? `Verbruik uit HA: hele sync-periode (<strong>${syncDaysForPeriod()} dag(en)</strong>).` : "Geen HA-verbruik — sneller voor ontbrekende marktprijzen."} Markt volgt de knop hierboven (${syncDaysForPeriod()} dag(en)). Geen dubbele rijen in de database.</p>
    </section>
  `;

  appEl.querySelectorAll("[data-period]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.period = btn.dataset.period;
      await refresh();
    });
  });
  appEl.querySelectorAll("[data-market-mode]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (state.syncing) return;
      const missingOnly = btn.dataset.marketMode === "missing";
      try {
        await persistMarketSyncMode(missingOnly);
        toast(missingOnly ? "Markt: alleen ontbrekende dagen" : "Markt: hele periode opnieuw");
        render();
      } catch (e) {
        toast(e.message);
      }
    });
  });
  appEl.querySelectorAll("[data-sync-scope]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (state.syncing) return;
      const includeHa = btn.dataset.syncScope === "full";
      if (includeHa === syncIncludeHa()) return;
      try {
        await persistSyncIncludeHa(includeHa);
        toast(includeHa ? "Sync: HA-verbruik + markt" : "Sync: alleen marktprijzen");
        render();
      } catch (e) {
        toast(e.message);
      }
    });
  });
  appEl.querySelectorAll("[data-export-avg]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (state.syncing) return;
      const include = btn.dataset.exportAvg === "on";
      try {
        await persistIncludeExportInAvg(include);
        toast(include ? "Gemiddelde: netto incl. export" : "Gemiddelde: alleen import");
        render();
      } catch (e) {
        toast(e.message);
      }
    });
  });
  document.getElementById("syncBtn")?.addEventListener("click", () => {
    triggerSync();
  });
}

function renderData() {
  const summary = computeSummary();
  const last = state.consumption[state.consumption.length - 1];
  const first = state.consumption[0];
  const src = priceSourceCounts(state.prices);
  const hourlyLimit =
    state.period === "day"
      ? 48
      : state.period === "week"
        ? 168
        : state.period === "month"
          ? 744
          : 200;
  const hourly = computeHourlyRows(hourlyLimit);

  const tableRows = hourly.rows
    .map((h) => {
      const deltaCell =
        h.missingPrice
          ? "—"
          : `<span class="${h.delta >= 0 ? "ok-text" : "warn-text"}">${h.delta >= 0 ? "+" : ""}${euro(h.delta, 3)}</span>`;
      return `<tr>
        <td>${h.label}</td>
        <td class="num">${kwh(h.kwh, 2)}</td>
        <td class="num">${euro(h.fixedEurKwh, 4)}</td>
        <td class="num">${h.dynamicEurKwh != null ? euro(h.dynamicEurKwh, 4) : "—"}</td>
        <td class="num">${deltaCell}</td>
      </tr>`;
    })
    .join("");

  appEl.innerHTML = `
    <section class="panel">
      <div class="segment" role="tablist" aria-label="Periode">
        ${Object.entries(PERIODS)
          .map(
            ([key, p]) =>
              `<button type="button" class="segment-btn ${state.period === key ? "is-active" : ""}" data-period="${key}">${periodSegmentLabel(key, p)}</button>`
          )
          .join("")}
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">Uren (${PERIODS[state.period].label.toLowerCase()})</h2>
      <p class="muted small">Verschil = <strong>totale €</strong> vast − dynamisch dit uur: (vast €/kWh − dynamisch €/kWh) × kWh. Beide €/kWh-kolommen zijn all-in (Instellingen + markt day-ahead + opslag).</p>
      ${hourly.truncated ? `<p class="muted small warn-text">Toont ${hourly.rows.length} van ${hourly.total} uren met verbruik (nieuwste eerst).</p>` : ""}
      <div class="table-wrap">
        <table class="data-table data-table-hours">
          <colgroup>
            <col class="col-label" />
            <col span="4" class="col-num" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Uur</th>
              <th scope="col" class="num">Verbruik</th>
              <th scope="col" class="num">Vast €/kWh</th>
              <th scope="col" class="num">Dynamisch €/kWh</th>
              <th scope="col" class="num">Verschil (€)</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || `<tr><td colspan="5" class="muted">Geen uren met import in deze periode.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">Dataset</h2>
      <dl class="kv">
        <dt>Uurrecords verbruik</dt><dd>${state.consumption.length}</dd>
        <dt>Prijs-slots</dt><dd>${state.prices.length} (${summary.priceSlotCount} gebruikt na merge)</dd>
        <dt>Markt (Energy-Charts)</dt><dd>${src.market} slots</dd>
        <dt>Home Assistant prijs</dt><dd>${src.home_assistant} slots</dd>
        <dt>Eerste uur</dt><dd>${first ? first.period_start : "—"}</dd>
        <dt>Laatste uur</dt><dd>${last ? last.period_start : "—"}</dd>
        <dt>Laatste sync</dt><dd>${state.settings?.last_sync_at || "—"}</dd>
        <dt>Sync status</dt><dd>${state.settings?.last_sync_message || "—"}</dd>
      </dl>
    </section>

    <section class="card">
      <h2 class="card-title">JSON export / import</h2>
      <p class="muted small">Verplaats data naar een andere DynCompare-server zonder opnieuw HA/markt op te halen. Export bevat uur-verbruik + prijs-slots (<strong>interval_minutes</strong> behouden).</p>
      <div class="export-actions">
        <button type="button" class="btn primary" data-json-export="period" ${jsonTransferBusy() || state.syncing ? "disabled" : ""}>
          Download JSON (${PERIODS[state.period].label.toLowerCase()})
        </button>
        <button type="button" class="btn secondary" data-json-export="full" ${jsonTransferBusy() || state.syncing ? "disabled" : ""}>
          Download JSON (${STATS_HISTORY_DAYS} dagen)
        </button>
      </div>
      <label class="checkbox-row" style="margin-top:12px">
        <input type="checkbox" id="jsonImportMergeSettings" checked />
        Bij import ook tarieven &amp; sensoren uit bestand (geen HA-token)
      </label>
      <div class="export-actions">
        <label class="btn secondary import-json-btn ${jsonTransferBusy() || state.syncing ? "is-disabled" : ""}">
          JSON-bestand importeren
          <input type="file" id="jsonImportInput" accept="application/json,.json" ${jsonTransferBusy() || state.syncing ? "disabled" : ""} hidden />
        </label>
      </div>
      <p class="muted small">Import upsert per <code>period_start</code> (bestaande uren/prijzen worden overschreven).</p>
    </section>
  `;

  appEl.querySelectorAll("[data-period]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.period = btn.dataset.period;
      await refresh();
    });
  });
  bindJsonTransferControls();
}

function renderCharts() {
  destroyCharts();
  const isWeek = state.chartGranularity === "week";
  const rangeTitle = chartRangeTitle();
  const points = isWeek
    ? buildWeekCostPoints(state.chartWeekStart)
    : buildMonthChartPoints(state.chartMonth.year, state.chartMonth.month);
  const prevLabel = isWeek ? "← Vorige week" : "← Vorige";
  const nextLabel = isWeek ? "Volgende week →" : "Volgende →";
  const prevAria = isWeek ? "Vorige week" : "Vorige maand";
  const nextAria = isWeek ? "Volgende week" : "Volgende maand";

  const monthBody = `
      <p class="muted small">Per uur: markt day-ahead (all-in) vs vaste prijs. <span class="legend-orange">Oranje</span> = markt duurder dan vast; <span class="legend-green">groen</span> = markt goedkoper.</p>
      <div class="chart-canvas-wrap">
        <canvas id="priceChartCanvas" aria-label="Marktprijs en vaste prijs per uur"></canvas>
      </div>
      <div class="chart-legend">
        <span class="legend-market">Markt day-ahead</span>
        <span class="legend-fixed">Vast (all-in)</span>
        <span class="legend-orange">Boven vast (duurder)</span>
        <span class="legend-green">Onder vast (goedkoper)</span>
      </div>
      <h3 class="card-title" style="margin-top:16px">Verschil (vast − markt)</h3>
      <p class="muted small">Positief = dynamisch goedkoper; negatief = dynamisch duurder.</p>
      <div class="chart-canvas-wrap tall">
        <canvas id="diffChartCanvas" aria-label="Verschil vast minus markt per uur"></canvas>
      </div>`;

  const weekBody = `
      <p class="muted small">Per uur met import: staafdiagram van kosten vast vs dynamisch (all-in). Alleen uren met verbruik én prijsdata.</p>
      <div class="chart-canvas-wrap chart-canvas-wrap-week">
        <canvas id="priceChartCanvas" aria-label="Kosten vast en dynamisch per uur"></canvas>
      </div>
      <div class="chart-legend">
        <span class="legend-fixed">Kosten vast</span>
        <span class="legend-market">Kosten dynamisch</span>
      </div>
      <h3 class="card-title" style="margin-top:16px">Verschil in € (vast − dynamisch)</h3>
      <p class="muted small">Positief = dynamisch goedkoper dit uur; negatief = dynamisch duurder.</p>
      <div class="chart-canvas-wrap tall chart-canvas-wrap-week">
        <canvas id="diffChartCanvas" aria-label="Verschil in euro per uur"></canvas>
      </div>`;

  const emptyMsg = isWeek
    ? `Geen uren met import én prijsdata voor ${rangeTitle}. Synchroniseer data of kies een andere week.`
    : `Geen marktprijsdata voor ${rangeTitle}. Synchroniseer marktprijzen of kies een andere maand.`;

  appEl.innerHTML = `
    <section class="panel">
      <div class="segment segment-2" role="group" aria-label="Grafiek periode">
        <button type="button" class="segment-btn ${!isWeek ? "is-active" : ""}" data-chart-gran="month">Maand</button>
        <button type="button" class="segment-btn ${isWeek ? "is-active" : ""}" data-chart-gran="week">Week</button>
      </div>
    </section>
    <section class="card">
      <div class="chart-nav">
        <button type="button" class="btn secondary" id="chartPrevRange" aria-label="${prevAria}">${prevLabel}</button>
        <h2>${rangeTitle}</h2>
        <button type="button" class="btn secondary" id="chartNextRange" aria-label="${nextAria}">${nextLabel}</button>
      </div>
      ${points.length ? (isWeek ? weekBody : monthBody) : `<p class="muted">${emptyMsg}</p>`}
    </section>
  `;

  appEl.querySelectorAll("[data-chart-gran]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const gran = btn.dataset.chartGran;
      if (gran === state.chartGranularity) return;
      state.chartGranularity = gran;
      if (gran === "week") {
        state.chartWeekStart = amsterdamWeekStart();
      }
      refreshChartView();
    });
  });

  document.getElementById("chartPrevRange")?.addEventListener("click", () => {
    if (isWeek) shiftChartWeek(-1);
    else shiftChartMonth(-1);
    refreshChartView();
  });
  document.getElementById("chartNextRange")?.addEventListener("click", () => {
    if (isWeek) shiftChartWeek(1);
    else shiftChartMonth(1);
    refreshChartView();
  });

  if (points.length) {
    requestAnimationFrame(() => {
      destroyCharts();
      mountCharts();
    });
  }
}

function renderStatistics() {
  const { rows } = computeMonthlyStatistics();

  const tableRows = rows
    .map(
      (m) => `<tr>
        <td>${m.label}</td>
        <td class="num">${m.dynamicImport > 0 ? euro(m.dynamicImport) : "—"}</td>
        <td class="num ok-text">${m.dynamicExport > 0 ? euro(m.dynamicExport) : "—"}</td>
        <td class="num">${m.fixedImport > 0 ? euro(m.fixedImport) : "—"}</td>
        <td class="num ok-text">${m.fixedExport > 0 ? euro(m.fixedExport) : "—"}</td>
        <td class="num">${m.avgDynamicNet != null ? euro(m.avgDynamicNet, 4) : "—"}</td>
        <td class="num">${m.avgFixedNet != null ? euro(m.avgFixedNet, 4) : "—"}</td>
        <td class="num">${formatMonthNetCostDiff(m.netCostDiff)}</td>
      </tr>`
    )
    .join("");

  appEl.innerHTML = `
    <section class="card">
      <h2 class="card-title">Maandoverzicht</h2>
      <p class="muted small">Totalen en gewogen gemiddelde netto per geïmporteerde kWh (import − export), all-in incl. BTW. Dynamisch = day-ahead + opslag uit Instellingen. Per kalendermaand (Europe/Amsterdam).</p>
      <p class="muted small">Data: laatste <strong>${STATS_HISTORY_DAYS}</strong> dagen uit de database (max. sync-periode).</p>
      <div class="table-wrap">
        <table class="data-table stats-table">
          <colgroup>
            <col class="col-label" />
            <col span="7" class="col-num" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Maand</th>
              <th scope="col" class="num">Import dyn.</th>
              <th scope="col" class="num">Export dyn.</th>
              <th scope="col" class="num">Import vast</th>
              <th scope="col" class="num">Export vast</th>
              <th scope="col" class="num">Gem. dyn.</th>
              <th scope="col" class="num">Gem. vast</th>
              <th scope="col" class="num">Verschil netto</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || `<tr><td colspan="8" class="muted">Geen verbruiksdata in deze periode. Synchroniseer eerst met Home Assistant.</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="muted small">Gem. = (importkosten − exportopbrengst) ÷ import kWh die maand. Exportkolommen zijn opbrengst (niet de netto-aftrek). <strong>Verschil netto</strong> = (import dyn. − export dyn.) − (import vast − export vast); negatief = dynamisch goedkoper die maand.</p>
      <h3 class="card-title" style="margin-top:16px">JSON-export</h3>
      <p class="muted small">Zelfde ${STATS_HISTORY_DAYS}-dagen set als deze tabel: verbruik + prijs-slots (kwartier indien aanwezig).</p>
      <div class="export-actions">
        <button type="button" class="btn primary" data-json-export="full" ${state.exportBusy ? "disabled" : ""}>
          Download JSON (${STATS_HISTORY_DAYS} dagen)
        </button>
      </div>
    </section>
  `;
  bindJsonTransferControls();
}

function renderSettings() {
  const s = state.settings || {};
  appEl.innerHTML = `
    <form class="card form" id="settingsForm">
      <h2 class="card-title">Tarief</h2>
      <label>Vaste importprijs (€/kWh, incl. BTW)
        <input name="fixed_tariff_eur_kwh" type="number" step="0.0001" min="0" value="${s.fixed_tariff_eur_kwh ?? 0.28}" required />
      </label>
      <label>Vaste exportvergoeding (€/kWh, incl. BTW)
        <input name="export_tariff_eur_kwh" type="number" step="0.0001" min="0" value="${s.export_tariff_eur_kwh ?? 0.1}" />
      </label>
      <label>Markt-opslag dynamisch (€/kWh, incl. BTW)
        <input name="market_markup_eur_kwh" type="number" step="0.0001" min="0" value="${s.market_markup_eur_kwh ?? 0}" />
      </label>
      <p class="muted small">Alle bedragen hier zijn <strong>all-in</strong> (zoals op je contract of energierekening). Day-ahead marktprijzen worden in de app aangevuld met deze opslag; er wordt geen extra BTW-percentage berekend.</p>

      <h2 class="card-title">Synchronisatie</h2>
      <label class="checkbox-row">
        <input type="checkbox" name="market_sync_missing_only" ${s.market_sync_missing_only ? "checked" : ""} />
        Marktprijzen: alleen ontbrekende dagen ophalen (minder API-calls)
      </label>
      <label class="checkbox-row">
        <input type="checkbox" name="sync_include_ha" ${s.sync_include_ha !== false ? "checked" : ""} />
        Sync standaard incl. Home Assistant-verbruik (uit = alleen marktprijzen, sneller)
      </label>

      <h2 class="card-title">Home Assistant</h2>
      <label>URL (bv. https://ha.local:8123)
        <input name="ha_url" type="url" value="${s.ha_url || ""}" placeholder="https://homeassistant.local:8123" />
      </label>
      <label>Long-lived access token
        <input name="ha_token" type="password" value="${s.ha_token || ""}" autocomplete="off" />
      </label>
      <label>Sync service URL
        <input name="sync_service_url" type="url" value="${s.sync_service_url || ""}" placeholder="${syncServiceUrl()}" />
      </label>

      <h2 class="card-title">P1 sensoren</h2>
      <label>Import tarief 1
        <input name="sensor_import_t1" value="${s.sensor_import_t1 || "sensor.p1_energy_consumption_tarif_1"}" />
      </label>
      <label>Import tarief 2
        <input name="sensor_import_t2" value="${s.sensor_import_t2 || "sensor.p1_energy_consumption_tarif_2"}" />
      </label>
      <label>Export tarief 1
        <input name="sensor_export_t1" value="${s.sensor_export_t1 || "sensor.p1_energy_production_tarif_1"}" />
      </label>
      <label>Export tarief 2
        <input name="sensor_export_t2" value="${s.sensor_export_t2 || "sensor.p1_energy_production_tarif_2"}" />
      </label>
      <label>Optioneel: Nordpool / HA-prijs (entity of statistic ID)
        <input name="price_statistic_id" value="${s.price_statistic_id || ""}" placeholder="sensor.nordpool_kwh" />
      </label>
      <p class="muted small">Leeg laten = NL day-ahead via Energy-Charts (maanden historie). Lukt ophalen niet (geblokkeerde API)? Zet <strong>ENTSOE_API_TOKEN</strong> op de sync-container — zie README. Nordpool-statistieken geven geen verleden vóór “statistieken aan”; voor maanden terug: markt-API, niet HA.</p>

      <input type="hidden" name="label" value="${s.label || "Standaard"}" />
      <button type="submit" class="btn primary">Opslaan</button>
    </form>

    <section class="card" style="margin-top:12px">
      <h2 class="card-title">JSON import (andere server)</h2>
      <p class="muted small">Importeer een exportbestand van een andere installatie. HA-token moet je hier handmatig invullen.</p>
      <label class="checkbox-row">
        <input type="checkbox" id="jsonImportMergeSettings" checked />
        Tarieven &amp; sensoren uit bestand overnemen
      </label>
      <div class="export-actions">
        <label class="btn secondary import-json-btn ${jsonTransferBusy() || state.syncing ? "is-disabled" : ""}">
          JSON-bestand kiezen
          <input type="file" id="jsonImportInput" accept="application/json,.json" ${jsonTransferBusy() || state.syncing ? "disabled" : ""} hidden />
        </label>
      </div>
    </section>
  `;

  document.getElementById("settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings(e.target).catch((err) => toast(err.message));
  });
  bindJsonTransferControls();
}

function render() {
  const titles = {
    compare: "Vergelijk",
    data: "Data",
    charts: "Grafiek",
    statistics: "Statistieken",
    settings: "Instellingen",
  };
  pageTitle.textContent = titles[state.view] || "DynCompare";

  if (state.view === "charts") {
    periodLabel.textContent = chartRangeTitle();
  } else if (state.view === "statistics") {
    periodLabel.textContent = `Maanden (${STATS_HISTORY_DAYS} dagen)`;
  } else {
    periodLabel.textContent = PERIODS[state.period].label;
  }

  if (state.view === "compare") renderCompare();
  else if (state.view === "data") renderData();
  else if (state.view === "charts") renderCharts();
  else if (state.view === "statistics") renderStatistics();
  else renderSettings();
}

async function refresh() {
  state.loading = true;
  try {
    await loadSettings();
    await loadData();
  } catch (e) {
    toast(e.message);
  } finally {
    state.loading = false;
    render();
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const prev = state.view;
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
    tab.classList.add("is-active");
    state.view = tab.dataset.view;
    if (prev === "charts" && state.view !== "charts") destroyCharts();
    if (state.view === "charts") refreshChartView();
    else if (state.view === "statistics") refreshStatisticsView();
    else render();
  });
});

refreshBtn?.addEventListener("click", () => {
  if (state.syncing) return;
  if (state.view === "charts") refreshChartView();
  else if (state.view === "statistics") refreshStatisticsView();
  else refresh();
});

async function resumeSyncBannerIfBusy() {
  const msg = (state.settings?.last_sync_message || "").trim();
  if (!msg.startsWith("Bezig:")) return;
  setSyncBanner(
    "busy",
    "Synchroniseren (mogelijk nog bezig)",
    `${msg} — wacht tot dit verandert of start opnieuw`
  );
}

refresh().then(() => resumeSyncBannerIfBusy());
