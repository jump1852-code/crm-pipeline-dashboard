/* CRM Pipeline Dashboard — vanilla JS, no build step.
 * Every measure is a plain function over the filtered opportunity table, the same way a
 * DAX measure is evaluated over the filter context in Power BI. See README → "Power BI mapping". */
(() => {
  "use strict";

  const STAGES = ["Qualify", "Develop", "Propose", "Negotiate"];
  const STAGE_COLOR = { Qualify: "#9fb7c2", Develop: "#4d8dff", Propose: "#0048b6", Negotiate: "#04cc9e", Won: "#003143" };
  const STAGE_PROB = { Qualify: 10, Develop: 25, Propose: 50, Negotiate: 75 };
  const AVATAR = ["#0048b6", "#04a57f", "#003143", "#7b61ff", "#d9480f", "#0b7285", "#c2255c", "#5c940d", "#364fc7", "#e67700", "#495057"];
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const state = { period: "FY", country: "", owner: "", line: "", view: "overview", ganttSort: "close" };
  let DATA, OPPS, META, AS_OF, charts = {};

  // ---------- formatting ----------
  const money = (v, digits) => {
    const a = Math.abs(v);
    if (a >= 1e6) return `$${(v / 1e6).toFixed(digits ?? 2)}M`;
    if (a >= 1e3) return `$${(v / 1e3).toFixed(digits ?? (a >= 1e5 ? 0 : 1))}K`;
    return `$${Math.round(v)}`;
  };
  const pct = (v, d = 0) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : "—");
  const d = (s) => new Date(`${s}T00:00:00Z`);
  const days = (a, b) => Math.round((d(b) - d(a)) / 864e5);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDate = (s) => `${d(s).getUTCDate()} ${MON[d(s).getUTCMonth()]}`;
  const initials = (n) => n.split(" ").map((p) => p[0]).join("").slice(0, 2);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- filter context ----------
  function periodRange() {
    const fy = META.fiscal_year;
    if (state.period === "FY") return [`${fy}-01-01`, `${fy}-12-31`, [1, 2, 3, 4]];
    const q = Number(state.period.slice(1));
    const start = new Date(Date.UTC(fy, (q - 1) * 3, 1));
    const end = new Date(Date.UTC(fy, q * 3, 0));
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), [q]];
  }
  const inDims = (o) =>
    (!state.country || o.country === state.country) && (!state.owner || o.owner === state.owner) && (!state.line || o.product_line === state.line);
  const between = (s, a, b) => s && s >= a && s <= b;

  function context() {
    const [start, end, quarters] = periodRange();
    const rows = OPPS.filter(inDims);
    const closed = rows.filter((o) => o.status !== "Open" && between(o.actual_close_date, start, end));
    const won = closed.filter((o) => o.status === "Won");
    const lost = closed.filter((o) => o.status === "Lost");
    const open = rows.filter((o) => o.status === "Open");
    // open deals expected to close in the period; overdue deals roll into "today"
    const openInPeriod = open.filter((o) => {
      const c = o.est_close_date < AS_OF ? AS_OF : o.est_close_date;
      return between(c, start, end);
    });
    const tgt = DATA.targets.filter(
      (t) => quarters.includes(t.quarter) && (!state.country || t.country === state.country) && (!state.owner || t.owner === state.owner),
    );
    const quota = tgt.reduce((s, t) => s + t.quota, 0);
    return { start, end, quarters, rows, closed, won, lost, open, openInPeriod, quota, tgt };
  }

  // ---------- measures ----------
  const sum = (arr, f = (o) => o.amount) => arr.reduce((s, o) => s + f(o), 0);
  const weighted = (arr) => sum(arr, (o) => (o.amount * o.probability) / 100);

  function measures(c) {
    const wonAmt = sum(c.won);
    const winRate = c.closed.length ? c.won.length / c.closed.length : NaN;
    const remaining = Math.max(0, c.quota - wonAmt);
    const periodOver = c.end < AS_OF;
    const coverage = remaining > 0 && !periodOver ? sum(c.openInPeriod) / remaining : NaN;
    const committed = sum(c.openInPeriod.filter((o) => o.forecast_category === "Committed"));
    const forecast = wonAmt + (periodOver ? 0 : weighted(c.openInPeriod));
    const cycle = c.won.length ? c.won.reduce((s, o) => s + days(o.created_on, o.actual_close_date), 0) / c.won.length : NaN;
    return { wonAmt, winRate, remaining, coverage, committed, forecast, cycle, periodOver, openAmt: sum(c.open) };
  }

  const rag = (ratio, good = 1, warn = 0.85) => (ratio >= good ? "var(--good)" : ratio >= warn ? "var(--warn)" : "var(--bad)");

  // ---------- KPI scorecard ----------
  function renderKpis(c, m) {
    const T = META.kpi_targets;
    const att = c.quota ? m.wonAmt / c.quota : NaN;
    const fcAtt = c.quota ? m.forecast / c.quota : NaN;
    const cards = [
      { h: "Won revenue", v: money(m.wonAmt), t: `of ${money(c.quota)} quota`, b: pct(att), ratio: att, mark: 1,
        color: m.periodOver ? rag(att) : rag(att, 0.75, 0.6) },
      { h: "Forecast (weighted)", v: money(m.forecast), t: "won + Σ amt × prob.", b: pct(fcAtt), ratio: fcAtt, mark: 1, color: rag(fcAtt, 1, 0.9) },
      { h: "Win rate", v: pct(m.winRate), t: `target ${T.win_rate}%`, b: `${c.won.length}/${c.closed.length} deals`, ratio: m.winRate / (T.win_rate / 100) / 1.5,
        mark: 1 / 1.5, color: rag(m.winRate / (T.win_rate / 100), 1, 0.85) },
      { h: "Pipeline coverage", v: Number.isFinite(m.coverage) ? `${m.coverage.toFixed(1)}×` : m.periodOver ? "Closed" : "Met",
        t: `target ${T.coverage.toFixed(1)}× remaining`, b: m.periodOver ? "period ended" : money(m.remaining) + " gap",
        ratio: Number.isFinite(m.coverage) ? m.coverage / T.coverage / 1.5 : 1, mark: 1 / 1.5,
        color: Number.isFinite(m.coverage) ? rag(m.coverage / T.coverage, 1, 0.7) : "var(--good)" },
      { h: "Avg sales cycle", v: Number.isFinite(m.cycle) ? `${Math.round(m.cycle)} d` : "—", t: `target ≤ ${T.cycle_days} d`,
        b: "created → won", ratio: Number.isFinite(m.cycle) ? m.cycle / T.cycle_days / 1.5 : 0, mark: 1 / 1.5,
        color: rag(T.cycle_days / (m.cycle || Infinity), 1, 0.85) },
      { h: "Open pipeline", v: money(m.openAmt), t: `${c.open.length} open deals`, b: `${money(m.committed)} committed`,
        ratio: m.openAmt ? m.committed / m.openAmt : 0, mark: null, color: "var(--blue)" },
    ];
    $("#kpis").innerHTML = cards
      .map(
        (k) => `<div class="kpi" style="--rag:${k.color}">
        <h3>${k.h}</h3><div class="v">${k.v}</div>
        <div class="t"><span>${k.t}</span><b>${k.b}</b></div>
        <div class="bullet" aria-hidden="true"><i style="width:${Math.max(0, Math.min(1, k.ratio || 0)) * 100}%"></i>${
          k.mark != null ? `<u style="--mark:${k.mark * 100}%"></u>` : ""
        }</div></div>`,
      )
      .join("");
  }

  // ---------- Funnel (cohort: deals created in period) ----------
  function reached(o) {
    if (o.status === "Won") return 4;
    if (o.status === "Lost") return STAGES.indexOf(o.lost_at_stage);
    return STAGES.indexOf(o.stage);
  }
  function renderFunnel(c) {
    const cohort = c.rows.filter((o) => between(o.created_on, c.start, c.end));
    const levels = [...STAGES, "Won"].map((name, i) => {
      const deals = cohort.filter((o) => reached(o) >= i);
      return { name, n: deals.length, amt: sum(deals) };
    });
    const max = levels[0].n || 1;
    let html = "";
    levels.forEach((l, i) => {
      if (i > 0) {
        const conv = levels[i - 1].n ? l.n / levels[i - 1].n : 0;
        html += `<div class="f-row"><span></span><div class="f-conv">▼ <b>${pct(conv)}</b> convert</div><span></span></div>`;
      }
      const w = Math.max(8, (l.n / max) * 100);
      html += `<div class="f-row">
        <div class="lbl">${l.name}<small>${i < 4 ? `${STAGE_PROB[l.name]}% prob.` : "closed"}</small></div>
        <div class="f-track"><div class="f-bar" style="width:${w}%;background:${STAGE_COLOR[l.name]}">${l.n}</div></div>
        <div class="val">${money(l.amt)}<small>${pct(l.n / max)} of cohort</small></div></div>`;
    });
    $("#funnel").innerHTML = cohort.length ? html : `<p class="muted">No deals created in this period for the current filters.</p>`;
  }

  // ---------- Forecast chart ----------
  function monthsIn(c) {
    const out = [];
    for (let m = d(c.start); m <= d(c.end); m.setUTCMonth(m.getUTCMonth() + 1)) out.push(m.toISOString().slice(0, 7));
    return out;
  }
  function renderForecast(c) {
    const months = monthsIn(c);
    const by = (arr, key, cat) =>
      months.map((mo) => sum(arr.filter((o) => (key(o) || "").startsWith(mo) && (!cat || o.forecast_category === cat))));
    const closeKey = (o) => (o.est_close_date < AS_OF ? AS_OF : o.est_close_date);
    const won = by(c.won, (o) => o.actual_close_date);
    const committed = by(c.openInPeriod, closeKey, "Committed");
    const best = by(c.openInPeriod, closeKey, "Best case");
    const pipe = by(c.openInPeriod, closeKey, "Pipeline");
    const target = months.map((mo) => {
      const q = Math.floor((Number(mo.slice(5)) - 1) / 3) + 1;
      return sum(c.tgt.filter((t) => t.quarter === q), (t) => t.quota) / 3;
    });
    const labels = months.map((mo) => MON[Number(mo.slice(5)) - 1]);
    const ds = [
      { type: "line", label: "Target", data: target, borderColor: "#e5484d", borderDash: [6, 4], borderWidth: 2, pointRadius: 0, stepped: "middle", order: 0 },
      { label: "Won", data: won, backgroundColor: "#003143", stack: "s", order: 1 },
      { label: "Committed", data: committed, backgroundColor: "#04cc9e", stack: "s", order: 1 },
      { label: "Best case", data: best, backgroundColor: "#0048b6", stack: "s", order: 1 },
      { label: "Pipeline", data: pipe, backgroundColor: "#b9cbd3", stack: "s", order: 1 },
    ];
    if (charts.forecast) {
      charts.forecast.data.labels = labels;
      charts.forecast.data.datasets.forEach((x, i) => (x.data = ds[i].data));
      charts.forecast.update();
      return;
    }
    charts.forecast = new Chart($("#forecastChart"), {
      type: "bar",
      data: { labels, datasets: ds.map((x) => ({ ...x, borderRadius: x.type ? 0 : 3, maxBarThickness: 46 })) },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: "rectRounded" } },
          tooltip: { callbacks: { label: (x) => ` ${x.dataset.label}: ${money(x.raw)}` } },
        },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, ticks: { callback: (v) => money(v, v >= 1e6 ? 1 : 0) }, grid: { color: "#edf2f4" }, border: { display: false } },
        },
      },
    });
  }

  // ---------- Leaderboard ----------
  function renderLeaderboard(c) {
    const reps = [...new Set(c.tgt.map((t) => t.owner))].map((owner, i) => {
      const quota = sum(c.tgt.filter((t) => t.owner === owner), (t) => t.quota);
      const won = c.won.filter((o) => o.owner === owner);
      const closed = c.closed.filter((o) => o.owner === owner);
      return { owner, quota, wonAmt: sum(won), wr: closed.length ? won.length / closed.length : NaN, country: c.tgt.find((t) => t.owner === owner).country };
    });
    reps.sort((a, b) => b.wonAmt / b.quota - a.wonAmt / a.quota);
    const ownersAll = [...new Set(DATA.targets.map((t) => t.owner))];
    $("#leaderboard").innerHTML = `<table class="lb"><tbody>${reps
      .map((r, i) => {
        const att = r.quota ? r.wonAmt / r.quota : 0;
        const color = rag(att, c.end < AS_OF ? 1 : 0.75, c.end < AS_OF ? 0.85 : 0.6);
        return `<tr><td class="rank">${i + 1}</td>
          <td><div class="who"><span class="avatar" style="background:${AVATAR[ownersAll.indexOf(r.owner) % AVATAR.length]}">${initials(r.owner)}</span>
            <span>${esc(r.owner)}<br><small class="muted">${r.country}</small></span></div></td>
          <td class="bar-cell"><div class="mini"><i style="width:${Math.min(1, att) * 100}%;background:${color}"></i></div></td>
          <td class="num"><b>${pct(att)}</b><br><small class="muted">${money(r.wonAmt)} / ${money(r.quota)}</small></td>
          <td class="num muted">${pct(r.wr)}<br><small>win</small></td></tr>`;
      })
      .join("")}</tbody></table>`;
  }

  // ---------- Win rate by product line ----------
  function renderWinRate(c) {
    const T = META.kpi_targets.win_rate / 100;
    $("#wr-target").textContent = `${META.kpi_targets.win_rate}%`;
    const lines = [...new Set(OPPS.map((o) => o.product_line))].sort();
    const rows = lines.map((line) => {
      const cl = c.closed.filter((o) => o.product_line === line);
      const w = cl.filter((o) => o.status === "Won");
      return { line, n: cl.length, wr: cl.length ? w.length / cl.length : NaN, amt: sum(w) };
    });
    $("#winrate").innerHTML = `<div class="wr">${rows
      .map(
        (r) => `<div class="wr-row"><span>${esc(r.line)} <small class="muted">· ${r.n} closed</small></span><b>${pct(r.wr)}</b>
        <div class="mini"><i style="width:${(r.wr || 0) * 100}%;background:${rag((r.wr || 0) / T, 1, 0.85)}"></i><u style="left:${T * 100}%"></u></div></div>`,
      )
      .join("")}</div>`;
  }

  // ---------- Loss reasons ----------
  function renderLoss(c) {
    const reasons = {};
    c.lost.forEach((o) => (reasons[o.loss_reason] = (reasons[o.loss_reason] || 0) + 1));
    const entries = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
    const data = { labels: entries.map((e) => e[0]), datasets: [{ data: entries.map((e) => e[1]), backgroundColor: ["#003143", "#0048b6", "#04cc9e", "#4d8dff", "#9fb7c2", "#f0a202"], borderWidth: 2, borderColor: "#fff" }] };
    if (charts.loss) { charts.loss.data = data; charts.loss.update(); return; }
    charts.loss = new Chart($("#lossChart"), {
      type: "doughnut",
      data,
      options: { maintainAspectRatio: false, cutout: "62%", plugins: { legend: { position: "right", labels: { boxWidth: 10, boxHeight: 10, font: { size: 11.5 } } } } },
    });
  }

  // ---------- Gantt (custom SVG visual) ----------
  function renderGantt(c) {
    const rows = [...c.open];
    const sorters = { close: (a, b) => a.est_close_date.localeCompare(b.est_close_date), amount: (a, b) => b.amount - a.amount, age: (a, b) => a.created_on.localeCompare(b.created_on) };
    rows.sort(sorters[state.ganttSort]);
    $("#gantt-sub").textContent = `${rows.length} open deals · created → expected close · red outline = past expected close date`;
    $("#gantt-legend").innerHTML = STAGES.map((s) => `<span style="--c:${STAGE_COLOR[s]}">${s}</span>`).join("") + `<span style="--c:#e5484d">Overdue</span>`;
    if (!rows.length) { $("#gantt").innerHTML = `<p class="muted">No open deals for these filters.</p>`; return; }
    const min = rows.reduce((m, o) => (o.created_on < m ? o.created_on : m), AS_OF);
    const max = rows.reduce((m, o) => (o.est_close_date > m ? o.est_close_date : m), AS_OF);
    const t0 = d(min.slice(0, 7) + "-01");
    const t1 = new Date(Date.UTC(d(max).getUTCFullYear(), d(max).getUTCMonth() + 1, 1));
    const W = Math.max(900, $("#gantt").clientWidth || 900), labelW = 260, rowH = 24, top = 30;
    const H = top + rows.length * rowH + 10;
    const x = (s) => labelW + ((d(s) - t0) / (t1 - t0)) * (W - labelW - 12);
    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gantt chart of open opportunities">`;
    for (let m = new Date(t0); m <= t1; m.setUTCMonth(m.getUTCMonth() + 1)) {
      const s = m.toISOString().slice(0, 10), xx = x(s);
      svg += `<line x1="${xx}" x2="${xx}" y1="${top - 6}" y2="${H}" stroke="#edf2f4"/>`;
      if (m < t1) svg += `<text x="${xx + 4}" y="16" font-size="11" fill="#5d7680">${MON[m.getUTCMonth()] + (m.getUTCMonth() === 0 || +m === +t0 ? ` ${m.getUTCFullYear()}` : "")}</text>`;
    }
    rows.forEach((o, i) => {
      const y = top + i * rowH;
      if (i % 2) svg += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="#f7fafb"/>`;
      const late = o.est_close_date < AS_OF;
      const x1 = x(o.created_on), x2 = Math.max(x(o.est_close_date), x1 + 6);
      const label = o.name.length > 32 ? `${o.name.slice(0, 31)}…` : o.name;
      svg += `<text x="8" y="${y + 16}" font-size="11.5" fill="#0d2630">${esc(label)}</text>`;
      svg += `<text x="${labelW - 8}" y="${y + 16}" font-size="11" fill="#5d7680" text-anchor="end">${money(o.amount, 0)}</text>`;
      svg += `<rect class="g-bar" data-id="${o.id}" x="${x1}" y="${y + 5}" width="${x2 - x1}" height="${rowH - 10}" rx="4" fill="${STAGE_COLOR[o.stage]}" ${late ? 'stroke="#e5484d" stroke-width="2"' : ""}/>`;
    });
    const tx = x(AS_OF);
    svg += `<line x1="${tx}" x2="${tx}" y1="${top - 6}" y2="${H}" stroke="#e5484d" stroke-width="1.5" stroke-dasharray="4 3"/>
      <rect x="${tx - 22}" y="${top - 12}" width="44" height="16" rx="8" fill="#e5484d"/><text x="${tx}" y="${top - 1}" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">TODAY</text></svg>`;
    $("#gantt").innerHTML = svg;
  }

  // ---------- Kanban ----------
  function renderKanban(c) {
    const cols = [...STAGES, "Won"];
    const LIMIT = 40;
    $("#kanban-board").innerHTML = cols
      .map((stage) => {
        const deals = stage === "Won" ? c.won : c.open.filter((o) => o.stage === stage);
        deals.sort((a, b) => b.amount - a.amount);
        return `<section class="col" data-stage="${stage}" style="--c:${STAGE_COLOR[stage]}" aria-label="${stage}">
          <div class="col__head"><h3>${stage === "Won" ? "Won (period)" : stage}</h3><span>${deals.length} · ${money(sum(deals))}</span></div>
          <div class="cards">${deals
            .slice(0, LIMIT)
            .map((o) => {
              const late = o.status === "Open" && o.est_close_date < AS_OF;
              const dt = o.status === "Won" ? o.actual_close_date : o.est_close_date;
              return `<article class="card" draggable="${o.status === "Open"}" data-id="${o.id}" style="--c:${STAGE_COLOR[stage]}">
                <div class="acct">${esc(o.account)}</div><div class="line">${esc(o.product_line)} · ${esc(o.owner.split(" ")[0])}</div>
                <div class="meta"><span class="amt">${money(o.amount)}</span><span class="date ${late ? "late" : ""}">${late ? "overdue · " : ""}${fmtDate(dt)}</span></div></article>`;
            })
            .join("")}${deals.length > LIMIT ? `<div class="more">+ ${deals.length - LIMIT} more</div>` : ""}</div></section>`;
      })
      .join("");
  }

  function wireKanban() {
    const board = $("#kanban-board");
    let dragId = null;
    board.addEventListener("dragstart", (e) => {
      const card = e.target.closest(".card");
      if (!card || card.getAttribute("draggable") !== "true") return;
      dragId = card.dataset.id;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragId);
    });
    board.addEventListener("dragend", () => { dragId = null; $$(".col.over").forEach((c) => c.classList.remove("over")); $$(".dragging").forEach((c) => c.classList.remove("dragging")); });
    board.addEventListener("dragover", (e) => { const col = e.target.closest(".col"); if (col && dragId) { e.preventDefault(); $$(".col.over").forEach((c) => c !== col && c.classList.remove("over")); col.classList.add("over"); } });
    board.addEventListener("drop", (e) => {
      const col = e.target.closest(".col");
      if (!col || !dragId) return;
      e.preventDefault();
      moveDeal(dragId, col.dataset.stage);
    });
  }

  function moveDeal(id, stage) {
    const o = OPPS.find((x) => x.id === id);
    if (!o) return;
    if (stage === "Won") {
      Object.assign(o, { status: "Won", stage: "Closed", probability: 100, forecast_category: "Won", actual_close_date: AS_OF });
    } else {
      Object.assign(o, { stage, probability: STAGE_PROB[stage], forecast_category: stage === "Negotiate" ? "Committed" : stage === "Propose" ? "Best case" : "Pipeline" });
    }
    render();
  }

  // ---------- tooltip for gantt ----------
  function wireTooltip() {
    const tip = $("#tip");
    $("#gantt").addEventListener("mousemove", (e) => {
      const bar = e.target.closest(".g-bar");
      if (!bar) { tip.hidden = true; return; }
      const o = OPPS.find((x) => x.id === bar.dataset.id);
      tip.innerHTML = `<b>${esc(o.name)}</b><br>${esc(o.account)}<br>${o.stage} · ${o.probability}% · ${money(o.amount)}<br>${fmtDate(o.created_on)} → ${fmtDate(o.est_close_date)} · ${esc(o.owner)}<br>Next: ${esc(o.next_step)}`;
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX + 14, innerWidth - r.width - 8)}px`;
      tip.style.top = `${Math.min(e.clientY + 14, innerHeight - r.height - 8)}px`;
    });
    $("#gantt").addEventListener("mouseleave", () => (tip.hidden = true));
  }

  // ---------- slicers ----------
  function fillSelect(sel, values) {
    const cur = sel.value;
    sel.innerHTML = `<option value="">All</option>` + values.map((v) => `<option>${esc(v)}</option>`).join("");
    sel.value = values.includes(cur) ? cur : "";
  }
  function syncSlicers() {
    fillSelect($("#f-country"), [...new Set(OPPS.map((o) => o.country))].sort());
    const owners = [...new Set(DATA.targets.filter((t) => !state.country || t.country === state.country).map((t) => t.owner))].sort();
    fillSelect($("#f-owner"), owners);
    if (!owners.includes(state.owner)) state.owner = "";
    fillSelect($("#f-line"), [...new Set(OPPS.map((o) => o.product_line))].sort());
    $("#f-country").value = state.country; $("#f-owner").value = state.owner; $("#f-line").value = state.line;
    $$("#period button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.p === state.period)));
  }
  function wireSlicers() {
    $("#period").innerHTML = ["FY", "Q1", "Q2", "Q3", "Q4"].map((p) => `<button type="button" data-p="${p}" aria-pressed="false">${p === "FY" ? `FY${META.fiscal_year}` : p}</button>`).join("");
    $("#period").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.period = b.dataset.p; render(); } });
    $("#f-country").addEventListener("change", (e) => { state.country = e.target.value; render(); });
    $("#f-owner").addEventListener("change", (e) => { state.owner = e.target.value; render(); });
    $("#f-line").addEventListener("change", (e) => { state.line = e.target.value; render(); });
    $("#gantt-sort").addEventListener("change", (e) => { state.ganttSort = e.target.value; render(); });
    $("#reset").addEventListener("click", () => { Object.assign(state, { period: "FY", country: "", owner: "", line: "" }); render(); });
    $$(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  }
  function setView(view) {
    state.view = view;
    $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
    $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
    history.replaceState(null, "", `#${view}`);
    render();
  }

  function render() {
    syncSlicers();
    const c = context();
    if (state.view === "overview") {
      const m = measures(c);
      renderKpis(c, m); renderFunnel(c); renderForecast(c); renderLeaderboard(c); renderWinRate(c); renderLoss(c);
    } else if (state.view === "timeline") renderGantt(c);
    else renderKanban(c);
  }

  async function init() {
    DATA = await (await fetch("data/crm.json")).json();
    OPPS = DATA.opportunities; META = DATA.meta; AS_OF = META.as_of;
    $("#fy").textContent = `FY${META.fiscal_year}`;
    $("#subtitle").textContent = `${META.company} · ${META.currency} · as of ${fmtDate(AS_OF)} ${META.as_of.slice(0, 4)} · ${OPPS.length} opportunities`;
    if (window.Chart) { Chart.defaults.font.family = "Inter, system-ui, sans-serif"; Chart.defaults.color = "#5d7680"; }
    wireSlicers(); wireKanban(); wireTooltip();
    const v = location.hash.slice(1);
    if (["overview", "timeline", "kanban"].includes(v)) setView(v); else render();
    let t; addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => state.view === "timeline" && render(), 150); });
  }
  init().catch((e) => { console.error(e); $("#subtitle").textContent = "Could not load data/crm.json"; });
})();
