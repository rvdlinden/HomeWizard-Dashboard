/* =====================================================================
 * HomeWizard Dashboard: zijbalk-panel voor Home Assistant
 * Zelfde weergave als de HomeWizard Energy-app; alle data via de HA-sessie
 * (hass.states en hass.callWS), dus zonder tokens of losse servers.
 * ===================================================================== */
const HWDASH_VERSION = "1.2.1";
const CHART_URL = new URL("./chart.umd.min.js", import.meta.url).href;

function loadChart() {
  if (window.Chart) return Promise.resolve();
  if (!window.__hwdashChart) {
    window.__hwdashChart = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = CHART_URL; s.onload = res;
      s.onerror = () => rej(new Error("Chart.js niet gevonden naast hwdash-panel.js"));
      document.head.appendChild(s);
    });
  }
  return window.__hwdashChart;
}

/* ------------------------- data-laag ------------------------------- */
// ISO-weeknummer (maandag als eerste dag)
function isoWeek(ts) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / 864e5 - 3 + (w1.getDay() + 6) % 7) / 7);
}
// Begin van het (contract)jaar waar datum a in valt; jaarStart = [dag, maand], standaard 1 januari.
function yearStart(a, jaarStart) {
  const [dg, mn] = jaarStart || [1, 1], y = a.getFullYear();
  const at = yr => new Date(yr, mn - 1, Math.min(dg, new Date(yr, mn, 0).getDate()));
  return a < at(y) ? at(y - 1) : at(y);
}
// Dagwaarden samenvoegen per groep (week of contractmaand): energie/kosten/water optellen, laadniveau middelen,
// spanning maximum. key(ts) geeft de groep, label(key) het label op de x-as.
function regroup(res, key, label) {
  const groups = [];
  res.ts.forEach((ts, i) => { const w = key(ts);
    if (!groups.length || groups[groups.length - 1].w !== w) groups.push({ w, idx: [] });
    groups[groups.length - 1].idx.push(i); });
  const agg = (a, how = "sum") => groups.map(g => {
    const v = g.idx.map(i => a[i]).filter(x => x != null);
    if (!v.length) return null;
    return how === "max" ? Math.max(...v) : how === "mean" ? v.reduce((s, x) => s + x, 0) / v.length : v.reduce((s, x) => s + x, 0);
  });
  const s = res.series, out = {};
  for (const k of ["imp", "exp", "solar", "chg", "dis", "water", "cost", "verbruik", "zelf"]) out[k] = agg(s[k]);
  out.soc = agg(s.soc, "mean");
  out.wp = s.wp.map(w => ({ ...w, data: agg(w.data) }));
  out.volt = s.volt.map(v => ({ ...v, data: agg(v.data, "max") }));
  return { ...res, labels: groups.map(g => label(g.w)), ts: groups.map(g => res.ts[g.idx[0]]), series: out };
}
const perWeek = res => regroup(res, isoWeek, String);
// Jaar: gewone kalendermaanden binnen het afrekenjaar. Alleen de afrekenmaand is gedeeld: bij start 19 mei is de
// eerste staaf 19-31 mei en de laatste 1-18 mei van het jaar erna (13 staven); bij start op de 1e blijven het er 12.
function perContractMonth(res, start, end) {
  const b = [start.getTime()];
  for (let t = new Date(start.getFullYear(), start.getMonth() + 1, 1); t < end; t = new Date(t.getFullYear(), t.getMonth() + 1, 1))
    b.push(t.getTime());
  const MN = ["j", "f", "m", "a", "m", "j", "j", "a", "s", "o", "n", "d"];
  const out = regroup(res, ts => { let k = 0; while (k < b.length - 1 && ts >= b[k + 1]) k++; return k; },
                      k => MN[new Date(b[k]).getMonth()]);
  return { ...out, ends: b.slice(1).concat(end.getTime()) };   // einde (exclusief) per staaf, voor de periode in de readout
}
const TARIFF = /(_t[1-4]\b|_t[1-4]_|tariff|tarief)/;
const PHASE = /(_l[123]\b|_l[123]_|phase|fase)/;
const NOT_MAIN = /(peak|piek|average|gemiddeld|max|min_|monthly|maand)/;
const VPHASE = /(?:_l|fase_?|phase_?)([123])(?![0-9])/;
const BGROUP = /(battery_?group|batterij_?groep)/;
const fnum = x => { const v = parseFloat(x); return isNaN(v) ? null : v; };
// Tekst uit Home Assistant (apparaatnamen, foutmeldingen) altijd escapen voordat het in HTML komt.
const esc = x => String(x ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Alleen deze onderdelen mogen via overrides worden aangepast (geen __proto__ e.d.).
const OVERRIDE_KEYS = ["grid", "solar", "battery", "wp", "water", "other", "cost"];

class HwData {
  constructor(panel) { this.panel = panel; this.mapping = null; this.error = null; this.cache = new Map(); }
  get hass() { return this.panel._hass; }
  get cfg() { return Object.assign({ prijs_kwh: 0.40, teruglever_prijs: null, solar_counter: "auto",
                                     battery_power_sign: 1, stroom_totaal: "auto", jaar_start: [1, 1], thema: "light", overrides: {} }, this.panel._panel?.config || {}); }

  async init() {
    try { this.mapping = await this.discover(); this.error = null; this.cache.clear(); }
    catch (e) { this.error = "Detectie mislukt: " + e.message; console.error("hwdash", e); }
  }

  async discover() {
    const hass = this.hass, cfg = this.cfg, states = hass.states;
    let ents;
    try { ents = await hass.callWS({ type: "config/entity_registry/list" }); }
    catch (e) { ents = Object.values(hass.entities || {}); }       // niet-admin gebruiker
    let devices = hass.devices || {};
    if (!Object.keys(devices).length) {
      try { devices = Object.fromEntries((await hass.callWS({ type: "config/device_registry/list" })).map(d => [d.id, d])); }
      catch (e) { devices = {}; }
    }
    const perDev = {};
    for (const e of ents) {
      if (e.platform !== "homewizard" || e.disabled_by || !e.entity_id.startsWith("sensor.")) continue;
      (perDev[e.device_id] ||= []).push(e);
    }
    const mp = { grid: { name: "P1 meter", import: [], export: [], power: null, voltage: [], battery_power: null }, solar: [], battery: [],
                 wp: [], water: null, other: [], cost: { cost: [], compensation: [], price: null } };

    for (const [devId, list] of Object.entries(perDev)) {
      const dev = devices[devId] || {};
      const name = dev.name_by_user || dev.name || "HomeWizard";
      const text = [dev.name_by_user, dev.name, dev.model, dev.model_id].filter(Boolean).join(" ").toLowerCase();
      const info = { imp: [], exp: [], power: [], bpow: [], volt: [], soc: [], wtot: [], wflow: [], tariff: [] };
      for (const e of list) {
        const eid = e.entity_id, a = (states[eid] || {}).attributes || {};
        const unit = a.unit_of_measurement, dc = a.device_class, sc = a.state_class;
        const uid = (e.unique_id || "").toLowerCase();
        const key = (e.translation_key || uid.slice(uid.indexOf("_") + 1) || eid).toLowerCase();
        const full = `${key} ${uid} ${eid}`.toLowerCase();
        const rank = [key.length, eid];
        const total = sc === "total_increasing" || sc === "total";
        if (["kWh", "Wh", "MWh"].includes(unit) && total) {
          if (TARIFF.test(full)) { info.tariff.push(eid); continue; }
          (full.includes("export") ? info.exp : info.imp).push(rank);
        } else if (["W", "kW"].includes(unit) && dc === "power") {
          if (BGROUP.test(full)) info.bpow.push(rank);                 // P1: battery group power
          else if (!PHASE.test(full) && !NOT_MAIN.test(full)) info.power.push(rank);
        } else if (unit === "V") {
          const ph = full.match(VPHASE);
          if (ph) info.volt.push([+ph[1], key.length, eid]);
        } else if (dc === "battery" || full.includes("state_of_charge")) info.soc.push(rank);
        else if ((dc === "water" && total) || full.includes("total_liter")) info.wtot.push(rank);
        else if (unit === "L/min" || /active_liter|water_?(gebruik|usage)/.test(full)) info.wflow.push(rank);
      }
      const pick = k => info[k].length ? info[k].slice().sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]))[0][1] : null;
      const imp = pick("imp"), exp = pick("exp"), pw = pick("power");
      const volt = [1, 2, 3].map(f => info.volt.filter(v => v[0] === f).sort((x, y) => x[1] - y[1])[0]?.[2]).filter(Boolean);
      const counter = () => {
        const m = cfg.solar_counter;
        if (m === "import" || m === "export") return m === "import" ? imp : exp;
        const c = [imp, exp].filter(Boolean);
        return c.length ? c.reduce((b, x) => (fnum(states[x]?.state) || 0) > (fnum(states[b]?.state) || 0) ? x : b) : null;
      };
      if (info.wtot.length && !imp) mp.water = { name, total: pick("wtot"), flow: pick("wflow") };
      else if (info.soc.length) mp.battery.push({ name, charge: imp, discharge: exp, power: pw, soc: pick("soc") });
      else if (text.includes("p1") || info.tariff.length)
        Object.assign(mp.grid, { name, power: pw, import: imp ? [imp] : [], export: exp ? [exp] : [],
                                 voltage: volt, battery_power: pick("bpow") });
      else if (/zon|solar|pv|omvormer|panel/.test(text)) mp.solar.push({ name, energy: counter(), power: pw });
      else if (/warmtepomp|heat ?pump|\bwp\b|binnen|buiten|ecodan/.test(text)) {
        const kind = text.includes("buiten") ? "buiten" : text.includes("binnen") ? "binnen" : "";
        mp.wp.push({ name, energy: imp || exp, power: pw, kind });
      } else if (imp || exp || pw) mp.other.push({ name, energy: imp || exp, power: pw });
    }
    mp.wp.sort((a, b) => ({ binnen: 0, buiten: 1 }[a.kind] ?? 2) - ({ binnen: 0, buiten: 1 }[b.kind] ?? 2));

    // kosten (en eventueel grid) uit het Energie-dashboard
    let prefs = {};
    try { prefs = await hass.callWS({ type: "energy/get_prefs" }) || {}; } catch (e) { /* niet ingesteld */ }
    const impP = [], expP = [];
    for (const src of prefs.energy_sources || []) {
      if (src.type !== "grid") continue;
      // HA bewaart de netbron tegenwoordig als één object (stat_energy_from/_to, entity_energy_price(_export));
      // oudere versies gebruiken lijsten flow_from/flow_to. Beide worden gelezen.
      const from = src.flow_from || (src.stat_energy_from ? [{ stat_energy_from: src.stat_energy_from, stat_cost: src.stat_cost,
        entity_energy_price: src.entity_energy_price }] : []);
      const to = src.flow_to || (src.stat_energy_to ? [{ stat_energy_to: src.stat_energy_to, stat_compensation: src.stat_compensation,
        entity_energy_price: src.entity_energy_price_export }] : []);
      for (const f of from) {
        const c = f.stat_cost || (states[`${f.stat_energy_from}_cost`] ? `${f.stat_energy_from}_cost` : null);
        if (c) mp.cost.cost.push(c);
        if (f.entity_energy_price && !mp.cost.price) mp.cost.price = f.entity_energy_price;   // bijv. een dynamische uurprijs
        if (f.stat_energy_from) impP.push(f.stat_energy_from);
      }
      for (const t of to) {
        const c = t.stat_compensation || (states[`${t.stat_energy_to}_compensation`] ? `${t.stat_energy_to}_compensation` : null);
        if (c) mp.cost.compensation.push(c);
        if (t.stat_energy_to) expP.push(t.stat_energy_to);
      }
    }
    if (!mp.grid.import.length) mp.grid.import = impP;
    if (!mp.grid.export.length) mp.grid.export = expP;

    for (const [k, v] of Object.entries(cfg.overrides || {})) {
      if (!OVERRIDE_KEYS.includes(k)) { console.warn("hwdash: onbekende override genegeerd:", k); continue; }
      if (v && typeof v === "object" && !Array.isArray(v) && mp[k] && typeof mp[k] === "object" && !Array.isArray(mp[k]))
        for (const [kk, vv] of Object.entries(v)) { if (!["__proto__", "constructor", "prototype"].includes(kk)) mp[k][kk] = vv; }
      else mp[k] = v;
    }
    return mp;
  }

  num(eid) { return eid ? fnum(this.hass.states[eid]?.state) : null; }

  now() {
    const m = this.mapping, n = e => this.num(e);
    if (!m) return { connected: false, error: this.error || "Bezig met detecteren…" };
    const sign = this.cfg.battery_power_sign || 1;
    const grid = n(m.grid.power);
    const sv = m.solar.map(s => n(s.power)).filter(v => v != null);
    const solar = sv.length ? sv.reduce((s, v) => s + Math.abs(v), 0) : null;
    const bats = m.battery.map(b => ({ name: b.name, power: n(b.power) == null ? null : n(b.power) * sign, soc: n(b.soc) }));
    const bp = bats.map(b => b.power).filter(v => v != null), socs = bats.map(b => b.soc).filter(v => v != null);
    // het batterijgroep-vermogen van de P1-meter heeft voorrang op de som van de losse batterijen
    const gb = n(m.grid.battery_power);
    const batt = gb != null ? gb * sign : bp.length ? bp.reduce((a, b) => a + b, 0) : null;
    const wps = m.wp.map(w => ({ name: w.name, kind: w.kind, power: n(w.power) == null ? null : Math.abs(n(w.power)) }));
    return { connected: true, error: null, ts: Date.now(), grid, solar, battery: batt, batteries: bats,
             soc: socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : null,
             verbruik: grid == null ? null : grid + (solar || 0) - (batt || 0),
             wp: wps, water: m.water ? n(m.water.flow) : null, volt: (m.grid.voltage || []).map(n) };
  }

  async period(view, dateStr) {
    const m = this.mapping;
    if (!m) throw new Error(this.error || "Bezig met detecteren…");
    const [Y, M, D] = dateStr.split("-").map(Number);
    let start, end, per;
    if (view === "day") { start = new Date(Y, M - 1, D); end = new Date(Y, M - 1, D + 1); per = "5minute"; }
    else if (view === "week") { const wd = (new Date(Y, M - 1, D).getDay() + 6) % 7;
      start = new Date(Y, M - 1, D - wd); end = new Date(Y, M - 1, D - wd + 7); per = "day"; }
    else if (view === "month") { start = new Date(Y, M - 1, 1); end = new Date(Y, M, 1); per = "day"; }
    else if (view === "year") {        // per dag ophalen en per (contract)maand samenvoegen, zodat elke startdatum kan
      start = yearStart(new Date(Y, M - 1, D), this.cfg.jaar_start);
      end = yearStart(new Date(start.getFullYear() + 1, start.getMonth(), start.getDate() + 1), this.cfg.jaar_start); per = "day"; }
    else throw new Error("onbekende view");

    const now = Date.now(), complete = end.getTime() <= now;
    const key = view + start.getTime(), hit = this.cache.get(key);
    if (hit && (complete || now - hit.t < 60000)) return hit.res;

    const groups = {
      imp: m.grid.import, exp: m.grid.export,
      solar: m.solar.map(s => s.energy).filter(Boolean),
      chg: m.battery.map(b => b.charge).filter(Boolean), dis: m.battery.map(b => b.discharge).filter(Boolean),
      water: m.water?.total ? [m.water.total] : [], cost: m.cost.cost, comp: m.cost.compensation,
    };
    const wpIds = m.wp.map(w => w.energy).filter(Boolean), socIds = m.battery.map(b => b.soc).filter(Boolean);
    const voltIds = m.grid.voltage || [];
    const ids = [...new Set([...Object.values(groups).flat(), ...wpIds, ...socIds, ...voltIds])];
    const fetch = async p => ids.length ? (await this.hass.callWS({
      type: "recorder/statistics_during_period", start_time: start.toISOString(), end_time: end.toISOString(),
      statistic_ids: ids, period: p, types: ["change", "mean", "max"], units: { energy: "kWh", volume: "L" },
    })) || {} : {};
    let stats = await fetch(per);
    if (per === "5minute" && !ids.some(i => (stats[i] || []).length)) { per = "hour"; stats = await fetch(per); }

    const t0 = start.getTime(), t1 = end.getTime();
    let step = null, bstart;
    if (per === "5minute" || per === "hour") {
      step = per === "5minute" ? 300 : 3600;
      const nb = Math.round((t1 - t0) / (step * 1000));
      bstart = Array.from({ length: nb }, (_, i) => t0 + i * step * 1000);
    } else if (per === "day") {
      const nb = Math.round((t1 - t0) / 864e5);
      bstart = Array.from({ length: nb }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i).getTime());
    } else bstart = Array.from({ length: 12 }, (_, i) => new Date(start.getFullYear(), i, 1).getTime());
    const nb = bstart.length;
    const index = ts => {
      if (step) return Math.floor((ts - t0) / (step * 1000));
      const d = new Date(ts);
      if (per === "day") return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - start) / 864e5);
      return d.getMonth();
    };
    const future = bstart.map(b => b > now);
    const series = (sids, typ = "change", agg = "sum") => {
      let out = future.map(f => f ? null : 0), cnt = new Array(nb).fill(0), have = false;
      for (const sid of sids) for (const row of stats[sid] || []) {
        const ts = typeof row.start === "number" ? row.start : new Date(row.start).getTime();
        const i = index(ts), v = row[typ];
        if (v == null || i < 0 || i >= nb || future[i]) continue;
        out[i] = (out[i] || 0) + v; cnt[i]++; have = true;
      }
      if (agg === "mean") out = out.map((o, i) => cnt[i] ? o / cnt[i] : null);
      return have || agg === "sum" ? out : new Array(nb).fill(null);
    };
    const S = {};
    for (const [k, v] of Object.entries(groups)) S[k] = series(v);
    S.soc = series(socIds, "mean", "mean");
    for (const k of ["imp", "exp", "solar", "chg", "dis"]) S[k] = S[k].map(v => v == null ? null : Math.max(v, 0));
    // zoals de app: zelfvoorzienend = opwek die niet teruggeleverd is (ook wat de batterij in gaat),
    // verbruik = afname van het net + zelfvoorzienend
    const verbruik = [], zelf = [];
    for (let i = 0; i < nb; i++) {
      if (future[i]) { verbruik.push(null); zelf.push(null); continue; }
      const z = Math.max((S.solar[i] || 0) - (S.exp[i] || 0), 0);
      zelf.push(z); verbruik.push((S.imp[i] || 0) + z);
    }
    // kosten van de afname en vergoeding voor de teruglevering apart; cost = wat je netto betaalt
    let costImp, comp, costSrc;
    if (groups.cost.length) { costImp = S.cost; comp = S.comp; costSrc = "ha"; }
    else {
      const p = this.cfg.prijs_kwh, fp = this.cfg.teruglever_prijs == null ? p : this.cfg.teruglever_prijs;
      costImp = S.imp.map(a => a == null ? null : a * p); comp = S.exp.map(e => e == null ? null : e * fp); costSrc = "vast";
    }
    const cost = costImp.map((c, i) => c == null ? null : c - (comp[i] || 0));
    const wps = m.wp.map(w => ({ name: w.name, kind: w.kind, data: w.energy ? series([w.energy]) : new Array(nb).fill(null) }));
    // spanning per fase: dag = gemiddelde per 5 min/uur, langere periodes = hoogste waarde per dag/maand
    const volt = voltIds.map((id, i) => ({ name: "L" + (i + 1), data: series([id], step ? "mean" : "max", "mean"),
                                          max: series([id], "max", "mean") }));
    const tot = a => a.reduce((s, x) => s + (x || 0), 0);
    const DG = ["zo", "ma", "di", "wo", "do", "vr", "za"], MN = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
    const labels = bstart.map(b => {
      const d = new Date(b);
      if (step) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      if (view === "week") return DG[d.getDay()];
      if (per === "day") return String(d.getDate());
      return MN[d.getMonth()][0];                       // jaar: j f m a … zoals de app
    });
    const T = {};
    for (const k of ["imp", "exp", "solar", "chg", "dis", "water"]) T[k] = tot(S[k]);
    Object.assign(T, { verbruik: tot(verbruik), zelf: tot(zelf), cost: tot(cost), cost_imp: tot(costImp), comp: tot(comp),
      soc: [...S.soc].reverse().find(x => x != null) ?? null, wp: wps.map(w => tot(w.data)),
      volt: volt.map(v => { const a = v.max.filter(x => x != null); return a.length ? Math.max(...a) : null; }) });
    try { T.verbruik_cost = await this.verbruikCost(start, end, groups, T.verbruik, costSrc); }
    catch (e) { T.verbruik_cost = null; console.warn("hwdash: kosten stroomverbruik", e); }
    let res = { view, period: per, step, start: start.toISOString(), end: end.toISOString(), labels, ts: bstart,
      series: { imp: S.imp, exp: S.exp, solar: S.solar, chg: S.chg, dis: S.dis, water: S.water, soc: S.soc,
                cost, verbruik, zelf, wp: wps,
                volt: volt.map(v => ({ name: v.name, data: v.data })) }, totals: T, cost_source: costSrc };
    if (view === "month") res = perWeek(res);          // maand: staven per weeknummer, zoals de app
    if (view === "year") res = perContractMonth(res, start, end);
    this.cache.set(key, { t: now, res });
    if (this.cache.size > 200) this.cache.clear();
    return res;
  }

  // Kosten van het totale stroomverbruik (net + zelfvoorzienend) met uurprijzen: per uur verbruik × prijs van dat uur.
  // Uurprijs uit de prijs-entiteit van het Energie-dashboard (statistiek of geschiedenis), anders kosten/afname of
  // vergoeding/teruglevering van dat uur; uren zonder afname of teruglevering krijgen de dichtstbijzijnde bekende prijs.
  async verbruikCost(start, end, groups, verbruik, costSrc) {
    if (costSrc !== "ha") return verbruik * this.cfg.prijs_kwh;
    const priceId = this.mapping.cost.price;
    const ids = [...new Set([...groups.imp, ...groups.exp, ...groups.solar, ...groups.cost, ...groups.comp,
                             ...(priceId ? [priceId] : [])])];
    const stats = await this.hass.callWS({ type: "recorder/statistics_during_period", start_time: start.toISOString(),
      end_time: end.toISOString(), statistic_ids: ids, period: "hour", types: ["change", "mean"], units: { energy: "kWh" } }) || {};
    const t0 = start.getTime(), nh = Math.round((Math.min(end.getTime(), Date.now()) - t0) / 36e5);
    if (nh <= 0) return 0;
    const hours = (sids, typ) => {
      const out = new Array(nh).fill(null);
      for (const sid of sids) for (const row of stats[sid] || []) {
        const ts = typeof row.start === "number" ? row.start : new Date(row.start).getTime();
        const i = Math.floor((ts - t0) / 36e5), v = row[typ];
        if (v != null && i >= 0 && i < nh) out[i] = (out[i] || 0) + v;
      }
      return out;
    };
    const imp = hours(groups.imp, "change"), exp = hours(groups.exp, "change"), sol = hours(groups.solar, "change");
    const cost = hours(groups.cost, "change"), comp = hours(groups.comp, "change");
    let price = priceId ? hours([priceId], "mean") : new Array(nh).fill(null);
    if (priceId && price.every(v => v == null)) {          // prijs-entiteit zonder statistiek: gebruik de geschiedenis
      try {
        const h = await this.hass.callWS({ type: "history/history_during_period", start_time: new Date(t0 - 36e5).toISOString(),
          end_time: end.toISOString(), entity_ids: [priceId], minimal_response: true, no_attributes: true,
          significant_changes_only: false });
        const rows = (h?.[priceId] || []).map(x => [(x.lu ?? x.lc) * 1000, fnum(x.s)]).filter(x => x[1] != null);
        price = price.map((_, i) => { const mid = t0 + i * 36e5 + 18e5; let v = null;
          for (const [t, p] of rows) { if (t <= mid) v = p; else break; } return v; });
      } catch (e) { /* geen geschiedenis beschikbaar */ }
    }
    price = price.map((p, i) => p ?? (imp[i] > 0.02 && cost[i] != null ? cost[i] / imp[i]
                                     : exp[i] > 0.02 && comp[i] != null ? comp[i] / exp[i] : null));
    const known = price.map((p, i) => p == null ? null : i).filter(i => i != null);
    if (!known.length) return verbruik * this.cfg.prijs_kwh;
    let total = 0;
    for (let i = 0; i < nh; i++) {
      const v = (imp[i] || 0) + Math.max((sol[i] || 0) - (exp[i] || 0), 0);
      if (!v) continue;
      const p = price[i] ?? price[known.reduce((b, k) => Math.abs(k - i) < Math.abs(b - i) ? k : b)];
      total += v * p;
    }
    return total;
  }
}

/* ------------------------- weergave ------------------------------- */
// kleuren zoals in de HomeWizard-app: paars = afname/verbruik/laden, groen = opwek/teruglevering/ontladen
const COL_LIGHT = { zelf: "#3db8ff", net: "#a020f0", terug: "#1ed97a", zon: "#1ed97a", laden: "#a020f0",
                    ontladen: "#1ed97a", wp: "#a020f0", water: "#3db8ff", soc: "#f2f2f2", v2: "#8f3dff" };
// dark theme: paars en groen een tintje donkerder, de gloed doet de rest
const COL_DARK = { ...COL_LIGHT, net: "#8c16d8", laden: "#8c16d8", wp: "#8c16d8", v2: "#7a2fe0",
                   terug: "#17bd69", zon: "#17bd69", ontladen: "#17bd69" };
const COL = { ...COL_LIGHT };                           // actief palet; wisselt mee met het thema
const vcol = i => [COL.net, COL.v2, COL.zelf][i % 3];   // spanning L1, L2, L3
const VLIMIT = 253;                                     // bovengrens netspanning (230 V + 10%)

const STYLE = `
:host{display:block;position:relative;height:100vh;height:100dvh;overflow:hidden;
  --bg:#000; --card:#141416; --card2:#2a2a2e; --txt:#f2f2f2; --mut:#8a8a90;
  background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.hidden{display:none!important}
svg.ic{width:20px;height:20px;flex:none}

/* kop */
#home{height:100%;overflow:auto;overscroll-behavior:none;padding-bottom:calc(130px + env(safe-area-inset-bottom))}
.hero{position:relative;overflow:hidden;background:linear-gradient(180deg,var(--sky1) 0%,var(--sky2) 55%,var(--sky3) 100%)}
.hero.night{--sky1:#25308e;--sky2:#2a2c86;--sky3:#2b2367;--hill1:#33286a;--hill2:#2b2260;--grd:#231a46;--grd2:#000;
  --cloud:#4048a8;--cloudo:.75;--tree1:#178a57;--tree2:#1fa368;--inner:#e9dcae;--win:#6f76b8;--lab:#b4b7dc;--wire:#17112f}
.hero.day{--sky1:#4a8ee0;--sky2:#7fb1e6;--sky3:#a7c8e6;--hill1:#2f8c50;--hill2:#267c46;--grd:#1d4a2d;--grd2:#081210;
  --cloud:#ffffff;--cloudo:.55;--tree1:#1f8f55;--tree2:#2aa866;--inner:#d6d0c2;--win:#a9d0ee;--lab:#e6eef9;--wire:#123020}
.stars{position:absolute;inset:0;width:100%;height:60%;pointer-events:none}
.hero.day .stars,.hero.night .mill{display:none}
.top{display:flex;align-items:center;justify-content:space-between;padding:max(8px,env(safe-area-inset-top)) 10px 0 8px;position:relative}
.top .l{display:flex;align-items:center;gap:2px}
.top h1{font-size:16px;margin:0;font-weight:500}
.top .r{display:flex;gap:4px;align-items:center}
ha-menu-button{--mdc-icon-button-size:40px;color:var(--txt)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--mut)}
.dot.ok{background:${COL.terug}} .dot.bad{background:#ff4d4d}
.iconbtn{width:40px;height:40px;border-radius:50%;display:grid;place-items:center}
.iconbtn svg{width:24px;height:24px}
#htitle{font-size:30px;font-weight:700;margin:10px 16px 0;position:relative}
.hrow{position:relative;display:grid}
.hrow.up{grid-template-columns:1fr 1fr;margin:26px auto 0;max-width:420px}
.hrow.up .hs:first-child{text-align:right;border-right:1px solid #ffffff2e;padding-right:16px}
.hrow.up .hs:last-child{padding-left:16px}
.hrow.down{grid-template-columns:1fr auto 1fr;padding:0 16px;max-width:600px;margin:0 auto}
.hrow.down .hs:nth-child(2){text-align:center} .hrow.down .hs:last-child{text-align:right}
.hs .k{font-size:12px;color:var(--lab)}
.hs .v{font-size:20px;font-weight:600;white-space:nowrap;margin-top:1px}
.hs .v small{font-size:13px;margin-left:3px}
.hs .v .p{font-size:14px;font-weight:500;margin-left:8px}
.house{display:block;width:100%;max-width:560px;margin:10px auto 0;position:relative}
.ground{background:linear-gradient(180deg,var(--grd) 0%,var(--grd2) 100%);margin-top:-1px;padding:4px 0 22px}
.house .c{fill:var(--cloud);opacity:var(--cloudo)} .house .h1{fill:var(--hill1)} .house .h2{fill:var(--hill2)}
.house .g{fill:var(--grd)} .house .t1{fill:var(--tree1)} .house .t2{fill:var(--tree2)}
.house .in{fill:var(--inner)} .house .win{fill:var(--win)}
.house .w{fill:none;stroke:var(--wire);stroke-width:5;stroke-linecap:round}
.house .wi{fill:none;stroke:#2a2d38;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}
.blades{transform-origin:715px 252px;animation:hwspin 7s linear infinite}
@keyframes hwspin{to{transform:rotate(360deg)}}
/* stroomlijnen: bewegende lichtstreepjes in de richting van de stroom */
.fl{fill:none;stroke:currentColor;stroke-width:6;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:14 138;
  filter:drop-shadow(0 0 4px currentColor);animation:hwflow var(--dur,1.5s) linear infinite;opacity:0;transition:opacity .5s}
.fl.on{opacity:1}
@keyframes hwflow{to{stroke-dashoffset:-152}}   /* = streepje + tussenruimte */
.fl.wa{stroke-width:5;stroke-dasharray:26 126}
.house .pipe{fill:none;stroke:#2a4fae;stroke-opacity:.55;stroke-width:5;stroke-linecap:round}
@media (prefers-reduced-motion:reduce){.fl,.blades{animation:none}}
.banner{margin:12px 12px 0;padding:10px 12px;border-radius:12px;background:#3a1515;color:#ffb3b3;font-size:13px}

/* kaarten */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,400px),1fr));gap:12px;padding:14px 12px}
.card{background:var(--card);border-radius:24px;padding:16px 10px 6px;min-width:0}
.ch{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:0 12px}
.cv{font-size:21px;font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv span{margin-right:8px} .cv small{font-size:14px;margin-left:4px} .cv .u{color:var(--mut);font-size:14px}
.cl{font-size:13px;margin-top:1px}
.cr{display:flex;align-items:center;gap:10px;font-size:14px;white-space:nowrap;padding-top:2px}
.cr svg.ic{width:24px;height:24px}
.ro{min-height:19px;font-size:13px;color:var(--mut);padding:2px 12px 0;white-space:nowrap;overflow:hidden}
.ro b{color:var(--txt);font-weight:600;margin-right:6px}
.cc{position:relative;height:190px}
.cmsg{color:var(--mut);text-align:center;padding:10px 20px 0;font-size:13px}

/* periodekiezer */
#pnav{position:absolute;left:50%;transform:translateX(-50%);bottom:max(12px,env(safe-area-inset-bottom));
  width:min(360px,calc(100% - 32px));background:#141416f0;border-radius:22px;padding:2px 5px 5px;z-index:5;
  box-shadow:0 8px 28px #000c;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.dn{display:flex;align-items:center;justify-content:center;gap:4px;height:40px}
.dn button{width:38px;height:38px;display:grid;place-items:center}
.dn button svg{width:22px;height:22px}
.dn button:disabled{opacity:.25}
.nlabel{font-size:16px;min-width:130px;text-align:center}
.tabs{display:flex;background:#0a0a0c;border-radius:999px;padding:3px}
.tabs button{flex:1;padding:6px 0;border-radius:999px;color:#d6d6da;font-size:13px}
.tabs button.on{background:var(--card2);color:var(--txt);font-weight:650}

/* detailscherm: liggend, met waarden boven de staven */
#detail{position:absolute;inset:0;z-index:20;background:#000;display:flex;flex-direction:column;padding:8px 14px 4px}
.dh{display:flex;align-items:flex-start;gap:8px}
.dh .back{width:36px;height:36px;display:grid;place-items:center;flex:none;margin-top:2px}
.dh .back svg{width:24px;height:24px}
.dh .dico svg.ic{width:30px;height:30px;margin-top:6px}
.dt{flex:1;min-width:0}
.dt .n{font-size:15px;font-weight:600}
.dt .cv{font-size:18px}
.dh .tabs{width:min(340px,48%);flex:none}
.dleg{display:flex;flex-wrap:wrap;gap:2px 14px;font-size:12px;color:#c9c9cf;margin:2px 0 0 76px}
.dleg i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.dleg i+i{margin-left:-8px}
#dro{min-height:34px;margin:4px 0 0 76px;font-size:13px;white-space:nowrap;overflow:hidden}
#dro b{display:block;font-size:13px;font-weight:600}
#dro span{margin-right:10px}
.dcc{flex:1;position:relative;min-height:100px}
#detail .dn{height:38px}
.cr .open{display:grid;place-items:center;padding:0;cursor:pointer}
@media (max-width:600px){            /* rechtop op een telefoon: tabs onder de kop, minder inspringen */
  .dh{flex-wrap:wrap}
  .dh .tabs{width:100%;order:3}
  .dleg,#dro{margin-left:8px}
}

/* dark theme: geen tegels, alles loopt in elkaar over; gloed in de eigen kleur */
:host(.dark){--bg:#050506;--card:transparent;--card2:#1c1c21;--mut:#77777f}
:host(.dark) .hero.day,:host(.dark) .hero.night{--sky1:#050507;--sky2:#0a0912;--sky3:#130e22;--hill1:#120f1f;--hill2:#0d0b17;
  --grd:#0a0912;--grd2:#050506;--cloud:#ffffff;--cloudo:.035;--tree1:#0e5f3c;--tree2:#127548;--inner:#d8c88f;--win:#2a2f5e;
  --lab:#8d8d99;--wire:#07060c}
:host(.dark) .hero .stars{opacity:.55}
:host(.dark) .hs .v{text-shadow:0 0 20px #ffffff3d}
:host(.dark) .fl{stroke-width:5;filter:drop-shadow(0 0 4px currentColor) drop-shadow(0 0 12px currentColor)}
:host(.dark) .cards{gap:0;padding:4px 0 14px}
:host(.dark) .card{border-radius:0;padding:22px 12px 12px;position:relative}
:host(.dark) .card::before{content:"";position:absolute;left:28px;right:28px;top:0;height:1px;
  background:linear-gradient(90deg,transparent,#ffffff1f 30%,#ffffff1f 70%,transparent)}
:host(.dark) .cv{overflow:visible}
:host(.dark) .cv span{display:inline-block;filter:drop-shadow(0 0 7px color-mix(in srgb,currentColor 75%,transparent))}
:host(.dark) .cr svg.ic{filter:drop-shadow(0 0 6px #ffffff70)}
:host(.dark) .ro{color:#7d7d86}
:host(.dark) #pnav{background:#0a0a0cf0;box-shadow:0 0 0 1px #ffffff14,0 10px 30px #000}
:host(.dark) .tabs{background:#000}
:host(.dark) .tabs button.on{background:#17171b;box-shadow:inset 0 -2px 0 #8c16d8,0 0 16px #8c16d840}
:host(.dark) #detail{background:#050506}
#theme .sun{display:none} :host(.dark) #theme .sun{display:inline} :host(.dark) #theme .moon{display:none}

/* instellingen */
#settings{position:absolute;inset:0;background:var(--bg);overflow:auto;padding:12px 16px;z-index:10}
#settings .top{padding:0 0 8px}
#settings p{font-size:14px}
#settings pre{background:var(--card);padding:12px;border-radius:12px;font-size:12px;
  white-space:pre-wrap;word-break:break-all;color:#cfcfd4}
.btn{background:var(--card2);padding:8px 12px;border-radius:12px;font-size:14px}
`;

const NAV = `<div class="dn">
    <button class="nprev" aria-label="Vorige"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l-7 7 7 7"/></svg></button>
    <span class="nlabel"></span>
    <button class="nnext" aria-label="Volgende"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5l7 7-7 7"/></svg></button>
    <button class="nlast" aria-label="Vandaag"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 5l7 7-7 7M17 5v14"/></svg></button>
  </div>`;
const TEMPLATE = `
<section id="home">
  <header class="hero night">
    <svg class="stars" viewBox="0 0 360 200" preserveAspectRatio="xMidYMin slice" aria-hidden="true" fill="#fff">
      <circle cx="232" cy="66" r="1.2"/><circle cx="282" cy="62" r="1.2"/><circle cx="252" cy="96" r="1.6"/>
      <circle cx="282" cy="100" r="1.1"/><circle cx="196" cy="52" r="1.5"/><circle cx="168" cy="26" r="1"/>
      <circle cx="320" cy="130" r=".9"/><circle cx="60" cy="140" r=".9"/></svg>
    <div class="top">
      <div class="l"><span id="menu"></span><h1>HomeWizard</h1></div>
      <div class="r"><span class="dot" id="conn"></span>
        <button class="iconbtn" id="theme" aria-label="Licht of donker thema"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path class="moon" d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/><g class="sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg></button>
        <button class="iconbtn" id="gear" aria-label="Instellingen"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M10.3 2.8h3.4l.6 2.6 1.6.9 2.5-.9 1.7 2.9-2 1.8v1.8l2 1.8-1.7 2.9-2.5-.9-1.6.9-.6 2.6h-3.4l-.6-2.6-1.6-.9-2.5.9-1.7-2.9 2-1.8v-1.8l-2-1.8 1.7-2.9 2.5.9 1.6-.9z"/></svg></button></div>
    </div>
    <div id="htitle"></div>
    <div class="hrow up">
      <div class="hs"><div class="k">Opwek</div><div class="v" id="h-opwek"></div></div>
      <div class="hs"><div class="k">Zelfvoorzienend</div><div class="v" id="h-zelf"></div></div>
    </div>
    <svg class="house" viewBox="-90 20 884 430" aria-hidden="true">
      <defs><linearGradient id="bolt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8ef0a0"/><stop offset="1" stop-color="#2fc8d8"/></linearGradient></defs>
      <g class="c"><circle cx="-10" cy="300" r="55"/><circle cx="60" cy="282" r="62"/><circle cx="128" cy="306" r="44"/><rect x="-90" y="300" width="262" height="44" rx="22"/></g>
      <g class="c"><circle cx="640" cy="272" r="48"/><circle cx="700" cy="252" r="58"/><circle cx="765" cy="282" r="45"/><rect x="598" y="272" width="210" height="44" rx="22"/></g>
      <g class="mill" stroke="#d6e4f2" stroke-width="3" stroke-linecap="round"><path d="M715 340V252"/><path class="blades" d="M715 252V218M715 252l29 17M715 252l-29 17"/></g>
      <path class="h2" d="M-90 345C40 300 160 300 300 335S560 300 794 318V450H-90z"/>
      <path class="h1" d="M-90 366C60 336 200 340 330 360S600 332 794 346V450H-90z"/>
      <path class="t1" d="M62 386c-14-52-6-124 24-156 26 32 32 104 20 156z"/>
      <ellipse class="t2" cx="98" cy="352" rx="28" ry="38"/><ellipse class="t2" cx="56" cy="364" rx="24" ry="24"/>
      <ellipse class="t1" cx="636" cy="374" rx="30" ry="18"/><ellipse class="t2" cx="676" cy="378" rx="22" ry="13"/>
      <rect class="g" x="-90" y="384" width="884" height="70"/>
      <path d="M-90 385H794" stroke="#00000030" stroke-width="2"/>
      <path class="w" d="M-90 410H340Q362 410 362 388M362 388Q362 410 384 410H794"/>
      <path class="pipe" id="w-water" d="M-90 428H794"/>
      <path class="fl wa" id="f-water" d="M-90 428H794"/>
      <path d="M112 205H278V385H112z" fill="#363946"/>
      <path d="M112 205L285 40H445L278 205z" fill="#3d4150"/>
      <path d="M152 190L298 56H405L262 190z" fill="#10233a"/>
      <path d="M112 205L285 40H445" fill="none" stroke="#4b4f5f" stroke-width="7" stroke-linejoin="round"/>
      <path d="M278 385V205L445 40L612 205V385z" fill="#424655"/>
      <path class="in" d="M449 66L594 210V385H449z"/>
      <path class="win" d="M449 70V172H550z"/>
      <path d="M449 172H594" stroke="#0000001a" stroke-width="2"/>
      <path d="M278 205L445 40L612 205" fill="none" stroke="#4b4f5f" stroke-width="9" stroke-linejoin="round"/>
      <path d="M452 330h52a8 8 0 0 1 8 8v47h-60z" fill="#b5ac9c"/><rect x="452" y="348" width="74" height="37" rx="6" fill="#c7bfb0"/>
      <path d="M527 276V385" stroke="#ebe7dd" stroke-width="3"/><path d="M514 262h28l4 15h-36z" fill="#f6f3ea"/>
      <rect x="120" y="222" width="60" height="42" rx="4" fill="#4b4f5e"/><circle cx="142" cy="243" r="15" fill="#1c1e26"/>
      <rect x="163" y="231" width="10" height="24" rx="2" fill="#3a3d4a"/><path d="M128 264v6M172 264v6" stroke="#2a2d38" stroke-width="4"/>
      <g id="bats"></g>
      <path class="wi" d="M362 140V268M362 326V386"/>
      <path class="wi" id="w-bat" d="M391 297H538"/>
      <path class="wi" id="w-wp" d="M333 297H151V266"/>
      <path class="fl" id="f-imp" d="M-90 410H340Q362 410 362 388V327"/>
      <path class="fl" id="f-exp" d="M362 327V388Q362 410 384 410H794"/>
      <path class="fl" id="f-zon" d="M362 140V268"/>
      <path class="fl" id="f-lad" d="M391 297H538"/>
      <path class="fl" id="f-ont" d="M538 297H391"/>
      <path class="fl" id="f-wp" d="M333 297H151V266"/>
      <circle cx="362" cy="297" r="28" fill="#0b0c10"/>
      <path d="M369 279l-16 22h12l-6 17 17-23h-12z" fill="url(#bolt)"/>
    </svg>
    <div class="ground"><div class="hrow down">
      <div class="hs"><div class="k">Net</div><div class="v" id="h-net"></div></div>
      <div class="hs"><div class="k">Kosten</div><div class="v" id="h-kosten"></div></div>
      <div class="hs"><div class="k">Teruglevering</div><div class="v" id="h-terug"></div></div>
    </div></div>
  </header>
  <div id="banner" class="banner hidden"></div>
  <div class="cmsg hidden" id="cmsg"></div>
  <div class="cards" id="cards"></div>
</section>

<nav id="pnav">
  ${NAV}
  <div class="tabs"></div>
</nav>

<section id="detail" class="hidden">
  <div class="dh">
    <button class="back" id="dback" aria-label="Terug"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l-7 7 7 7"/></svg></button>
    <span class="dico" id="dicon"></span>
    <div class="dt"><div class="n" id="dname"></div><div class="cv" id="dhead"></div></div>
    <div class="tabs"></div>
  </div>
  <div class="dleg" id="dleg"></div>
  <div id="dro"></div>
  <div class="dcc"><canvas id="dchart"></canvas></div>
  ${NAV}
</section>

<section id="settings" class="hidden">
  <div class="top"><h1>Instellingen</h1>
    <button class="iconbtn" id="sclose" aria-label="Sluiten">✕</button></div>
  <p id="sinfo" style="color:var(--mut)"></p>
  <p><button class="btn" id="redisc">Apparaten opnieuw zoeken</button></p>
  <pre id="smap"></pre>
</section>
`;

const IC = {
  stekker:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M2 12h5M8 6.5h4.5a5.5 5.5 0 0 1 0 11H8zM8 5v14M18 9.5h4M18 14.5h4"/></svg>',
  stroom:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3h8M9 3l-3 18M15 3l3 18M7.4 9h9.2M6.6 15h10.8M3 21h18M10 9l4 6M14 9l-4 6"/></svg>',
  zelf:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/><path d="M12 9.5V12l1.8 1.3"/></svg>',
  zon:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>',
  batterij:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="2.5" y="6.5" width="17" height="11" rx="2"/><path d="M21.5 10v4M12.5 8.5l-3 4h3.5l-3 3.5"/></svg>',
  wp:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 5.5a1.5 1.5 0 0 1 3 0v13a1.5 1.5 0 0 1-3 0zM10.5 5.5a1.5 1.5 0 0 1 3 0v13a1.5 1.5 0 0 1-3 0zM16 5.5a1.5 1.5 0 0 1 3 0v13a1.5 1.5 0 0 1-3 0zM3 8h2M3 16h2M19 8h2M19 16h2"/></svg>',
  water:'<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z"/></svg>',
};
const PERIODS = [["nu","Nu"],["day","Dag"],["week","Week"],["month","Maand"],["year","Jaar"]];
const DAGEN = ["zo","ma","di","wo","do","vr","za"];
const MAANDEN = ["jan","feb","mrt","apr","mei","jun","jul","aug","sep","okt","nov","dec"];
const MAANDEN_L = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

/* ---------------- opmaak ---------------- */
function today(){ const d=new Date(); d.setHours(12,0,0,0); return d; }
function iso(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function monday(d){ const x=new Date(d); x.setDate(x.getDate()-((x.getDay()+6)%7)); return x; }
const f1 = v => v==null||isNaN(v) ? "–" : (Math.abs(v)<10 ? v.toFixed(1) : v.toFixed(Math.abs(v)<100?1:0));
const fW = v => v==null ? "–" : Math.round(v).toLocaleString("nl-NL");
const fV = v => v==null ? "–" : v.toFixed(1);
const eur = v => v==null ? "–" : (v<0?"-€":"€") + Math.abs(v).toFixed(2);
// kaartkop: één gekleurde waarde met eenheid, of meerdere waarden met een grijze eenheid
const one = (txt, unit, col) => `<span style="color:${col}">${txt}<small>${unit}</small></span>`;
const many = (vals, unit) => vals.map(([t,c])=>`<span style="color:${c}">${t}</span>`).join("")+`<span class="u">${unit}</span>`;
const wpName = w => w.kind ? "Warmtepomp "+w.kind : w.name;

/* ---------------- grafieken ---------------- */
function grad(col, top="ee", bottom="30"){
  return ctx=>{
    const {chart}=ctx, area=chart.chartArea; if(!area) return col+"66";
    const g=chart.ctx.createLinearGradient(0,area.top,0,area.bottom);
    g.addColorStop(0,col+top); g.addColorStop(1,col+bottom); return g;
  };
}
function ds(label, data, col, o={}){
  const line = o.type!=="bar";
  // staven zoals de app: smal, afgeronde bovenkant, kleurverloop met een lichte rand; meerdere reeksen naast elkaar
  // (eigen stack per reeks, anders zet Chart.js ze op dezelfde plek)
  const bar = line ? {} : {borderWidth:1.5, borderRadius:{topLeft:6, topRight:6}, borderSkipped:"bottom",
    maxBarThickness:11, categoryPercentage:.55, barPercentage:1, stack:label};
  return Object.assign({label, data, borderColor:col, backgroundColor:grad(col),
    pointRadius:0, pointHitRadius:6, borderWidth:2, tension:.25, fill:line?"origin":false,
    stack:"a", spanGaps:false, unit:o.unit||"", _col:col}, bar, o);
}
// laadniveau: witte lijn op een eigen (onzichtbare) 0-100%-as; order -1 = als laatste getekend, dus bovenop
const socDs = data => ({label:"Laadniveau",type:"line",data,borderColor:COL.soc,borderWidth:1.5,pointRadius:0,
  tension:.3,fill:false,yAxisID:"y2",unit:"%",_col:COL.soc,order:-1});
// kaart met de spanning per fase; lijnen niet gestapeld, as rond 230 V
function voltCard(heads, sets){
  return {id:"volt", name:"Overvoltage", icon:IC.stroom, flat:true, limit:VLIMIT, yMin:220, yMax:260,
    head:many(heads.map((v,i)=>[fV(v),vcol(i)]),"V"),
    datasets:sets.map((d,i)=>ds(d.name,d.data,vcol(i),{type:"line",unit:"V",stack:"v"+i,
      fill:i===0?"start":false, backgroundColor:i===0?grad(COL.net,"55","10"):"transparent"}))};
}
// gestippelde grenslijn (overspanning)
const limitLine = y => ({ id:"limit", beforeDatasetsDraw(c){
  const s=c.scales.y, a=c.chartArea; if(!s||y>s.max||y<s.min) return;
  const py=s.getPixelForValue(y), g=c.ctx;
  g.save(); g.strokeStyle="#ffffff"; g.lineWidth=2.5; g.lineCap="round"; g.setLineDash([0,9]);
  g.beginPath(); g.moveTo(a.left,py); g.lineTo(a.right,py); g.stroke(); g.restore();
}});
// detailscherm: waarde boven elke staaf (zoals de app: 0.05, 2.8, 11, 414)
const fShort = v => { v=Math.abs(v); return v<1 ? v.toFixed(2) : v<10 ? v.toFixed(1) : String(Math.round(v)); };
const valueLabels = { id:"vlabels", afterDatasetsDraw(c){
  const g=c.ctx; g.save(); g.fillStyle="#e8e8ea"; g.font="11px system-ui,sans-serif"; g.textAlign="center"; g.textBaseline="bottom";
  c.data.datasets.forEach((d,i)=>{ if(d.type!=="bar") return; const meta=c.getDatasetMeta(i);
    meta.data.forEach((el,j)=>{ const v=d.data[j]; if(v==null||v===0) return; g.fillText(fShort(v), el.x, el.y-4); }); });
  g.restore();
}};
// dark theme: lijnen en staven gloeien in hun eigen kleur (laadniveau-lijn niet)
const glow = { id:"glow",
  beforeDatasetDraw(c,a){ const d=c.data.datasets[a.index]; if(d.yAxisID==="y2") return; c.ctx.save();
    c.ctx.shadowColor=(d._col||"#ffffff")+"dd"; c.ctx.shadowBlur=d.type==="bar"?18:16; },
  afterDatasetDraw(c,a){ if(c.data.datasets[a.index].yAxisID!=="y2") c.ctx.restore(); } };
const crosshair = { id:"cross", afterDatasetsDraw(c){
  const a=c.tooltip?.getActiveElements?.(); if(!a||!a.length) return;
  const x=a[0].element.x, {top,bottom}=c.chartArea, g=c.ctx;
  g.save(); g.strokeStyle="#d0d0d0"; g.lineWidth=1; g.beginPath(); g.moveTo(x,top); g.lineTo(x,bottom); g.stroke(); g.restore();
}};

/* ---------------- panel ---------------- */
function mountDashboard(host, root, data){
  const $ = s => root.querySelector(s), $$ = s => root.querySelectorAll(s);
  const st = { period:"day", anchor:today(), bats:null, now:null, day:null, live:[], data:null, charts:{}, sig:"", timer:null, want:null };
  const timers = [], cleanups = [];
  const has = v => { const m=data.mapping; if(!m) return false;
    return {zelf:m.grid.import.length>0&&m.solar.length>0, stroom:m.grid.import.length>0||!!m.grid.power,
      verbruik:m.grid.import.length>0||!!m.grid.power, zon:m.solar.length>0,
      batterij:m.battery.length>0||!!m.grid.battery_power, water:!!m.water,
      volt:(m.grid.voltage||[]).length>0}[v]; };

  /* kop */
  function renderHero(){
    $("#htitle").textContent = st.period==="nu" ? "Nu" : dateLabel();
    const n=st.now||{}, H={};
    if(st.period==="nu"){
      const zelf = n.verbruik==null ? null : Math.max(0, n.verbruik-Math.max(n.grid||0,0));
      H.opwek=[fW(n.solar),"W"]; H.zelf=[fW(zelf),"W", n.verbruik>0&&zelf!=null?Math.round(zelf/n.verbruik*100):null];
      H.net=[fW(n.grid==null?null:Math.max(n.grid,0)),"W"]; H.terug=[fW(n.grid==null?null:Math.max(-n.grid,0)),"W"];
      H.kosten=eur(st.day?.totals?.cost);
    } else {
      const T=st.data?.totals||{};
      H.opwek=[f1(T.solar),"kWh"]; H.zelf=[f1(T.zelf),"kWh", T.verbruik>0?Math.round(T.zelf/T.verbruik*100):null];
      H.net=[f1(T.imp),"kWh"]; H.terug=[f1(T.exp),"kWh"]; H.kosten=eur(T.cost);
    }
    for(const k of ["opwek","zelf","net","terug"])
      $("#h-"+k).innerHTML=`${H[k][0]}<small>${H[k][1]}</small>${H[k][2]!=null?`<span class="p">${H[k][2]}%</span>`:""}`;
    $("#h-kosten").textContent=H.kosten;
    $(".hrow.up").classList.toggle("hidden", !!data.mapping && !has("zon"));
  }
  /* huis: dag/nacht, batterijstapel en live stroomlijnen */
  function isDay(){
    const sun = data.hass?.states?.["sun.sun"]?.state;
    if(sun) return sun==="above_horizon";
    const h=new Date().getHours(); return h>=7 && h<20;
  }
  function renderHouse(){
    const n=st.now||{}, m=data.mapping, day=isDay();
    $(".hero").classList.toggle("day", day); $(".hero").classList.toggle("night", !day);
    const nb = m ? Math.min(4, m.battery.length || (m.grid.battery_power?1:0)) : 0;
    if(st.bats!==nb){
      st.bats=nb;
      $("#bats").innerHTML = Array.from({length:nb},(_,i)=>{ const y=385-30*(i+1);
        return `<rect x="540" y="${y+2}" width="46" height="27" rx="3" fill="#202129"/><rect x="556" y="${y+10}" width="3" height="11" rx="1.5" fill="#ff7ad9"/>`; }).join("");
    }
    $("#w-bat").style.display = nb ? "" : "none";
    $("#w-wp").style.display = m?.wp.length ? "" : "none";
    $("#w-water").style.display = m?.water ? "" : "none";
    const T=10, wpW=(n.wp||[]).reduce((s,w)=>s+(w.power||0),0);
    // meer vermogen = sneller, in stapjes zodat de animatie niet steeds herstart
    const speed = w => Math.min(2.6, Math.max(.6, 3.2-.6*Math.log10(w)));
    const flow=(id, w, col, min=T, dur=speed)=>{
      const el=$("#f-"+id), on=w!=null && w>min;
      el.classList.toggle("on", on); if(!on) return;
      el.style.color=col;
      // ×2.5: één animatieronde is 152 lang (was 60), zo blijft de snelheid van de streepjes gelijk
      el.style.setProperty("--dur", (Math.round(dur(w)*2.5*5)/5)+"s");
    };
    flow("imp", n.grid, COL.net);                     // net -> huis
    flow("exp", n.grid==null?null:-n.grid, COL.terug); // huis -> net
    flow("zon", n.solar, COL.zon);                    // zonnepanelen -> huis
    flow("lad", nb?n.battery:null, COL.terug);        // huis -> batterij (laden)
    flow("ont", nb&&n.battery!=null?-n.battery:null, COL.terug); // batterij -> huis (ontladen)
    flow("wp", m?.wp.length?wpW:null, COL.net, 20);  // warmtepomp: stand-by (< 20 W) telt niet mee
    flow("water", m?.water?n.water:null, COL.water, .05, l=>Math.min(3, Math.max(.8, 3-.25*l))); // L/min
  }
  function renderConn(){
    const n=st.now||{};
    $("#conn").className = "dot " + (n.connected==null?"":n.connected?"ok":"bad");
    $("#banner").textContent = n.error||""; $("#banner").classList.toggle("hidden", !n.error);
  }
  function msg(t){ $("#cmsg").textContent=t; $("#cmsg").classList.toggle("hidden",!t); }

  /* periode */
  function isCurrent(){
    const t=today(), a=st.anchor;
    switch(st.period){
      case "day": return iso(a)===iso(t);
      case "week": return iso(monday(a))===iso(monday(t));
      case "month": return a.getFullYear()===t.getFullYear()&&a.getMonth()===t.getMonth();
      case "year": return iso(yearStart(a, data.cfg.jaar_start))===iso(yearStart(t, data.cfg.jaar_start));
    } return true;
  }
  function shift(dir){
    const a=new Date(st.anchor);
    if(st.period==="day") a.setDate(a.getDate()+dir);
    if(st.period==="week") a.setDate(a.getDate()+7*dir);
    if(st.period==="month"){ a.setDate(1); a.setMonth(a.getMonth()+dir); }
    if(st.period==="year") a.setFullYear(a.getFullYear()+dir);
    if(a>today()) return; st.anchor=a; loadPeriod();
  }
  function dateLabel(){
    const a=st.anchor, t=today();
    if(st.period==="day"){
      const diff=Math.round((t-a)/864e5);
      if(diff===0) return "Vandaag"; if(diff===1) return "Gisteren";
      return `${DAGEN[a.getDay()]} ${a.getDate()} ${MAANDEN[a.getMonth()]}${a.getFullYear()!==t.getFullYear()?" "+a.getFullYear():""}`;
    }
    if(st.period==="week"){
      if(isCurrent()) return "Deze week";
      const m=monday(a), s=new Date(m); s.setDate(s.getDate()+6);
      return m.getMonth()===s.getMonth() ? `${m.getDate()} – ${s.getDate()} ${MAANDEN[s.getMonth()]}`
        : `${m.getDate()} ${MAANDEN[m.getMonth()]} – ${s.getDate()} ${MAANDEN[s.getMonth()]}`;
    }
    if(st.period==="month") return `${MAANDEN_L[a.getMonth()]} ${a.getFullYear()}`;
    const ys=yearStart(a, data.cfg.jaar_start);          // contractjaar: 2026/2027, kalenderjaar: 2026
    return ys.getMonth()===0 && ys.getDate()===1 ? String(ys.getFullYear()) : `${ys.getFullYear()}/${ys.getFullYear()+1}`;
  }
  async function loadPeriod(){
    clearInterval(st.timer);
    $$(".tabs button").forEach(b=>b.classList.toggle("on", b.dataset.p===st.period));
    $$(".dn").forEach(e=>e.classList.toggle("hidden", st.period==="nu"));
    if(st.period==="nu"){ st.data=null; msg(""); drawLive(); return; }
    $$(".nlabel").forEach(e=>e.textContent = dateLabel());
    $$(".nnext,.nlast").forEach(e=>e.disabled = isCurrent());
    st.data=null; renderHero(); msg("Laden…");
    const want = `${st.period}|${iso(st.anchor)}`; st.want = want;
    try{
      const d = await data.period(st.period, iso(st.anchor));
      if(st.want!==want) return;
      st.data=d; msg(""); drawPeriod();
    }catch(e){ msg(e.message); }
    if(isCurrent()) st.timer=setInterval(async()=>{
      try{ st.data = await data.period(st.period, iso(st.anchor)); drawPeriod(); }catch(e){}
    }, 60000);
  }

  /* kaarten */
  function periodCards(d){
    const s=d.series, T=d.totals, isDay=d.step!=null;
    const k = isDay ? 3600*1000/d.step : 1;            // kWh per bucket -> W
    const cv = a => a.map(v=>v==null?null:v*k);
    const ng = a => a.map(v=>v==null?null:-v*k);
    const o = x => Object.assign({type:isDay?"line":"bar", unit:isDay?"W":"kWh"}, x);
    // dag: teruglevering/ontladen onder de nullijn; week/maand/jaar: staven naast elkaar, alles boven nul
    const neg = (a, label, col) => isDay ? ds(label, ng(a), col, o({stack:"b"})) : ds(label, cv(a), col, o());
    const C = [];
    if(has("verbruik")) C.push({id:"verbruik", name:"Stroomverbruik", icon:IC.stekker,
      right:eur(T.verbruik_cost),
      head:one(f1(T.verbruik),"kWh",COL.net), datasets:[ ds("Verbruik",cv(s.verbruik),COL.net,o()) ]});
    // saldering: netto afname en netto kosten (zoals de app); zonder saldering afname en teruglevering apart.
    // "auto" splitst vanaf 2027, als de salderingsregeling stopt.
    const gv = data.cfg.stroom_totaal, apart = gv==="apart" || (gv==="auto" && new Date(d.start) >= new Date(2027,0,1));
    if(has("stroom")) C.push({id:"stroom", name:"Stroom totaal", icon:IC.stroom,
      right: apart ? `<span style="color:${COL.net}">${eur(T.cost_imp)}</span> · <span style="color:${COL.terug}">${eur(-T.comp)}</span>` : eur(T.cost),
      head: apart ? many([[f1(T.imp),COL.net],[f1(T.exp),COL.terug]],"kWh")
        : T.imp-T.exp < 0 ? one(f1(T.exp-T.imp),"kWh",COL.terug) : one(f1(T.imp-T.exp),"kWh",COL.net), // netto teruglevering: groen
      datasets:[ ds("Net",cv(s.imp),COL.net,o({sym:"↓"})), {...neg(s.exp,"Teruglevering",COL.terug), sym:"↑"} ]});
    if(has("zelf")) C.push({id:"zelf", name:"Zelfvoorzienend", icon:IC.zelf,
      head:many([[f1(T.zelf),COL.zelf],[f1(T.imp),COL.net],[f1(T.exp),COL.terug]],"kWh"),
      legend:[[[COL.zelf,COL.net],"Verbruik"],[[COL.zelf,COL.terug],"Opwek"]],
      datasets:[ ds("Zelfvoorzienend",cv(s.zelf),COL.zelf,o({sym:"⇕"})), ds("Net",cv(s.imp),COL.net,o({fill:isDay?"-1":false, sym:"↓"})) ]
        .concat(isDay?[]:[ds("Teruglevering",cv(s.exp),COL.terug,o({sym:"↑"}))]) });
    if(has("zon")) C.push({id:"zon", name:"Zonnepanelen", icon:IC.zon,
      head:one(f1(T.solar),"kWh",COL.zon), datasets:[ ds("Opwek",cv(s.solar),COL.zon,o()) ]});
    if(has("batterij")){
      const y2 = s.soc.some(v=>v!=null);
      C.push({id:"batterij", name:"Batterij", icon:IC.batterij, y2:y2&&isDay,
        head:many([[f1(T.chg),COL.laden],[f1(T.dis),COL.ontladen]],"kWh"),
        datasets:[ ds("Laden",cv(s.chg),COL.laden,o()), neg(s.dis,"Ontladen",COL.ontladen) ]
          .concat(y2&&isDay?[socDs(s.soc)]:[]) });      // laadniveau-lijn alleen bij Dag, zoals de app
    }
    s.wp.forEach((w,i)=>C.push({id:"wp"+i, name:wpName(w), icon:IC.wp,
      head:one(f1(T.wp[i]),"kWh",COL.wp), datasets:[ ds(w.name,cv(w.data),COL.wp,o()) ]}));
    if(has("water")) C.push({id:"water", name:"Watermeter", icon:IC.water,
      head:one(Math.round(T.water),"L",COL.water),
      datasets:[ ds("Water",s.water,COL.water,{type:isDay?"line":"bar",unit:"L"}) ]});
    if(has("volt") && s.volt?.length) C.push(voltCard(T.volt, s.volt));
    return C;
  }
  function liveCards(){
    const L=st.live, n=st.now||{};
    const p = f => L.map(x=>{ const v=f(x); return v==null?null:v; });
    const o = {type:"line", unit:"W", tension:0};
    const C = [];
    if(has("verbruik")) C.push({id:"verbruik", name:"Stroomverbruik", icon:IC.stekker,
      head:one(fW(n.verbruik),"W",COL.net), datasets:[ ds("Verbruik",p(x=>x.verbruik),COL.net,o) ]});
    if(has("stroom")) C.push({id:"stroom", name:"Stroom totaal", icon:IC.stroom,
      head:n.grid<0 ? one(fW(-n.grid),"W",COL.terug) : one(fW(n.grid),"W",COL.net),
      datasets:[ ds("Net",p(x=>x.grid==null?null:Math.max(x.grid,0)),COL.net,o),
                 ds("Teruglevering",p(x=>x.grid==null?null:Math.min(x.grid,0)),COL.terug,{...o,stack:"b"}) ]});
    if(has("zelf")) C.push({id:"zelf", name:"Zelfvoorzienend", icon:IC.zelf,
      head:many([[fW(n.solar),COL.zelf],[fW(n.verbruik),COL.net]],"W"),
      datasets:[ ds("Opwek",p(x=>x.solar),COL.zelf,o),
                 ds("Verbruik",p(x=>x.verbruik),COL.net,{...o,fill:false,stack:"b",backgroundColor:"transparent"}) ]});
    if(has("zon")) C.push({id:"zon", name:"Zonnepanelen", icon:IC.zon,
      head:one(fW(n.solar),"W",COL.zon), datasets:[ ds("Opwek",p(x=>x.solar),COL.zon,o) ]});
    if(has("batterij")){
      const b=n.battery, y2=L.some(x=>x.soc!=null);
      C.push({id:"batterij", name:"Batterij", icon:IC.batterij, y2,
        head:many([[fW(b==null?null:Math.max(b,0)),COL.laden],[fW(b==null?null:Math.max(-b,0)),COL.ontladen]],"W")
          +(n.soc!=null?`<span class="u">${Math.round(n.soc)}%</span>`:""),
        datasets:[ ds("Laden",p(x=>x.battery==null?null:Math.max(x.battery,0)),COL.laden,o),
                   ds("Ontladen",p(x=>x.battery==null?null:Math.min(x.battery,0)),COL.ontladen,{...o,stack:"b"}) ]
          .concat(y2?[socDs(p(x=>x.soc))]:[]) });
    }
    (n.wp||[]).forEach((w,i)=>C.push({id:"wp"+i, name:wpName(w), icon:IC.wp,
      head:one(fW(w.power),"W",COL.wp), datasets:[ ds(w.name,p(x=>x.wp?.[i]?.power),COL.wp,o) ]}));
    if(has("water")) C.push({id:"water", name:"Watermeter", icon:IC.water,
      head:one(n.water==null?"–":n.water.toFixed(1),"L/min",COL.water),
      datasets:[ ds("Water",p(x=>x.water),COL.water,{type:"line",unit:"L/min",tension:0}) ]});
    if(has("volt") && n.volt?.length)
      C.push(voltCard(n.volt, n.volt.map((v,i)=>({name:"L"+(i+1), data:p(x=>x.volt?.[i])}))));
    return C;
  }

  function baseOptions(labels, isDay, y2, ro, detail){
    const dark = host.classList.contains("dark");
    const tick = {color:dark?"#62626b":"#8a8a90", font:{size:detail?12:11}};
    return {
      animation:false, responsive:true, maintainAspectRatio:false,
      interaction:{mode:"index", intersect:false},
      plugins:{ legend:{display:false}, tooltip:{enabled:false, external:ctx=>readout(ctx, ro, detail)} },
      scales:{
        x:{ stacked:true, grid:{display:false}, border:{display:false},
            ticks:{ ...tick, maxRotation:0, autoSkip:!isDay,
              callback(v,i){ const l=this.chart.data.labels[i]; if(!isDay) return l;
                return /^(02|07|12|17|22):00$/.test(l)?l:null; } } },
        y:{ stacked:true, position:"right", grid:{color:dark?"#16161a":"#2c2c30"}, border:{display:false},
            ticks:{ ...tick, maxTicksLimit:5, callback:v=>String(+(+v).toFixed(2)) } },
        // alleen een schaal rechts, zoals de andere grafieken: de 0-100%-as van het laadniveau is onzichtbaar
        ...(y2?{ y2:{ display:false, min:0, max:100 } }:{})
      }
    };
  }
  // jaar: hele maand → "juni 2026"; gedeelde afrekenmaand → "19 – 31 mei 2026"
  function yearLabel(dt, endTs){
    const e = endTs ? new Date(endTs - 864e5/2) : null, last = new Date(dt.getFullYear(), dt.getMonth()+1, 0).getDate();
    if(!e || (dt.getDate()===1 && e.getDate()===last)) return `${MAANDEN_L[dt.getMonth()]} ${dt.getFullYear()}`;
    return `${dt.getDate()} – ${e.getDate()} ${MAANDEN[dt.getMonth()]} ${dt.getFullYear()}`;
  }
  function readout(ctx, ro, detail){
    const t=ctx.tooltip; if(!t||!t.dataPoints||!t.opacity){ if(!detail) ro.innerHTML=""; return; }
    const p=t.dataPoints, i=p[0].dataIndex, d=st.data;
    let when;
    if(st.period==="nu" || !d){ when = p[0].label; }
    else {
      const dt=new Date(d.ts[i]);
      when = d.step!=null ? `${DAGEN[dt.getDay()]} ${dt.getDate()} ${MAANDEN[dt.getMonth()]}. ${d.labels[i]}`
        : d.view==="year" ? yearLabel(dt, d.ends?.[i]) : d.view==="month" ? `Week ${d.labels[i]}`
        : `${DAGEN[dt.getDay()]} ${dt.getDate()} ${MAANDEN[dt.getMonth()]}`;
    }
    const vals = p.filter(x=>x.raw!=null).map(x=>{
      const ds=x.dataset, u=ds.unit, v=Math.abs(x.raw);
      const s = u==="W"? fW(v)+" W" : u==="V"? v.toFixed(1)+" V" : u==="%"? Math.round(v)+"%" : u==="L"? Math.round(v)+" L"
        : u==="L/min"? v.toFixed(1)+" L/min" : f1(v)+" kWh";
      if(detail){ const v2 = u==="kWh" ? v.toLocaleString("nl-NL",{minimumFractionDigits:2,maximumFractionDigits:2})+" kWh" : s;
        return `<span style="color:${ds._col}">${ds.sym||"●"} ${v2}</span>`; }
      return `<span style="color:${ds._col}">● ${s}</span>`;
    }).join(detail?"":"&nbsp;&nbsp;");
    ro.innerHTML = `<b>${when}</b>${vals}`;
  }

  function chartConfig(c, labels, isDay, live, ro, detail){
    const opts=baseOptions(labels, isDay, c.y2, ro, detail);
    if(live) Object.assign(opts.scales.x.ticks, {autoSkip:false,
      callback(v,i){   // vier tijden, gelijk verdeeld; leest de actuele labels want live worden alleen de data vervangen
        const L=this.chart.data.labels, step=Math.max(1, Math.ceil(L.length/(detail?6:4))); return i%step===0?L[i]:null; }});
    if(c.flat || (!isDay && !live)){       // spanning en alle staafgrafieken: niet stapelen
      opts.scales.x.stacked = opts.scales.y.stacked = false;
    }
    if(c.flat){
      Object.assign(opts.scales.y, {suggestedMin:c.yMin, suggestedMax:c.yMax});
    } else if(!c.datasets.some(d=>d.yAxisID!=="y2" && (d.stack==="b" || d.data.some(v=>v<0))))
      // zoals de app: alleen onder nul tekenen als er ook negatieve waarden zijn (teruglevering, ontladen)
      Object.assign(opts.scales.y, {min:0, suggestedMax:1});
    if(detail) opts.layout={padding:{top:18}};
    const type = c.datasets[0]?.type==="bar" ? "bar" : "line";
    // detail krijgt eigen kopieën van de datasets: Chart.js koppelt een dataset aan één grafiek
    const datasets = detail ? c.datasets.map(d=>({...d})) : c.datasets;
    return {type, data:{labels, datasets}, options:opts,
      plugins:[crosshair, ...(c.limit?[limitLine(c.limit)]:[]), ...(detail?[valueLabels]:[]),
               ...(host.classList.contains("dark")?[glow]:[])]};
  }

  /* detailscherm: per kaart, liggend, met alle waarden */
  function detailLegend(c){
    const items = c.datasets.map(d=>[[d._col], d.label]).concat(c.legend||[]);
    return items.map(([cols,l])=>`<span>${cols.map(x=>`<i style="background:${esc(x)}"></i>`).join("")}${esc(l)}</span>`).join("");
  }
  function renderDetail(cards, labels, isDay, live){
    if(!st.detail) return;
    const c = cards.find(x=>x.id===st.detail); if(!c){ closeDetail(); return; }
    $("#dicon").innerHTML=c.icon; $("#dname").textContent=c.name;
    $("#dhead").innerHTML=c.head+(c.right?`<span class="u" style="margin-left:10px">${c.right}</span>`:"");
    $("#dleg").innerHTML=detailLegend(c);
    const ch=st.dchart, sig=`${c.id}|${live}|${c.datasets.length}`;
    if(live && ch && st.dsig===sig){
      ch.data.labels=labels; ch.data.datasets.forEach((d,i)=>d.data=c.datasets[i].data); ch.update("none"); return;
    }
    ch?.destroy(); st.dsig=sig;
    st.dchart = new Chart($("#dchart"), chartConfig(c, labels, isDay, live, $("#dro"), true));
    // standaard de laatste staaf/tijd met gegevens selecteren
    const n=labels.length; let k=-1;
    for(let i=n-1;i>=0 && k<0;i--) if(c.datasets.some(d=>d.data[i]!=null && d.data[i]!==0)) k=i;
    selectDetail(k<0?n-1:k);
  }
  function selectDetail(i){
    const ch=st.dchart; if(!ch || i<0) return;
    const els=ch.data.datasets.map((d,di)=>({datasetIndex:di, index:i})).filter(e=>ch.data.datasets[e.datasetIndex].data[i]!=null);
    if(!els.length) return;
    ch.setActiveElements(els); ch.tooltip.setActiveElements(els, {x:0, y:0}); ch.update("none");
  }
  function openDetail(id){
    st.detail=id; st.dsig=""; $("#detail").classList.remove("hidden");
    history.pushState({...(history.state||{}), hwdash:"detail"}, "");
    redraw();
  }
  function closeDetail(){
    st.detail=null; st.dchart?.destroy(); st.dchart=null; $("#detail").classList.add("hidden");
  }
  function redraw(){ if(st.period==="nu") drawLive(); else drawPeriod(); }

  function destroyCharts(){ Object.values(st.charts).forEach(c=>c.destroy()); st.charts={}; }
  function renderCards(cards, labels, isDay, live){
    const box=$("#cards"), sig=(live?"nu|":"p|")+cards.map(c=>c.id).join();
    if(sig!==st.sig){
      destroyCharts(); st.sig=sig;
      box.innerHTML = cards.map(c=>`<article class="card" data-c="${c.id}">
        <div class="ch"><div style="min-width:0"><div class="cv"></div><div class="cl"></div></div>
          <div class="cr"><span class="ce"></span><button class="open" data-open="${c.id}" aria-label="Details">${c.icon}</button></div></div>
        <div class="ro"></div><div class="cc"><canvas></canvas></div></article>`).join("");
    }
    for(const c of cards){
      const el=box.querySelector(`[data-c="${c.id}"]`);
      el.querySelector(".cv").innerHTML=c.head; el.querySelector(".cl").textContent=c.name;
      el.querySelector(".ce").innerHTML=c.right||"";
      const ch=st.charts[c.id];
      if(live && ch && ch.data.datasets.length===c.datasets.length){
        ch.data.labels=labels; ch.data.datasets.forEach((d,i)=>d.data=c.datasets[i].data);
        ch.update("none"); continue;
      }
      ch?.destroy();
      st.charts[c.id] = new Chart(el.querySelector("canvas"), chartConfig(c, labels, isDay, live, el.querySelector(".ro")));
    }
    box.querySelectorAll(".open").forEach(b=>b.onclick=()=>openDetail(b.dataset.open));
    renderDetail(cards, labels, isDay, live);
    if(!cards.length && data.mapping) msg("Geen HomeWizard-apparaten gevonden. Controleer of de HomeWizard-integratie actief is; "+
      "via het tandwiel zie je wat er gedetecteerd is en met overrides kun je sensoren handmatig koppelen.");
  }
  function drawPeriod(){
    const d=st.data; if(!d || st.period==="nu") return;
    renderHero();
    renderCards(periodCards(d), d.labels, d.step!=null, false);
  }
  function drawLive(){
    const L=st.live;
    const labels=L.map(x=>new Date(x.ts).toLocaleTimeString("nl-NL",{hour:"2-digit",minute:"2-digit",second:"2-digit"}));
    renderHero();
    msg(L.length<2?"Live meting gestart…":"");
    renderCards(liveCards(), labels, false, true);
  }

  /* metingen */
  function pollNow(){
    st.now = data.now();
    if(st.now.ts){ st.live.push(st.now); if(st.live.length>300) st.live.shift(); }
    renderConn(); applyTheme(); renderHouse();      // applyTheme: volgt HA als die van licht naar donker wisselt
    if(st.period==="nu") drawLive();
  }
  async function pollDay(){
    try{ st.day = await data.period("day", iso(today())); }catch(e){}
    if(st.period==="nu") renderHero();
  }

  /* instellingen; de terugknop van Android/browser sluit ze weer */
  function showMapping(){
    $("#sinfo").textContent = data.error ||
      "Instellen via Instellingen → Apparaten & diensten → HomeWizard Dashboard → Configureren.";
    $("#sinfo").style.color = data.error ? "#ff6b6b" : "";
    $("#smap").textContent = JSON.stringify(data.mapping, null, 2);
  }
  function closeSettings(){ $("#settings").classList.add("hidden"); }
  $("#gear").onclick = () => {
    $("#settings").classList.remove("hidden"); showMapping();
    history.pushState({...(history.state||{}), hwdash:"settings"}, "");
  };
  $("#sclose").onclick = () => { if(history.state?.hwdash) history.back(); else closeSettings(); };
  $("#redisc").onclick = async () => {
    $("#smap").textContent = "Zoeken…"; await data.init(); st.sig = ""; showMapping(); loadPeriod();
  };
  const onPop = () => { if(!$("#settings").classList.contains("hidden")) closeSettings(); else if(st.detail) closeDetail(); };
  $("#dback").onclick = () => { if(history.state?.hwdash) history.back(); else closeDetail(); };
  const onResize = () => st.dchart?.resize();          // telefoon gekanteld: grafiek past zich aan
  window.addEventListener("resize", onResize); cleanups.push(() => window.removeEventListener("resize", onResize));
  window.addEventListener("popstate", onPop); cleanups.push(() => window.removeEventListener("popstate", onPop));

  /* navigatie */
  $$(".tabs").forEach(t=>t.innerHTML = PERIODS.map(([k,l])=>`<button data-p="${k}">${l}</button>`).join(""));
  $$(".tabs button").forEach(b=>b.onclick=()=>{ st.period=b.dataset.p; st.anchor=today(); loadPeriod(); });
  $$(".nprev").forEach(b=>b.onclick=()=>shift(-1)); $$(".nnext").forEach(b=>b.onclick=()=>shift(1));
  $$(".nlast").forEach(b=>b.onclick=()=>{ st.anchor=today(); loadPeriod(); });

  /* thema: de knop rechtsboven onthoudt de keuze per apparaat; anders geldt de optie uit Configureren
     (licht, donker of volg Home Assistant) */
  const storedTheme = () => { try{ return localStorage.getItem("hwdash-theme"); }catch(e){ return null; } };
  const wantDark = () => { const t = storedTheme() || data.cfg.thema;
    return t==="dark" || (t==="auto" && !!data.hass?.themes?.darkMode); };
  function applyTheme(){
    const dark = wantDark();
    if(dark===host.classList.contains("dark") && st.themed) return;
    st.themed = true; host.classList.toggle("dark", dark);
    Object.assign(COL, dark ? COL_DARK : COL_LIGHT);
    destroyCharts(); st.sig=""; st.dsig=""; st.dchart?.destroy(); st.dchart=null;
    redraw(); renderHouse();
  }
  $("#theme").onclick = () => {
    try{ localStorage.setItem("hwdash-theme", host.classList.contains("dark") ? "light" : "dark"); }catch(e){}
    applyTheme();
  };
  applyTheme();

  /* start */
  const onVis = () => { if(!document.hidden){ pollNow(); pollDay(); } };
  document.addEventListener("visibilitychange", onVis); cleanups.push(() => document.removeEventListener("visibilitychange", onVis));
  const onRot = () => setTimeout(() => Object.values(st.charts).forEach(c=>c.resize()), 300);
  window.addEventListener("orientationchange", onRot); cleanups.push(() => window.removeEventListener("orientationchange", onRot));
  pollNow(); pollDay(); loadPeriod();
  timers.push(setInterval(pollNow, 2000), setInterval(pollDay, 60000));
  return () => { timers.forEach(clearInterval); clearInterval(st.timer); destroyCharts(); st.dchart?.destroy(); cleanups.forEach(f=>f()); };
}

class HwdashPanel extends HTMLElement {
  set hass(h) {
    const first = !this._hass; this._hass = h;
    if (this._menu) this._menu.hass = h;
    if (first) this._start();
  }
  get hass() { return this._hass; }
  set narrow(n) { this._narrow = n; if (this._menu) this._menu.narrow = n; }
  set panel(p) { this._panel = p; }
  set route(r) {}

  connectedCallback() { if (this._hass && !this._stop) this._start(); }
  disconnectedCallback() { if (this._stop) { this._stop(); this._stop = null; } }

  async _start() {
    if (this._starting || this._stop || !this.isConnected) return;
    this._starting = true;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const root = this.shadowRoot;
    root.innerHTML = `<style>${STYLE}</style>${TEMPLATE}`;
    this._menu = document.createElement("ha-menu-button");
    this._menu.hass = this._hass; this._menu.narrow = this._narrow;
    root.getElementById("menu").appendChild(this._menu);
    try { await loadChart(); }
    catch (e) { root.getElementById("banner").textContent = e.message; root.getElementById("banner").classList.remove("hidden"); }
    if (!this._data) { this._data = new HwData(this); await this._data.init(); }
    this._stop = mountDashboard(this, root, this._data);
    this._starting = false;
  }
}
if (!customElements.get("hwdash-panel")) customElements.define("hwdash-panel", HwdashPanel);
console.info("%c HomeWizard-panel %c " + HWDASH_VERSION + " ", "background:#a020f0;color:#fff", "background:#222;color:#fff");
