/* Infra Panel — клиент. Чистый тёмный дашборд: визуализация всех данных, алерты, события docker. */
let tab = 'o',
  data = null,
  srvHist = null,
  uptimeMap = {},
  events = [],
  logId = null,
  logName = '',
  autoLogs = true,
  logTimer = null,
  scanToken = 0,
  filterText = '',
  filterSites = '',
  hist = { t: [], cpu: [], mem: [], per: new Map() };

const ACC = '#f97316',
  ACC2 = '#38bdf8',
  WARN = '#eab308',
  RED = '#ef4444';

async function api(p, opt) {
  const r = await fetch(p, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMb = (b) => (b > 1073741824 ? (b / 1073741824).toFixed(1) + ' ГБ' : Math.round(b / 1048576) + ' МБ');
const loadColor = (p) => (p > 90 ? RED : p > 70 ? WARN : ACC);
const timeShort = (t) => new Date(t).toLocaleTimeString('ru-RU');

setInterval(() => {
  const el = $('#clock');
  if (el) el.textContent = new Date().toLocaleString('ru-RU');
}, 1000);

/* ---------- история ---------- */
function sample() {
  if (!data) return;
  const cpu = data.containers.reduce((a, c) => a + (c.stats?.cpu || 0), 0);
  const mem = data.containers.reduce((a, c) => a + (c.stats?.mem || 0), 0);
  hist.t.push(Date.now());
  hist.cpu.push(cpu);
  hist.mem.push(data.host?.memTotal ? (mem / data.host.memTotal) * 100 : 0);
  for (const c of data.containers) {
    if (!hist.per.has(c.id)) hist.per.set(c.id, []);
    const a = hist.per.get(c.id);
    a.push(c.stats?.cpu || 0);
    if (a.length > 40) a.shift();
  }
  if (hist.t.length > 60) {
    hist.t.shift();
    hist.cpu.shift();
    hist.mem.shift();
  }
}

function fillFromServer(h) {
  srvHist = h;
  uptimeMap = h.uptime || {};
  if (h.cpu.length > 3) {
    hist.t = h.cpu.map((p) => p[0]);
    hist.cpu = h.cpu.map((p) => p[1]);
    hist.mem = h.mem.map((p) => p[1]);
  }
}

/* ---------- события docker (live) ---------- */
async function pumpEvents() {
  try {
    const res = await fetch('/api/events');
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.Type !== 'container') continue;
          events.unshift({ t: e.time * 1000, action: e.Action, name: e.Actor?.Attributes?.name || e.Actor?.ID?.slice(0, 12) || '?' });
          if (events.length > 30) events.pop();
          if (tab === 'o' && data) renderEvents();
        } catch { /* не JSON */ }
      }
    }
  } catch {
    /* stream закрыт — переподключимся */
  }
  setTimeout(pumpEvents, 5000);
}

function renderEvents() {
  const el = $('#events');
  if (!el) return;
  el.innerHTML = events
    .slice(0, 8)
    .map((e) => {
      const bad = /die|oom|kill|stop/.test(e.action);
      const good = /start|create/.test(e.action);
      return `<div class="evt"><span class="digit">${timeShort(e.t)}</span> <b class="${bad ? 'bad' : ''}">${esc(e.action)}</b> ${esc(e.name)}${good ? '' : ''}</div>`;
    })
    .join('') || '<div class="evt">нет событий за час</div>';
}

/* ---------- canvas ---------- */
function sparkline(cv, points, color, max) {
  const ctx = cv.getContext('2d');
  const w = (cv.width = cv.clientWidth * 2 || 200);
  const h = (cv.height = cv.clientHeight * 2 || 48);
  ctx.clearRect(0, 0, w, h);
  if (points.length < 2) return;
  const m = max || Math.max(...points, 1);
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - 3 - (p / m) * (h - 6);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function bigChart() {
  const cv = $('#mainchart');
  if (!cv || hist.t.length < 2) return;
  const ctx = cv.getContext('2d');
  const w = (cv.width = cv.clientWidth * 2);
  const h = (cv.height = cv.clientHeight * 2);
  ctx.clearRect(0, 0, w, h);
  const m = Math.max(...hist.cpu.map((c, i) => Math.max(c, hist.mem[i] || 0)), 10) * 1.1;
  ctx.strokeStyle = 'rgba(31,38,48,0.8)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#5d6b7d';
  ctx.font = '15px ui-monospace,monospace';
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(0, (h / 4) * i);
    ctx.lineTo(w, (h / 4) * i);
    ctx.stroke();
  }
  ctx.fillText(Math.round(m) + '%', 6, 18);
  const plot = (pts, color, fill) => {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - 4 - (p / m) * (h - 12);
      if (!i) return ctx.moveTo(x, y);
      const px = ((i - 1) / (pts.length - 1)) * w;
      const py = h - 4 - (pts[i - 1] / m) * (h - 12);
      ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.stroke();
    if (fill) {
      const last = pts.length - 1;
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, color + '33');
      g.addColorStop(1, color + '00');
      ctx.fillStyle = g;
      ctx.fill();
    }
  };
  plot(hist.cpu, ACC, true);
  plot(hist.mem, ACC2, false);
  ctx.font = '15px ui-monospace,monospace';
  ctx.fillStyle = ACC;
  ctx.fillText('● CPU Σ', w - 150, 20);
  ctx.fillStyle = ACC2;
  ctx.fillText('● RAM Σ', w - 150, 42);
}

function gauge(cv, pct, label) {
  const ctx = cv.getContext('2d');
  const s = (cv.width = cv.height = (cv.clientWidth || 140) * 2);
  const cx = s / 2,
    cy = s / 2,
    r = s * 0.4;
  const color = loadColor(pct);
  ctx.clearRect(0, 0, s, s);
  ctx.lineWidth = s * 0.055;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1c232d';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0.75 * Math.PI, 2.25 * Math.PI);
  ctx.stroke();
  const p = Math.min(pct, 100) / 100;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0.75 * Math.PI, (0.75 + 1.5 * p) * Math.PI);
  ctx.stroke();
  ctx.fillStyle = '#dde3ea';
  ctx.font = '700 ' + s * 0.15 + 'px ui-monospace,monospace';
  ctx.textAlign = 'center';
  ctx.fillText(pct.toFixed(pct < 10 ? 1 : 0) + '%', cx, cy + s * 0.03);
  ctx.fillStyle = '#8b98a9';
  ctx.font = '500 ' + s * 0.068 + 'px system-ui,sans-serif';
  ctx.fillText(label, cx, cy + s * 0.18);
  ctx.textAlign = 'left';
}

/* ---------- вкладки ---------- */
function render() {
  const el = $('#out');
  if (!data) {
    el.innerHTML = '<p class="sm">Загрузка…</p>';
    return;
  }
  if (tab === 'o') renderOverview(el);
  else if (tab === 'c') renderContainers(el);
  else if (tab === 's') renderSites(el);
  else if (tab === 'i') renderImages(el);
  else if (tab === 'v') renderVolumes(el);
  else if (tab === 'w') renderNetworks(el);
  else if (tab === 'b') renderBackups(el);
  else if (tab === 'f') renderFiles(el);
  else renderNew(el);
}

function card(label, value, sub, trackPct, cls) {
  return `<div class="card ${cls || ''}"><div class="k">${label}</div><div class="v">${value}</div>
  ${sub ? `<div class="s">${sub}</div>` : ''}
  ${trackPct != null ? `<div class="track"><i style="width:${Math.min(trackPct, 100)}%"></i></div>` : ''}</div>`;
}

function renderOverview(el) {
  const run = data.containers.filter((c) => c.state === 'running').length;
  const total = data.containers.length;
  const cpu = data.containers.reduce((a, c) => a + (c.stats?.cpu || 0), 0);
  const mem = data.containers.reduce((a, c) => a + (c.stats?.mem || 0), 0);
  const memPct = data.host?.memTotal ? (mem / data.host.memTotal) * 100 : 0;
  const cores = data.host?.ncpu || 1;
  const cpuPct = Math.min((cpu / (cores * 100)) * 100, 100);
  const up = data.sites.filter((s) => s.code > 0 && s.code < 400).length;
  const bad = data.sites.length - up;
  const avgMs = Math.round(data.sites.reduce((a, s) => a + s.ms, 0) / (data.sites.length || 1));
  const top = [...data.containers].filter((c) => c.stats).sort((a, b) => b.stats.cpu - a.stats.cpu).slice(0, 6);
  const memOf = (b) => (data.host?.memTotal ? (b / data.host.memTotal) * 100 : 0);
  const disk = data.disk?.disk;
  const dck = data.disk?.docker;
  const alerts = data.alerts || [];
  el.innerHTML =
    (alerts.length
      ? `<div id="alerts">${alerts.map((a) => `<div class="alert ${a.level}">${a.level === 'crit' ? '⛔' : '⚠️'} ${esc(a.text)}</div>`).join('')}</div>`
      : `<div id="alerts"><div class="alert" style="background:rgba(52,192,139,.06);border:1px solid rgba(52,192,139,.25);color:#b5e2cc">✓ Проблем не обнаружено — все системы в норме</div></div>`) +
    `<div class="hero ${bad ? 'crit' : alerts.length ? 'warn' : ''}">
      <div class="hl">
        <div class="state">${bad ? 'SYS·CRITICAL' : alerts.length ? 'SYS·DEGRADED' : 'SYS·NOMINAL'}</div>
        <div class="s">${total} контейнеров · ${run} запущено · ${data.sites.length} доменов · ср. ответ ${avgMs} мс</div>
      </div>
      <div class="hr sm">НОДА <b style="color:var(--txt)">${esc(data.host?.name || '—')}</b> · DOCKER ${esc(data.host?.version || '—')} · ОНЛАЙН ${up}</div>
    </div>
    <div class="cards">
    ${card('Контейнеры', run + '<span class="sm"> / ' + total + '</span>', (data.host?.containersStopped ? data.host.containersStopped + ' остановлено · ' + (data.host.containersPaused || 0) + ' paused' : 'все запущены'), (run / (total || 1)) * 100, run < total ? 'warn' : '')}
    ${card('CPU Σ · ' + cores + ' ядер', cpu.toFixed(1) + '%', 'по всем контейнерам', cpuPct, cpuPct > 70 ? 'warn' : cpuPct > 90 ? 'bad' : '')}
    ${card('RAM Σ', memPct.toFixed(1) + '%', fmtMb(mem) + ' из ' + fmtMb(data.host?.memTotal || 0), memPct, memPct > 90 ? 'bad' : memPct > 70 ? 'warn' : '')}
    ${card('Сайты', up + '<span class="sm"> / ' + data.sites.length + '</span>', bad ? bad + ' с проблемами · avg ' + avgMs + ' мс' : 'все доступны · avg ' + avgMs + ' мс', (up / (data.sites.length || 1)) * 100, bad ? 'warn' : '')}
    ${card('Диск', disk ? disk.usePct + '%' : '—', disk ? disk.used + ' из ' + disk.size + ' · свободно ' + disk.avail : '', disk?.usePct ?? null, disk?.usePct > 90 ? 'bad' : disk?.usePct > 75 ? 'warn' : '')}
    ${card('Docker', dck ? fmtMb(dck.imagesSize) : '—', dck ? 'образов ' + dck.images + ' · томов ' + dck.volumes : 'docker ' + esc(data.host?.version || '—'), null, '')}
  </div>
  <div class="grid2">
    <div>
      <div class="panelbox"><h3>Нагрузка · история (24 ч на сервере)</h3><canvas id="mainchart" class="chart"></canvas></div>
      <div class="panelbox"><h3>События Docker · live</h3><div id="events"></div></div>
    </div>
    <div>
      <div class="panelbox"><h3>Ресурсы</h3><div style="display:flex;gap:8px;flex-wrap:wrap">
        <canvas id="gcpu" style="width:47%"></canvas><canvas id="gmem" style="width:47%"></canvas></div>
        <div class="sm" style="margin-top:8px">Пороги: 70% — внимание, 90% — критично</div></div>
      <div class="panelbox"><h3>Обслуживание</h3>
        <div class="sm" style="margin-bottom:8px">Нода: <b style="color:var(--txt)">${esc(data.host?.name || '—')}</b> · docker ${esc(data.host?.version || '—')}</div>
        <button class="btn y" onclick="prune()">Очистить висячие образы</button>
        <div id="prunemsg" class="sm" style="margin-top:8px"></div></div>
    </div>
  </div>
  <div class="panelbox"><h3>Топ по CPU</h3><table><tr><th>Контейнер</th><th style="width:170px">CPU</th><th style="width:170px">RAM</th><th style="width:110px">Тренд</th></tr>` +
    top
      .map((c) => {
        const mp = memOf(c.stats.mem);
        return `<tr><td><div class="mono" style="font-weight:600">${esc(c.name)}</div><div class="desc">${esc(c.desc)}</div></td>
      <td><div class="bar"><i style="width:${Math.min(c.stats.cpu, 100)}%;background:${loadColor(c.stats.cpu)}"></i></div><span class="sm digit">${c.stats.cpu}%</span></td>
      <td><div class="bar mem"><i style="width:${Math.min(mp * 8, 100)}%"></i></div><span class="sm digit">${fmtMb(c.stats.mem)} · ${mp.toFixed(1)}%</span></td>
      <td><canvas class="spark" data-spark="${c.id}"></canvas></td></tr>`;
      })
      .join('') +
    `</table></div>`;
  const ts = $('#topstat');
  if (ts) ts.textContent = run + '/' + total + ' КОНТ. · ' + up + '/' + data.sites.length + ' САЙТОВ · CPU ' + cpuPct.toFixed(0) + '% · RAM ' + memPct.toFixed(0) + '%';
  bigChart();
  gauge($('#gcpu'), cpuPct, 'CPU');
  gauge($('#gmem'), memPct, 'RAM');
  renderEvents();
  document.querySelectorAll('[data-spark]').forEach((cv) => sparkline(cv, hist.per.get(cv.dataset.spark) || [], ACC, 50));
}

function renderContainers(el) {
  scanToken++;
  const my = scanToken;
  const memOf = (b) => (data.host?.memTotal ? (b / data.host.memTotal) * 100 : 0);
  const f = filterText.toLowerCase();
  const list = data.containers.filter((c) => !f || c.name.toLowerCase().includes(f) || (c.desc || '').toLowerCase().includes(f) || (c.image || '').toLowerCase().includes(f));
  const byProject = {};
  for (const c of list) (byProject[c.project || '(вне проектов)'] ||= []).push(c);
  let rows = '';
  for (const [p, cl] of Object.entries(byProject).sort()) {
    rows += `<tr><td colspan="8" style="color:var(--mut);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding-top:14px">${esc(p)} · ${cl.length}</td></tr>`;
    for (const c of cl) {
      const dot = c.state === 'running' ? 'on' : c.state === 'exited' ? 'off' : 'warn';
      rows += `<tr><td style="min-width:230px"><div><span class="dot ${dot}"></span><a href="#" class="mono" style="font-weight:600;color:inherit" onclick="openDetail('${c.id}','${esc(c.name)}');return false">${esc(c.name)}</a><span id="scan-${c.id}"></span></div>
    <div class="desc">${esc(c.desc || '—')}</div>
    <div class="sm mono" style="margin-top:2px">${esc(c.image)}</div></td>
    <td>${c.stats ? `<div class="bar"><i style="width:${Math.min(c.stats.cpu, 100)}%;background:${loadColor(c.stats.cpu)}"></i></div><span class="sm digit">${c.stats.cpu}%</span>` : '<span class="sm">—</span>'}</td>
    <td>${c.stats ? `<div class="bar mem"><i style="width:${Math.min(memOf(c.stats.mem) * 8, 100)}%"></i></div><span class="sm digit">${fmtMb(c.stats.mem)}</span>` : '<span class="sm">—</span>'}</td>
    <td><canvas class="spark" data-spark="${c.id}"></canvas></td>
    <td>${c.ports.map((p2) => `<span class="chip">${esc(p2)}</span>`).join('') || '<span class="sm">—</span>'}</td>
    <td><span class="sm">${esc(c.status)}</span></td>
    <td>${c.state !== 'running' ? `<button class="btn y" onclick="act('${c.id}','start')">Старт</button>` : `<button class="btn" onclick="act('${c.id}','restart')">Рестарт</button> <button class="btn warn" onclick="act('${c.id}','stop')">Стоп</button>`}
    <button class="btn" onclick="openLogs('${c.id}','${esc(c.name)}')">Логи</button></td></tr>`;
    }
  }
  el.innerHTML = `<div class="panelbox"><h3>Контейнеры · ${list.length} из ${data.containers.length}</h3>
  <input id="f" placeholder="Поиск: имя, описание, образ…" value="${esc(filterText)}" oninput="filterText=this.value;render()" style="margin-bottom:12px;width:320px">
  <table><tr><th>Контейнер и содержимое</th><th style="width:120px">CPU</th><th style="width:120px">RAM</th><th style="width:100px">Тренд</th><th>Порты</th><th>Статус</th><th style="width:220px">Действия</th></tr>${rows}</table></div>`;
  document.querySelectorAll('[data-spark]').forEach((cv) => sparkline(cv, hist.per.get(cv.dataset.spark) || [], ACC2, 50));
  // ленивый скан ошибок в логах
  for (const c of list.slice(0, 40)) {
    api('/api/containers/' + c.id + '/scan')
      .then((r) => {
        if (my !== scanToken) return;
        const b = document.getElementById('scan-' + c.id);
        if (b && r.errors > 0) b.innerHTML = `<span class="errb" title="error/fatal в последних 300 строках логов">${r.errors} err</span>`;
      })
      .catch(() => {});
  }
}

function renderSites(el) {
  const f = filterSites.toLowerCase();
  const filtered = data.sites.filter((s) => !f || s.domain.includes(f));
  const sorted = [...filtered].sort((a, b) => b.ms - a.ms);
  const maxMs = sorted[0]?.ms || 1;
  const up = data.sites.filter((s) => s.code > 0 && s.code < 400).length;
  const bad = data.sites.length - up;
  const avg = Math.round(data.sites.reduce((a, s) => a + s.ms, 0) / (data.sites.length || 1));
  el.innerHTML =
    `<div class="cards">
    ${card('Онлайн', up + '<span class="sm"> / ' + data.sites.length + '</span>', '', (up / (data.sites.length || 1)) * 100, '')}
    ${card('С проблемами', String(bad), bad ? 'требуют внимания' : 'все в порядке', null, bad ? 'warn' : '')}
    ${card('Средний ответ', avg + ' мс', 'по всем доменам', null, '')}
  </div>
  <div class="panelbox" style="margin-bottom:14px"><h3>Латентность доменов · мс${f ? ' · фильтр: ' + esc(f) : ''}</h3><canvas id="latchart" class="chart"></canvas></div>
  <input id="fs" placeholder="Фильтр по домену…" value="${esc(filterSites)}" oninput="filterSites=this.value;render()" style="margin-bottom:12px;width:280px">
  <div class="sites">` +
    sorted
      .map((s, i) => {
        const dot = s.code > 0 && s.code < 400 ? 'on' : s.code >= 500 || s.code === 0 ? 'bad' : 'warn';
        const upr = uptimeMap[s.domain];
        return `<div class="site" style="animation-delay:${i * 20}ms">
      <div class="d"><span class="dot ${dot}"></span><a href="https://${esc(s.domain)}" target="_blank" style="color:inherit">${esc(s.domain)}</a></div>
      <div class="m">${s.code ? 'HTTP ' + s.code + ' · ' + s.ms + ' мс · ' + timeShort(Date.parse(s.at)) : 'Недоступен · ' + esc(s.error || '')}</div>
      ${s.backend ? `<div class="m" style="margin-top:3px">→ <span class="chip">${esc(s.backend)}</span></div>` : ''}
      <div class="lat"><i style="width:${Math.min((s.ms / maxMs) * 100, 100)}%;background:${s.code >= 400 || s.code === 0 ? RED : s.ms > 1000 ? WARN : ACC}"></i></div>
      ${upr != null ? `<div class="m">аптайм ${upr}%</div>` : ''}</div>`;
      })
      .join('') +
    `</div>`;
  const cv = $('#latchart');
  if (cv) {
    const ctx = cv.getContext('2d');
    const shown = sorted.slice(0, 20);
    const h = (cv.height = shown.length * 22 + 10);
    const w = (cv.width = cv.clientWidth * 2);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '14px ui-monospace,monospace';
    shown.forEach((s, i) => {
      const y = i * 22 + 8;
      const bw = Math.max((s.ms / maxMs) * (w - 330), s.code ? 3 : 0);
      ctx.fillStyle = '#8b98a9';
      ctx.fillText(s.domain.slice(0, 30), 6, y + 12);
      ctx.fillStyle = s.code >= 400 || s.code === 0 ? RED : s.ms > 1000 ? WARN : ACC;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(300, y, bw, 12, 6);
      else ctx.rect(300, y, bw, 12);
      ctx.fill();
      ctx.fillStyle = '#8b98a9';
      ctx.fillText(s.code ? s.ms + ' ms · ' + s.code : 'DOWN', 308 + bw, y + 12);
    });
  }
}

/* ---------- образы / тома / сети ---------- */
let imagesCache = null,
  volumesCache = null,
  networksCache = null,
  detailState = null;

async function renderImages(el) {
  if (!imagesCache) {
    el.innerHTML = '<div class="panelbox"><h3>Образы</h3><p class="sm">Загрузка…</p></div>';
    try {
      imagesCache = (await api('/api/images')).images;
    } catch (e) {
      el.innerHTML = '<div class="panelbox"><h3>Образы</h3><p class="bad">' + esc(e.message) + '</p></div>';
      return;
    }
  }
  const total = imagesCache.reduce((a, i) => a + i.size, 0);
  el.innerHTML = `<div class="panelbox"><h3>Образы · ${imagesCache.length} · ${fmtMb(total)}</h3>
  <form onsubmit="pullImage(event)" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
    <input name="image" placeholder="nginx:alpine или ghcr.io/org/image:tag" required style="width:340px">
    <button class="btn y">Скачать образ</button><span id="pullmsg" class="sm"></span></form>
  <table><tr><th>Образ</th><th>Размер</th><th>Создан</th><th>Используется</th><th></th></tr>` +
    imagesCache
      .map(
        (i) => `<tr><td class="mono" style="font-size:12px">${esc(i.tags.join(', ') || i.id)} ${i.tags[0] && imagesCache.updates?.[i.tags[0]] ? '<span class="pill o">обновление</span>' : ''}</td>
      <td class="digit">${fmtMb(i.size)}</td>
      <td class="sm">${new Date(i.created * 1000).toLocaleDateString('ru-RU')}</td>
      <td>${i.usedBy ? '<span class="pill b">' + i.usedBy + ' конт.</span>' : '<span class="pill g">свободен</span>'}</td>
      <td>${i.usedBy ? '' : `<button class="btn warn" onclick="delImage('${esc(i.tags[0] || i.id)}')">Удалить</button>`}</td></tr>`,
      )
      .join('') +
    `</table></div>`;
  if (!imagesCache.updates) {
    api('/api/images/updates')
      .then((r) => {
        imagesCache.updates = r.updates;
        if (tab === 'i') render();
      })
      .catch(() => {});
  }
}

async function pullImage(e) {
  e.preventDefault();
  const f = new FormData(e.target),
    m = $('#pullmsg');
  m.textContent = 'Скачиваю (может занять минуты)…';
  try {
    await api('/api/images/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: f.get('image') }) });
    m.textContent = '✓ скачан';
    imagesCache = null;
    render();
  } catch (err) {
    m.textContent = 'Ошибка: ' + err.message;
  }
}

async function delImage(ref) {
  if (!confirm('Удалить образ ' + ref + '?')) return;
  try {
    await api('/api/images/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }) });
    imagesCache = null;
    render();
  } catch (e) {
    alert(e.message);
  }
}

async function renderVolumes(el) {
  if (!volumesCache) {
    el.innerHTML = '<div class="panelbox"><h3>Тома</h3><p class="sm">Загрузка…</p></div>';
    try {
      volumesCache = (await api('/api/volumes')).volumes;
    } catch (e) {
      el.innerHTML = '<div class="panelbox"><h3>Тома</h3><p class="bad">' + esc(e.message) + '</p></div>';
      return;
    }
  }
  el.innerHTML = `<div class="panelbox"><h3>Тома · ${volumesCache.length}</h3><table>
  <tr><th>Имя</th><th>Драйвер</th><th>Размер</th><th>Точка монтирования</th><th></th></tr>` +
    volumesCache
      .map(
        (v) => `<tr><td class="mono" style="font-size:12px">${esc(v.name)}</td><td class="sm">${esc(v.driver)}</td>
    <td class="digit">${v.size ? fmtMb(v.size) : '—'}</td><td class="sm mono" style="font-size:11px">${esc(v.mountpoint)}</td>
    <td><button class="btn warn" onclick="delVolume('${esc(v.name)}')">Удалить</button></td></tr>`,
      )
      .join('') +
    `</table>
  <p class="sm" style="margin-top:10px">⚠ Удаляйте только тома, которые точно не нужны: данные в них будут потеряны. Основные базы данных живут в named-томах стека fleet (db-data, caddy-data и др.).</p></div>`;
}

async function delVolume(name) {
  if (!confirm('УДАЛИТЬ ТОМ ' + name + '? Данные будут потеряны безвозвратно!')) return;
  try {
    await api('/api/volumes/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    volumesCache = null;
    render();
  } catch (e) {
    alert(e.message);
  }
}

async function renderNetworks(el) {
  if (!networksCache) {
    el.innerHTML = '<div class="panelbox"><h3>Сети</h3><p class="sm">Загрузка…</p></div>';
    try {
      networksCache = (await api('/api/networks')).networks;
    } catch (e) {
      el.innerHTML = '<div class="panelbox"><h3>Сети</h3><p class="bad">' + esc(e.message) + '</p></div>';
      return;
    }
  }
  el.innerHTML = `<div class="panelbox"><h3>Сети · ${networksCache.length}</h3><table>
  <tr><th>Сеть</th><th>Драйвер</th><th>Подсеть</th><th>Контейнеры</th></tr>` +
    networksCache
      .map(
        (n) => `<tr><td class="mono" style="font-weight:600">${esc(n.name)}${n.internal ? ' <span class="pill g">internal</span>' : ''}</td>
    <td class="sm">${esc(n.driver)}</td><td class="sm mono">${esc(n.subnet || '—')}</td>
    <td>${n.containers.length ? n.containers.map((c) => `<span class="chip">${esc(c)}</span>`).join('') : '<span class="sm">пусто</span>'}</td></tr>`,
      )
      .join('') +
    `</table></div>`;
}

/* ---------- карточка контейнера ---------- */
async function openDetail(id, name) {
  detailState = { id, name };
  const box = $('#detail');
  box.classList.add('show');
  $('#dtitle').textContent = 'Контейнер · ' + name;
  $('#dbody').innerHTML = '<p class="sm">Загрузка…</p>';
  try {
    const d = await api('/api/containers/' + id + '/detail');
    detailState.detail = d;
    $('#dbody').innerHTML = `
    <div class="cards" style="margin-bottom:12px">
      ${card('Статус', esc(d.restartPolicy || '—'), 'политика перезапуска', null, '')}
      ${card('Перезапусков', String(d.restartCount), d.oomKilled ? '⚠ был OOM-kill' : 'без OOM', null, d.oomKilled ? 'bad' : '')}
      ${card('IP', esc(d.ip || '—'), esc((d.networks || []).join(', ')), null, '')}
      ${card('Сеть', esc(d.networkMode || '—'), '', null, '')}
    </div>
    <div class="panelbox" style="margin-bottom:12px"><h3>Информация</h3><table>
      <tr><td class="sm" style="width:160px">Образ</td><td class="mono" style="font-size:12px">${esc(d.image)}</td></tr>
      <tr><td class="sm">Команда</td><td class="mono" style="font-size:12px">${esc(d.cmd || '—')}</td></tr>
      <tr><td class="sm">Создан</td><td class="sm">${new Date(d.created).toLocaleString('ru-RU')}</td></tr>
      <tr><td class="sm">Запущен</td><td class="sm">${d.started && !d.started.startsWith('0001') ? new Date(d.started).toLocaleString('ru-RU') : '—'}</td></tr>
      <tr><td class="sm">Env-переменные</td><td>${d.env.map((e) => `<span class="chip">${esc(e)}</span>`).join('') || '<span class="sm">нет</span>'}</td></tr>
      <tr><td class="sm">Монтирования</td><td>${d.mounts.map((m2) => `<div class="sm mono" style="font-size:11px">${esc(m2)}</div>`).join('') || '<span class="sm">нет</span>'}</td></tr>
    </table></div>
    <div class="panelbox"><h3>Выполнить команду внутри</h3>
      <form onsubmit="runExec(event)" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <input name="cmd" placeholder="ls -la /app" required style="width:420px;font-family:monospace;font-size:12px">
        <button class="btn">Запустить</button></form>
      <pre id="execout" style="background:#080a0e;border-radius:6px;padding:12px;color:#a9b4c2;font-size:12px;overflow:auto;max-height:280px;display:none;margin:10px 0 0"></pre>
      <p class="sm" style="margin-top:8px">Осторожно: команда выполняется реально, внутри контейнера.</p></div>`;
  } catch (e) {
    $('#dbody').innerHTML = '<p class="bad">' + esc(e.message) + '</p>';
  }
}

async function runExec(e) {
  e.preventDefault();
  const f = new FormData(e.target),
    out = $('#execout');
  out.style.display = 'block';
  out.textContent = '$ ' + f.get('cmd') + '\nвыполняется…';
  try {
    const r = await api('/api/containers/' + detailState.id + '/exec', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: f.get('cmd') }) });
    out.textContent = '$ ' + f.get('cmd') + '\n' + r.output;
  } catch (err) {
    out.textContent = 'Ошибка: ' + err.message;
  }
}

function closeDetail() {
  $('#detail').classList.remove('show');
  detailState = null;
}

/* ---------- бэкапы ---------- */
let backupsCache = null,
  filesPath = '',
  filesCache = null;

async function renderBackups(el) {
  if (!backupsCache) {
    el.innerHTML = '<div class="panelbox"><h3>Бэкапы</h3><p class="sm">Загрузка…</p></div>';
    try {
      backupsCache = await api('/api/backups');
    } catch (e) {
      el.innerHTML = '<div class="panelbox"><h3>Бэкапы</h3><p class="bad">' + esc(e.message) + '</p></div>';
      return;
    }
  }
  const b = backupsCache;
  const s3on = !!b.settings.s3?.accessKey;
  el.innerHTML = `<div class="panelbox"><h3>Бэкапы</h3>
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
    <button class="btn y" onclick="runBackupNow()" ${b.running ? 'disabled' : ''}>${b.running ? 'Идёт бэкап…' : 'Создать бэкап сейчас'}</button>
    <span id="bkmsg" class="sm"></span>
    <span style="flex:1"></span>
    <span class="sm">S3: ${s3on ? '<span class="pill b">подключено</span> ' + esc(b.settings.s3.bucket) : '<span class="pill g">не настроено</span>'}</span>
  </div>
  <div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">
    <div class="card"><div class="k">Локально · /opt/fleet/backups</div><div class="v" style="font-size:20px">${b.local.length}<span class="sm"> · ${fmtMb(b.local.reduce((a, x) => a + x.size, 0))}</span></div>
      <div class="s">хранить последних: ${b.settings.backup.keepLocal}</div></div>
    <div class="card"><div class="k">S3-хранилище</div><div class="v" style="font-size:20px">${s3on ? b.s3.length : '—'}</div>
      <div class="s">${s3on ? 'хранить последних: ' + b.settings.backup.keepS3 : 'настройте ниже'}</div></div>
    <div class="card"><div class="k">Автобэкап</div><div class="v" style="font-size:20px">${b.settings.backup.auto ? 'вкл' : 'выкл'}</div>
      <div class="s">ежедневно в ${String(b.settings.backup.hour).padStart(2, '0')}:00 · последний: ${esc(b.settings.lastAutoRun || '—')}</div></div>
  </div>
  <table style="margin-bottom:18px"><tr><th>Архив</th><th>Размер</th><th>Дата</th><th></th></tr>
  ${b.local.map((x) => `<tr><td class="mono" style="font-size:12px">💾 ${esc(x.name)}</td><td class="digit">${fmtMb(x.size)}</td><td class="sm">${new Date(x.at).toLocaleString('ru-RU')}</td>
    <td><a class="btn" href="/api/backups/download?where=local&name=${encodeURIComponent(x.name)}">Скачать</a> <button class="btn warn" onclick="delBackup('${esc(x.name)}','local')">Удалить</button></td></tr>`).join('')}
  ${s3on ? b.s3.map((x) => `<tr><td class="mono" style="font-size:12px">☁️ ${esc(x.name)}</td><td class="digit">${fmtMb(x.size)}</td><td class="sm">${new Date(x.at).toLocaleString('ru-RU')}</td>
    <td><a class="btn" href="/api/backups/download?where=s3&name=${encodeURIComponent(x.name)}">Скачать</a> <button class="btn warn" onclick="delBackup('${esc(x.name)}','s3')">Удалить</button></td></tr>`).join('') : ''}
  </table>
  <h3 style="font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin:0 0 10px">Настройки</h3>
  <form onsubmit="saveSettings(event)" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;max-width:1100px">
    <div><label class="sm">S3 endpoint</label><input name="endpoint" value="${esc(b.settings.s3?.endpoint || '')}" placeholder="https://storage.yandexcloud.net" style="width:100%"></div>
    <div><label class="sm">Bucket</label><input name="bucket" value="${esc(b.settings.s3?.bucket || '')}" style="width:100%"></div>
    <div><label class="sm">Access Key</label><input name="accessKey" value="${esc(b.settings.s3?.accessKey || '')}" style="width:100%"></div>
    <div><label class="sm">Secret Key</label><input name="secretKey" type="password" value="${esc(b.settings.s3?.secretKey || '')}" placeholder="•••••• (заполните для смены)" style="width:100%"></div>
    <div><label class="sm">Region</label><input name="region" value="${esc(b.settings.s3?.region || 'ru-central1')}" style="width:100%"></div>
    <div><label class="sm">Префикс ключей</label><input name="prefix" value="${esc(b.settings.s3?.prefix || 'fleet/')}" style="width:100%"></div>
    <div><label class="sm">Хранить локально</label><input name="keepLocal" type="number" min="1" max="60" value="${b.settings.backup.keepLocal}" style="width:100%"></div>
    <div><label class="sm">Хранить в S3</label><input name="keepS3" type="number" min="1" max="120" value="${b.settings.backup.keepS3}" style="width:100%"></div>
    <div><label class="sm">Автобэкап (час)</label><input name="hour" type="number" min="0" max="23" value="${b.settings.backup.hour}" style="width:100%"></div>
    <div style="display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;padding-bottom:2px">
      <label class="sm" style="display:flex;align-items:center;gap:6px"><input type="checkbox" name="auto" ${b.settings.backup.auto ? 'checked' : ''} style="width:auto"> автобэкап ежедневно</label>
      <button class="btn">Сохранить настройки</button><span id="setmsg" class="sm"></span></div>
  </form>
  <p class="sm" style="margin-top:12px">В архив входят: все именованные docker-тома (базы данных, сертификаты) и /opt/fleet/deploy (Caddyfile, compose, сайты). S3-совместимо: Яндекс Object Storage, Selectel S3, Cloudflare R2, Backblaze B2.</p></div>`;
}

async function runBackupNow() {
  const m = $('#bkmsg');
  m.textContent = 'Создаю архив (тома + конфиги)…';
  try {
    const r = await api('/api/backups/run', { method: 'POST' });
    m.innerHTML = '✓ ' + esc(r.name) + ' · ' + fmtMb(r.size) + (r.uploaded ? ' · выгружен в S3' : '');
    backupsCache = null;
    render();
  } catch (e) {
    m.textContent = 'Ошибка: ' + e.message;
  }
}

async function delBackup(name, where) {
  if (!confirm('Удалить бэкап ' + name + '?')) return;
  try {
    await api('/api/backups/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, where }) });
    backupsCache = null;
    render();
  } catch (e) {
    alert(e.message);
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const f = new FormData(e.target),
    m = $('#setmsg');
  m.textContent = 'Сохраняю…';
  try {
    await api('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        s3: {
          endpoint: f.get('endpoint'),
          bucket: f.get('bucket'),
          accessKey: f.get('accessKey'),
          secretKey: f.get('secretKey'),
          region: f.get('region'),
          prefix: f.get('prefix') || 'fleet/',
        },
        backup: { keepLocal: Number(f.get('keepLocal')), keepS3: Number(f.get('keepS3')), hour: Number(f.get('hour')), auto: !!f.get('auto') },
      }),
    });
    m.textContent = '✓ сохранено';
    backupsCache = null;
  } catch (err) {
    m.textContent = 'Ошибка: ' + err.message;
  }
}

/* ---------- файлы ---------- */
async function renderFiles(el) {
  if (!filesCache || filesCache.path !== filesPath) {
    el.innerHTML = '<div class="panelbox"><h3>Файлы</h3><p class="sm">Загрузка…</p></div>';
    try {
      filesCache = await api('/api/files?p=' + encodeURIComponent(filesPath));
    } catch (e) {
      filesPath = filesPath.split('/').slice(0, -1).join('/');
      el.innerHTML = '<div class="panelbox"><h3>Файлы</h3><p class="bad">' + esc(e.message) + '</p></div>';
      return;
    }
  }
  const f = filesCache;
  if (f.dir) {
    el.innerHTML = `<div class="panelbox"><h3>Файлы · /opt/fleet/deploy/${esc(f.path)}</h3>
    <table><tr><th>Имя</th><th>Размер</th></tr>
    ${f.path ? `<tr><td colspan="2"><a href="#" onclick="filesPath='${esc(f.path.split('/').slice(0, -1).join('/'))}';filesCache=null;render();return false">↩ ..</a></td></tr>` : ''}
    ${f.entries.map((x) => `<tr><td>${x.dir ? '📁' : '📄'} <a href="#" onclick="filesPath='${esc((f.path ? f.path + '/' : '') + x.name)}';filesCache=null;render();return false" style="color:inherit">${esc(x.name)}</a>${x.dir ? '' : ` <span class="sm">` + fmtMb(x.size) + `</span>`}</td><td class="sm">${x.dir ? '' : fmtMb(x.size)}</td></tr>`).join('')}
    </table>
    <p class="sm" style="margin-top:10px">Редактируются текстовые файлы до 300 КБ. Перед сохранением предыдущая версия копируется в файл.bak-ДАТА.</p></div>`;
  } else {
    el.innerHTML = `<div class="panelbox"><h3>Редактор · ${esc(f.path)} <span class="sm">(${fmtMb(f.size)})</span></h3>
    <div style="margin-bottom:10px"><a href="#" onclick="filesPath='${esc(f.path.split('/').slice(0, -1).join('/'))}';filesCache=null;render();return false">↩ Назад к списку</a></div>
    <textarea id="fedit" style="width:100%;height:50vh;background:#080a0e;color:#aeb9c6;border:1px solid var(--line);border-radius:9px;padding:13px;font:12.5px ui-monospace,monospace">${esc(f.content)}</textarea>
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center"><button class="btn y" onclick="saveFile()">Сохранить</button><span id="fmsg" class="sm"></span></div></div>`;
  }
}

async function saveFile() {
  const m = $('#fmsg');
  m.textContent = 'Сохраняю…';
  try {
    await api('/api/files/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p: filesCache.path, content: $('#fedit').value }) });
    m.textContent = '✓ сохранено (резервная копия создана)';
    filesCache = null;
  } catch (e) {
    m.textContent = 'Ошибка: ' + e.message;
  }
}

function renderNew(el) {
  el.innerHTML = `<div class="panelbox"><h3>Новый сайт</h3>
  <form id="create" onsubmit="createSite(event)">
    <div><label>Имя (латиница, дефис)</label><input name="name" placeholder="landing" required></div>
    <div><label>Домен (DNS уже на сервер)</label><input name="domain" placeholder="landing.aksystems.pro" required style="width:320px"></div>
    <div><label>Предустановка</label><select name="preset" style="background:var(--panel2);border:1px solid var(--line);color:var(--txt);padding:9px 12px;border-radius:8px;font:inherit;width:280px;outline:none">
      <option value="static">Статический сайт (заглушка)</option>
      <option value="wordpress">WordPress</option>
      <option value="joomla">Joomla 5</option>
      <option value="drupal">Drupal 11</option>
      <option value="opencart">OpenCart 4</option>
      <option value="prestashop">PrestaShop 8</option>
      <option value="nextcloud">Nextcloud</option>
      <option value="bitrix">1C-Битрикс: Управление сайтом</option>
      <option value="n8n">n8n · автоматизации</option>
      <option value="jenkins">Jenkins CI</option>
      <option value="ubuntu">Сервер Ubuntu 24.04 (SSH)</option>
    </select></div>
    <button class="btn y">Создать сайт</button></form><div id="msg"></div>
  <p class="sm">Статика: контейнер aksite-&lt;имя&gt; (nginx) и каталог /opt/fleet/deploy/aksites/html/&lt;имя&gt;. CMS: официальный образ + своя база в общем MariaDB (aksite-db), файлы в томе aksite-&lt;имя&gt;-data. Битрикс: PHP + мастер установки (реквизиты базы покажем после создания). n8n/Jenkins — готовые сервисы. Ubuntu — контейнер-сервер с SSH на отдельном порту (доступы — один раз после создания). У сайтов: блок в Caddyfile и сертификат.</p></div>`;
}

/* ---------- действия ---------- */
async function load() {
  try {
    data = await api('/api/overview');
    sample();
    render();
  } catch (e) {
    const el = $('#out');
    if (el && !data) el.innerHTML = '<p class="bad">Ошибка связи: ' + esc(e.message) + '</p>';
  }
}
async function act(id, a) {
  if (a === 'stop' && !confirm('Остановить контейнер?')) return;
  try {
    await api('/api/containers/' + id + '/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: a }) });
    load();
  } catch (e) {
    alert(e.message);
  }
}
async function prune() {
  if (!confirm('Удалить висячие (dangling) образы? Это безопасно: они не используются контейнерами.')) return;
  const m = $('#prunemsg');
  m.textContent = 'Очистка…';
  try {
    const r = await api('/api/prune', { method: 'POST' });
    m.textContent = 'Освобождено: ' + fmtMb(r.reclaimed);
    cacheReset();
    load();
  } catch (e) {
    m.textContent = 'Ошибка: ' + e.message;
  }
}
function cacheReset() {}
async function openLogs(id, name) {
  logId = id;
  logName = name;
  $('#logbox').classList.add('show');
  await refreshLogs();
  clearInterval(logTimer);
  logTimer = setInterval(() => autoLogs && logId && refreshLogs(), 3000);
}
async function refreshLogs() {
  if (!logId) return;
  $('#logtitle').textContent = 'Логи · ' + logName;
  try {
    const j = await api('/api/containers/' + logId + '/logs?lines=400');
    const box = $('#logs');
    let lines = j.logs.split('\n');
    const q = (window.logFilter || '').toLowerCase();
    if (q) lines = lines.filter((l) => l.toLowerCase().includes(q));
    box.innerHTML =
      '<div class="sys">── docker logs --tail 400' + (q ? ' · фильтр: «' + esc(q) + '» (' + lines.length + ' строк)' : '') + ' · автообновление 3 с ──</div>' +
      lines
        .map((l) => `<div class="${/error|fatal|exception|failed|panic|denied/i.test(l) ? 'err' : ''}">${esc(l) || ' '}</div>`)
        .join('');
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    $('#logs').innerHTML = '<div class="err">Ошибка: ' + esc(e.message) + '</div>';
  }
}
function toggleAuto() {
  autoLogs = !autoLogs;
  $('#autobtn').textContent = 'Авто: ' + (autoLogs ? 'вкл' : 'выкл');
}
function closeLogs() {
  clearInterval(logTimer);
  logId = null;
  $('#logbox').classList.remove('show');
}
async function createSite(e) {
  e.preventDefault();
  const f = new FormData(e.target),
    msg = $('#msg');
  msg.className = '';
  msg.textContent = 'Создаём… (первый запуск CMS может занять несколько минут — скачивается образ)';
  try {
    const r = await api('/api/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.get('name'), domain: f.get('domain'), preset: f.get('preset') }) });
    msg.className = 'ok';
    let html = r.url ? 'Готово: <a href="' + r.url + '" target="_blank">' + r.url + '</a>' : 'Готово.';
    if (r.admin) html += '<div style="margin-top:8px">Администратор: логин <b>' + esc(r.admin.login) + '</b>, пароль <code class="mono">' + esc(r.admin.password) + '</code> — сохраните, больше не покажется.</div>';
    if (r.db) html += '<div style="margin-top:8px">База для мастера установки: хост <code class="mono">' + esc(r.db.host) + '</code>, база <code class="mono">' + esc(r.db.name) + '</code>, пользователь <code class="mono">' + esc(r.db.user) + '</code>, пароль <code class="mono">' + esc(r.db.password) + '</code></div>';
    if (r.ssh) html += '<div style="margin-top:8px">SSH: <code class="mono">ssh ' + esc(r.ssh.user) + '@' + esc(r.ssh.host) + ' -p ' + r.ssh.port + '</code>, пароль <code class="mono">' + esc(r.ssh.password) + '</code> (первый запуск ставит SSH 1–2 минуты)</div>';
    if (r.note) html += '<div class="sm" style="margin-top:8px">' + esc(r.note) + '</div>';
    msg.innerHTML = html;
    load();
  } catch (err) {
    msg.className = 'bad';
    msg.textContent = err.message;
  }
}
async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
}

document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    tab = b.dataset.t;
    const pt = $('#pagetitle');
    if (pt) pt.textContent = b.textContent;
    if (tab === 'i') imagesCache = null;
    if (tab === 'v') volumesCache = null;
    if (tab === 'w') networksCache = null;
    if (tab === 'b') backupsCache = null;
    if (tab === 'f') filesCache = null;
    render();
  });
});

(async function start() {
  try {
    fillFromServer(await api('/api/history'));
  } catch { /* истории пока нет */ }
  pumpEvents();
  load();
  setInterval(load, 15000);
})();
