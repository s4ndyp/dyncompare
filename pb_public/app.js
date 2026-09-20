const PERIODS = {
  day: { label: "Laatste 24 uur", days: 1, hours: 24, syncDays: 1 },
  month: { label: "Afgelopen maand", days: 31, syncDays: 31 },
  halfyear: { label: "Afgelopen 6 maanden", days: 183, syncDays: 183 },
  year: { label: "Afgelopen jaar", days: 366, syncDays: 366 },
};

const state = {
  view: "compare",
  period: "month",
  settings: null,
  consumption: [],
  prices: [],
  loading: false,
  syncing: false,
  syncPollId: null,
  syncStartedAt: null,
};

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

function setSyncControlsDisabled(disabled) {
  if (refreshBtn) refreshBtn.disabled = disabled;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.disabled = disabled;
  });
  const syncBtn = document.getElementById("syncBtn");
  if (syncBtn) {
    syncBtn.disabled = disabled;
    syncBtn.textContent = disabled ? "Bezig met synchroniseren…" : "Synchroniseer met Home Assistant";
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
  return period.label.replace("Afgelopen ", "");
}

function pbFilterFrom(date) {
  const iso = date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
  return iso.slice(0, 19).replace("T", " ");
}

const DEFAULT_SETTINGS = {
  label: "Standaard",
  fixed_tariff_eur_kwh: 0.28,
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

function importKwh(row) {
  return (row.import_t1_kwh || 0) + (row.import_t2_kwh || 0);
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
  const markup = Number(settings.market_markup_eur_kwh ?? 0);
  const vat = Number(settings.vat_rate ?? 0);
  const applyVat = (n) => (vat > 0 ? n * (1 + vat) : n);
  return {
    fixed,
    markup,
    vat,
    applyVat,
    priceSlots: buildPriceIndex(state.prices),
  };
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
  const { fixed, markup, applyVat, priceSlots } = ctx;
  let totalKwh = 0;
  let fixedCost = 0;
  let dynamicCost = 0;
  let matchedKwh = 0;
  let missingPriceHours = 0;

  for (const row of state.consumption) {
    const start = parsePbDate(row.period_start);
    if (!start) continue;
    const kwh = importKwh(row);
    if (kwh <= 0) continue;

    totalKwh += kwh;
    fixedCost += kwh * fixed;

    const hourCost = priceForHour(start.getTime(), kwh, priceSlots);
    if (hourCost == null) {
      missingPriceHours += 1;
      continue;
    }
    matchedKwh += kwh;
    dynamicCost += hourCost + kwh * markup;
  }

  fixedCost = applyVat(fixedCost);
  dynamicCost = applyVat(dynamicCost);

  const avgDynamic = matchedKwh > 0 ? dynamicCost / matchedKwh : null;
  const delta = fixedCost - dynamicCost;

  return {
    fixed,
    markup,
    totalKwh,
    matchedKwh,
    missingPriceHours,
    fixedCost,
    dynamicCost,
    avgDynamic,
    delta,
    priceSlotCount: priceSlots.length,
  };
}

function syncServiceUrl() {
  const fromSettings = (state.settings?.sync_service_url || "").trim();
  if (fromSettings) return fromSettings.replace(/\/$/, "");
  const host = window.location.hostname;
  const proto = window.location.protocol;
  return `${proto}//${host}:8098`;
}

async function triggerSync() {
  if (state.syncing) return;

  const url = `${syncServiceUrl()}/sync`;
  state.syncing = true;
  state.syncStartedAt = Date.now();
  setSyncControlsDisabled(true);
  setSyncBanner(
    "busy",
    "Synchroniseren",
    "Verbruik en prijzen ophalen (kan enkele minuten duren)…"
  );
  startSyncPoll();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: syncDaysForPeriod(), include_market_prices: true }),
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
    market_markup_eur_kwh: Number(form.market_markup_eur_kwh.value) || 0,
    vat_rate: Number(form.vat_rate.value) || 0,
    ha_url: form.ha_url.value.trim(),
    ha_token: form.ha_token.value.trim(),
    sync_service_url: form.sync_service_url.value.trim(),
    sensor_import_t1: form.sensor_import_t1.value.trim(),
    sensor_import_t2: form.sensor_import_t2.value.trim(),
    sensor_export_t1: form.sensor_export_t1.value.trim(),
    sensor_export_t2: form.sensor_export_t2.value.trim(),
    price_statistic_id: form.price_statistic_id.value.trim(),
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
  const period = PERIODS[state.period];
  const cheaper = summary.delta > 0 ? "dynamisch" : summary.delta < 0 ? "vast" : "gelijk";

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
      <p class="muted">Gewogen gemiddelde (dynamisch/simulatie)</p>
      <p class="hero-value">${summary.avgDynamic != null ? euro(summary.avgDynamic, 4) : "—"}<span class="unit">/kWh</span></p>
      <p class="muted small">Vast contract: ${euro(summary.fixed, 4)}/kWh (ingesteld)</p>
    </section>

    <section class="grid-2">
      <article class="card stat">
        <p class="muted">Kosten dynamisch</p>
        <p class="stat-value">${summary.matchedKwh > 0 ? euro(summary.dynamicCost) : "—"}</p>
        <p class="muted small">${kwh(summary.matchedKwh)} met prijsdata</p>
      </article>
      <article class="card stat">
        <p class="muted">Kosten vast</p>
        <p class="stat-value">${euro(summary.fixedCost)}</p>
        <p class="muted small">${kwh(summary.totalKwh)} import</p>
      </article>
    </section>

    <section class="card highlight ${summary.delta >= 0 ? "ok" : "warn"}">
      <p class="muted">Verschil in periode (${cheaper} voordeliger)</p>
      <p class="stat-value">${euro(Math.abs(summary.delta))}</p>
      <p class="muted small">${summary.delta >= 0 ? "Je zou met dynamisch minder betalen (simulatie)" : "Vast is goedkoper in deze simulatie"}</p>
    </section>

    <section class="card">
      <h2 class="card-title">Toelichting</h2>
      <ul class="notes">
        <li>Verbruik: P1 import tarief 1 + 2 per uur uit Home Assistant statistieken.</li>
        <li>Prijzen: day-ahead NL (Energy-Charts) + optioneel HA prijssensor. Uurverbruik wordt evenredig over prijs-slots in dat uur verdeeld.</li>
        <li>Opslag/belasting: stel <strong>markt-opslag</strong> en BTW in onder Instellingen voor vergelijkbare all-in tarieven.</li>
        ${summary.missingPriceHours ? `<li class="warn-text">${summary.missingPriceHours} uren zonder prijsdata (niet meegeteld in dynamisch). Laat het veld Nordpool/HA-prijs leeg en synchroniseer opnieuw om NL day-ahead (Energy-Charts) te gebruiken — zie tab Data.</li>` : ""}
      </ul>
      <p class="muted small sync-meta">Laatste sync: ${formatSyncTimestamp(state.settings?.last_sync_at)} · ${state.settings?.last_sync_message || "—"}</p>
      <button type="button" class="btn primary" id="syncBtn" ${state.syncing ? "disabled" : ""}>${state.syncing ? "Bezig met synchroniseren…" : "Synchroniseer met Home Assistant"}</button>
      <p class="muted small">Sync haalt <strong>${syncDaysForPeriod()} dag(en)</strong> op (volgt gekozen periode${state.period === "day" ? ", testmodus 24 uur" : ""}). Vaker syncen is veilig — geen dubbele rijen.</p>
    </section>
  `;

  appEl.querySelectorAll("[data-period]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.period = btn.dataset.period;
      await refresh();
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
  const hourlyLimit = state.period === "day" ? 48 : state.period === "month" ? 744 : 200;
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
      <p class="muted small">Verschil = <strong>totale €</strong> vast − dynamisch dit uur: (vast €/kWh − dynamisch €/kWh) × kWh. Beide €/kWh-kolommen zijn all-in (markt-opslag + BTW uit Instellingen). Zet BTW op 0 als je vaste €0,28 al inclusief BTW is.</p>
      ${hourly.truncated ? `<p class="muted small warn-text">Toont ${hourly.rows.length} van ${hourly.total} uren met verbruik (nieuwste eerst).</p>` : ""}
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Uur</th>
              <th>Verbruik</th>
              <th>Vast €/kWh</th>
              <th>Dynamisch €/kWh</th>
              <th>Verschil (€)</th>
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
  `;

  appEl.querySelectorAll("[data-period]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.period = btn.dataset.period;
      await refresh();
    });
  });
}

function renderSettings() {
  const s = state.settings || {};
  appEl.innerHTML = `
    <form class="card form" id="settingsForm">
      <h2 class="card-title">Tarief</h2>
      <label>Vaste prijs (€/kWh)
        <input name="fixed_tariff_eur_kwh" type="number" step="0.0001" min="0" value="${s.fixed_tariff_eur_kwh ?? 0.28}" required />
      </label>
      <label>Markt-opslag dynamisch (€/kWh)
        <input name="market_markup_eur_kwh" type="number" step="0.0001" min="0" value="${s.market_markup_eur_kwh ?? 0}" />
      </label>
      <label>BTW (0 = 0%, 0.21 = 21%)
        <input name="vat_rate" type="number" step="0.01" min="0" max="1" value="${s.vat_rate ?? 0}" />
      </label>
      <p class="muted small">Vaste én dynamische prijs krijgen dezelfde BTW in de berekening. Is je vaste tarief <strong>al inclusief BTW</strong> (typisch op je contract)? Zet BTW dan op <strong>0</strong>.</p>

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
  `;

  document.getElementById("settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings(e.target).catch((err) => toast(err.message));
  });
}

function render() {
  periodLabel.textContent = PERIODS[state.period].label;
  const titles = { compare: "Vergelijk", data: "Data", settings: "Instellingen" };
  pageTitle.textContent = titles[state.view] || "DynCompare";

  if (state.view === "compare") renderCompare();
  else if (state.view === "data") renderData();
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
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
    tab.classList.add("is-active");
    state.view = tab.dataset.view;
    render();
  });
});

refreshBtn?.addEventListener("click", () => {
  if (!state.syncing) refresh();
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
