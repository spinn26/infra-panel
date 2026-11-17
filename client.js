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

const ACC = '#8ed1b0',
  ACC2 = '#b4a7f5',
  WARN = '#e9c27a',
  RED = '#ee8f86';

async function api(p, opt) {
  const r = await fetch(p, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMb = (b) => (b > 1073741824 ? (b / 1073741824).toFixed(1) + ' ГБ' : b >= 1048576 ? Math.round(b / 1048576) + ' МБ' : b >= 1024 ? Math.round(b / 1024) + ' КБ' : (b || 0) + ' Б');
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
  if (!cv) return;
  if (hist.t.length < 2) {
    cv.outerHTML = '<div class="chart-empty">График появится после пары замеров — примерно через минуту</div>';
    return;
  }
  const ctx = cv.getContext('2d');
  const w = (cv.width = cv.clientWidth * 2);
  const h = (cv.height = cv.clientHeight * 2);
  ctx.clearRect(0, 0, w, h);
  const m = Math.max(...hist.cpu.map((c, i) => Math.max(c, hist.mem[i] || 0)), 10) * 1.4;
  ctx.strokeStyle = 'rgba(236,234,228,0.07)';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#9a9ca6';
  ctx.font = '22px JetBrains Mono,monospace';
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
    ctx.lineWidth = 3.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.stroke();
    if (fill) {
      const last = pts.length - 1;
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, color + '33');
      g.addColorStop(1, color + '00');
      ctx.shadowBlur = 0;
      ctx.fillStyle = g;
      ctx.fill();
    }
  };
  plot(hist.cpu, ACC, true);
  plot(hist.mem, ACC2, false);
  ctx.font = '22px JetBrains Mono,monospace';
  ctx.fillStyle = ACC;
  ctx.shadowBlur = 0;
  ctx.fillText('● CPU', w - 140, 26);
  ctx.fillStyle = ACC2;
  ctx.fillText('● RAM', w - 140, 56);
}

const gaugePrev = {};
function gauge(cv, pct, label) {
  if (!cv) return;
  const from = gaugePrev[label] ?? 0;
  gaugePrev[label] = pct;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now(), dur = reduce ? 0 : 1100;
  const step = (now) => {
    const k = dur ? Math.min((now - t0) / dur, 1) : 1;
    const e = 1 - Math.pow(1 - k, 4);
    drawGauge(cv, from + (pct - from) * e, label);
    if (k < 1 && cv.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function drawGauge(cv, pct, label) {
  const ctx = cv.getContext('2d');
  const s = (cv.width = cv.height = (cv.clientWidth || 140) * 2);
  const cx = s / 2,
    cy = s / 2,
    r = s * 0.4;
  const color = loadColor(pct);
  ctx.clearRect(0, 0, s, s);
  ctx.lineWidth = s * 0.075;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(236,234,228,0.08)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0.75 * Math.PI, 2.25 * Math.PI);
  ctx.stroke();
  const p = Math.max(Math.min(pct, 100) / 100, 0.001);
  const gr = ctx.createLinearGradient(0, s, s, 0);
  gr.addColorStop(0, color);
  gr.addColorStop(1, pct > 70 ? color : ACC2);
  ctx.strokeStyle = gr;
  ctx.shadowColor = color;
  ctx.shadowBlur = s * 0.08;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0.75 * Math.PI, (0.75 + 1.5 * p) * Math.PI);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#eceae4';
  ctx.font = '600 ' + s * 0.16 + 'px JetBrains Mono,monospace';
  ctx.textAlign = 'center';
  ctx.fillText(pct.toFixed(pct < 10 ? 1 : 0) + '%', cx, cy + s * 0.03);
  ctx.fillStyle = '#9a9ca6';
  ctx.font = '500 ' + s * 0.075 + 'px Onest,system-ui,sans-serif';
  ctx.fillText(label, cx, cy + s * 0.18);
  ctx.textAlign = 'left';
}


/* ---------- выпадающее меню ≡ ---------- */
const ICON = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  logs: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  term: '<path d="m5 8 4 4-4 4M12 16h7"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  kill: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  pull: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  dl: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14l3 3 3-3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  link: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
};
const ico = (n) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[n] + '</svg>';
const kebab = (fn) => '<button class="kebab" aria-label="Действия" aria-haspopup="menu" onclick="' + fn + '">' + ico('menu') + '</button>';
let menuItems = [];
function openMenu(ev, title, items) {
  ev.stopPropagation();
  closeMenu();
  menuItems = items;
  const m = document.createElement('div');
  m.id = 'menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = '<div class="mh">' + esc(title) + '</div>' + items.map((it, i) => it === '-' ? '<hr>' : '<button role="menuitem" class="' + (it.danger ? 'danger' : '') + '" onclick="runMenu(' + i + ')">' + ico(it.icon) + '<span>' + esc(it.label) + '</span>' + (it.hint ? '<kbd>' + esc(it.hint) + '</kbd>' : '') + '</button>').join('');
  document.body.appendChild(m);
  const r = ev.currentTarget.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.right - mw, innerWidth - mw - 8)) + 'px';
  m.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6) + 'px';
  ev.currentTarget.classList.add('open');
  m.querySelector('button')?.focus();
}
function closeMenu() {
  document.getElementById('menu')?.remove();
  document.querySelectorAll('.kebab.open').forEach((b) => b.classList.remove('open'));
}
function runMenu(i) {
  const it = menuItems[i];
  closeMenu();
  it?.fn?.();
}
document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) closeMenu(); });
document.addEventListener('keydown', (e) => {
  const m = document.getElementById('menu');
  if (!m) return;
  const bs = [...m.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
  if (e.key === 'Escape') closeMenu();
  else if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
});
addEventListener('scroll', closeMenu, true);
addEventListener('resize', closeMenu);
function toast(text, kind) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = kind || '';
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}
function copyText(s, what) {
  navigator.clipboard?.writeText(s).then(() => toast(what + ' скопировано'), () => toast('Не удалось скопировать', 'bad'));
}
function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
async function postJson(url, body) {
  return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}
function ctMenu(ev, id) {
  const c = data.containers.find((x) => x.id === id);
  if (!c) return;
  const run = c.state === 'running', paused = c.state === 'paused';
  const items = [
    { icon: 'info', label: 'Подробности', fn: () => openDetail(c.id, c.name) },
    { icon: 'logs', label: 'Логи в реальном времени', fn: () => openLogs(c.id, c.name) },
    { icon: 'term', label: 'Выполнить команду', fn: () => openDetail(c.id, c.name).then(() => document.querySelector('#dbody input[name=cmd]')?.focus()) },
    '-',
  ];
  if (run) items.push({ icon: 'restart', label: 'Перезапустить', fn: () => act(c.id, 'restart') }, { icon: 'pause', label: 'Приостановить', fn: () => act(c.id, 'pause') }, { icon: 'stop', label: 'Остановить', fn: () => act(c.id, 'stop') });
  else if (paused) items.push({ icon: 'play', label: 'Продолжить', fn: () => act(c.id, 'unpause') }, { icon: 'stop', label: 'Остановить', fn: () => act(c.id, 'stop') });
  else items.push({ icon: 'play', label: 'Запустить', fn: () => act(c.id, 'start') });
  if (run || paused) items.push({ icon: 'kill', label: 'Завершить принудительно', fn: () => act(c.id, 'kill') });
  items.push(
    '-',
    { icon: 'pull', label: 'Скачать свежий образ', fn: () => postJson('/api/images/pull', { image: c.image }).then(() => toast('Образ ' + c.image + ' обновлён. Перезапустите контейнер, чтобы применить'), (e) => toast(e.message, 'bad')) },
    { icon: 'dl', label: 'Сохранить логи в файл', fn: () => download('/api/containers/' + c.id + '/logs?lines=2000&download=1') },
    { icon: 'dl', label: 'Сохранить конфигурацию (JSON)', fn: () => download('/api/containers/' + c.id + '/inspect') },
    { icon: 'copy', label: 'Скопировать имя', fn: () => copyText(c.name, 'Имя') },
    { icon: 'copy', label: 'Скопировать ID', fn: () => copyText(c.id, 'ID') },
  );
  if (c.name !== 'infra-panel') items.push('-', { icon: 'trash', label: 'Удалить контейнер', danger: true, fn: () => removeContainer(c) });
  openMenu(ev, c.name, items);
}
async function removeContainer(c) {
  if (!confirm('Удалить контейнер ' + c.name + '? Он будет остановлен и удалён. Тома с данными останутся.')) return;
  try {
    await postJson('/api/containers/' + c.id + '/remove');
    toast('Контейнер ' + c.name + ' удалён');
    load();
  } catch (e) {
    toast(e.message, 'bad');
  }
}
const STATE_RU = { running: ['Работает', 'b'], exited: ['Остановлен', 'g'], paused: ['На паузе', 'o'], restarting: ['Перезапуск', 'o'], dead: ['Сбой', 'r'], created: ['Создан', 'g'] };
const uptimeRu = (s) => String(s || '').replace(/^Up /, 'запущен ').replace(/^Exited \((\d+)\) /, 'код $1, ').replace(/ \(Paused\)/, '').replace(/About an? /, '~1 ').replace(/(\d+) seconds?/, '$1 с').replace(/(\d+) minutes?/, '$1 мин').replace(/(\d+) hours?/, '$1 ч').replace(/(\d+) days?/, '$1 дн').replace(/(\d+) weeks?/, '$1 нед').replace(/(\d+) months?/, '$1 мес').replace(/an? hour/, '1 ч').replace(/ ago/, ' назад').replace('just now', 'только что');

/* ---------- вкладки ---------- */
const numPrev = {};
function countUp(root) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.querySelectorAll('[data-num]').forEach((n) => {
    const to = parseFloat(n.dataset.num), dec = (n.dataset.num.split('.')[1] || '').length;
    const key = tab + '|' + n.dataset.key;
    const from = numPrev[key] ?? 0;
    numPrev[key] = to;
    if (reduce || from === to) return;
    const t0 = performance.now(), dur = 1000;
    const step = (now) => {
      const k = Math.min((now - t0) / dur, 1), e = 1 - Math.pow(1 - k, 3);
      n.textContent = (from + (to - from) * e).toFixed(dec);
      if (k < 1 && n.isConnected) requestAnimationFrame(step);
    };
    n.textContent = from.toFixed(dec);
    requestAnimationFrame(step);
  });
}
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
  countUp(el);
  if (!window.__introT) window.__introT = setTimeout(() => el.classList.remove('intro'), 1600);
}

function card(label, value, sub, trackPct, cls) {
  value = String(value).replace(/^(-?d+(?:.d+)?)/, (n) => `<span data-num="${n}" data-key="${esc(label)}">${n}</span>`);
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
        <div class="orb"></div><div><div class="state">${bad ? 'Есть недоступные сайты' : alerts.length ? 'Нужно внимание' : 'Всё работает'}</div>
        <div class="s">Запущено ${run} из ${total} контейнеров, ${up} из ${data.sites.length} сайтов отвечают, средний ответ ${avgMs} мс</div></div>
      </div>
      <div class="hr"><span>Сервер<b>${esc(data.host?.name || '—')}</b></span><span>Docker<b>${esc(data.host?.version || '—')}</b></span><span>Ядер<b>${cores}</b></span></div>
    </div>
    <div class="cards">
    ${card('Контейнеры', run + '<span class="sm"> / ' + total + '</span>', (data.host?.containersStopped ? data.host.containersStopped + ' остановлено' : 'все запущены'), (run / (total || 1)) * 100, run < total ? 'warn' : '')}
    ${card('Процессор', cpu.toFixed(1) + '%', 'суммарно по контейнерам, ' + cores + ' ядер', cpuPct, cpuPct > 70 ? 'warn' : cpuPct > 90 ? 'bad' : '')}
    ${card('Память', memPct.toFixed(1) + '%', fmtMb(mem) + ' из ' + fmtMb(data.host?.memTotal || 0), memPct, memPct > 90 ? 'bad' : memPct > 70 ? 'warn' : '')}
    ${card('Сайты', up + '<span class="sm"> / ' + data.sites.length + '</span>', bad ? bad + ' с проблемами, ответ ' + avgMs + ' мс' : 'все доступны, ответ ' + avgMs + ' мс', (up / (data.sites.length || 1)) * 100, bad ? 'warn' : '')}
    ${card('Диск', disk ? disk.usePct + '%' : '—', disk ? disk.used + ' из ' + disk.size + ' · свободно ' + disk.avail : '', disk?.usePct ?? null, disk?.usePct > 90 ? 'bad' : disk?.usePct > 75 ? 'warn' : '')}
    ${card('Docker', dck ? fmtMb(dck.imagesSize) : '—', dck ? dck.images + ' образов, ' + dck.volumes + ' томов' : 'docker ' + esc(data.host?.version || '—'), null, '')}
  </div>
  <div class="grid2">
    <div>
      <div class="panelbox"><h3>Нагрузка за 24 часа</h3><canvas id="mainchart" class="chart"></canvas></div>
      <div class="panelbox"><h3>События Docker</h3><div id="events"></div></div>
    </div>
    <div>
      <div class="panelbox"><h3>Ресурсы</h3><div class="gauges">
        <canvas id="gcpu"></canvas><canvas id="gmem"></canvas></div>
        <div class="sm" style="margin-top:8px">Пороги: 70% — внимание, 90% — критично</div></div>
      <div class="panelbox"><h3>Обслуживание</h3>
        <div class="sm" style="margin-bottom:8px">Нода: <b style="color:var(--txt)">${esc(data.host?.name || '—')}</b> · docker ${esc(data.host?.version || '—')}</div>
        <button class="btn y" onclick="prune()">Очистить висячие образы</button>
        <div id="prunemsg" class="sm" style="margin-top:8px"></div></div>
    </div>
  </div>
  <div class="panelbox"><h3>Самые загруженные контейнеры</h3><table><tr><th>Контейнер</th><th style="width:170px">CPU</th><th style="width:170px">RAM</th><th style="width:110px">Тренд</th></tr>` +
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
  if (ts) ts.innerHTML = '<span style="--c:' + loadColor(cpuPct) + '"><i></i>CPU ' + cpuPct.toFixed(0) + '%</span><span style="--c:' + (memPct > 90 ? RED : memPct > 70 ? WARN : ACC2) + '"><i></i>RAM ' + memPct.toFixed(0) + '%</span>';
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
    rows += `<tr><td colspan="8" style="color:var(--acc2);font-size:12.5px;font-weight:600;padding-top:18px">${esc(p)} · ${cl.length}</td></tr>`;
    for (const c of cl) {
      const dot = c.state === 'running' ? 'on' : c.state === 'exited' ? 'off' : 'warn';
      rows += `<tr><td style="min-width:230px"><div><span class="dot ${dot}"></span><a href="#" class="mono" style="font-weight:600;color:inherit" onclick="openDetail('${c.id}','${esc(c.name)}');return false">${esc(c.name)}</a><span id="scan-${c.id}"></span></div>
    <div class="desc">${esc(c.desc || '—')}</div>
    <div class="sm mono" style="margin-top:2px">${esc(c.image)}</div></td>
    <td>${c.stats ? `<div class="bar"><i style="width:${Math.min(c.stats.cpu, 100)}%;background:${loadColor(c.stats.cpu)}"></i></div><span class="sm digit">${c.stats.cpu}%</span>` : '<span class="sm">—</span>'}</td>
    <td>${c.stats ? `<div class="bar mem"><i style="width:${Math.min(memOf(c.stats.mem) * 8, 100)}%"></i></div><span class="sm digit">${fmtMb(c.stats.mem)}</span>` : '<span class="sm">—</span>'}</td>
    <td><canvas class="spark" data-spark="${c.id}"></canvas></td>
    <td>${c.ports.map((p2) => `<span class="chip">${esc(p2)}</span>`).join('') || '<span class="sm">—</span>'}</td>
    <td><span class="pill ${(STATE_RU[c.state] || ['', 'g'])[1]}">${(STATE_RU[c.state] || [c.state])[0]}</span><div class="sm" style="margin-top:4px">${esc(uptimeRu(c.status))}</div></td>
    <td class="acts">${c.state === 'running' ? '' : `<button class="btn y sm-btn" onclick="act('${c.id}','${c.state === 'paused' ? 'unpause' : 'start'}')">${c.state === 'paused' ? 'Продолжить' : 'Запустить'}</button>`}${kebab(`ctMenu(event,'${c.id}')`)}</td></tr>`;
    }
  }
  el.innerHTML = `<div class="panelbox"><h3>Контейнеры · ${list.length} из ${data.containers.length}</h3>
  <input id="f" placeholder="Поиск: имя, описание, образ…" value="${esc(filterText)}" oninput="filterText=this.value;render()" style="margin-bottom:12px;width:320px">
  <table><tr><th>Контейнер и содержимое</th><th style="width:120px">CPU</th><th style="width:120px">RAM</th><th style="width:100px">Тренд</th><th>Порты</th><th>Состояние</th><th style="width:150px;text-align:right"></th></tr>${rows}</table></div>`;
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
  <div class="panelbox"><div class="ph"><h3>Время ответа</h3><div class="legend"><span><i style="background:var(--ok)"></i>до 800 мс</span><span><i style="background:var(--warn)"></i>медленно</span><span><i style="background:var(--red)"></i>ошибка</span></div></div>
  <div class="latlist">${sorted.slice(0, 20).map((s) => {
    const st = s.code >= 400 || s.code === 0 ? 'bad' : s.ms > 800 ? 'slow' : 'ok';
    const scale = Math.max(maxMs * 1.1, 500);
    return `<div class="lrow ${st}"><a class="ld" href="https://${esc(s.domain)}" target="_blank" rel="noopener">${esc(s.domain)}</a>
      <div class="lt"><i style="width:${s.code ? Math.max((s.ms / scale) * 100, 2) : 100}%"></i></div>
      <span class="lv">${s.code ? s.ms + ' мс' : 'нет ответа'}</span></div>`;
  }).join('') || '<p class="sm">Нет доменов под фильтр</p>'}</div></div>
  <input id="fs" placeholder="Найти домен" value="${esc(filterSites)}" oninput="filterSites=this.value;render()" style="margin-bottom:12px;width:280px">
  <div class="sites">` +
    sorted
      .map((s, i) => {
        const dot = s.code > 0 && s.code < 400 ? 'on' : s.code >= 500 || s.code === 0 ? 'bad' : 'warn';
        const upr = uptimeMap[s.domain];
        return `<div class="site" style="animation-delay:${i * 20}ms">
      <div class="d"><span class="dot ${dot}"></span><a href="https://${esc(s.domain)}" target="_blank" style="color:inherit">${esc(s.domain)}</a></div>
      <div class="m">${s.code ? 'HTTP ' + s.code + ' · ' + s.ms + ' мс · ' + timeShort(Date.parse(s.at)) : 'Недоступен · ' + esc(s.error || '')}</div>
      ${s.backend ? `<div class="m" style="margin-top:3px">→ <span class="chip">${esc(s.backend)}</span></div>` : ''}
      ${upr != null ? `<div class="upt"><span>Аптайм</span><b>${upr}%</b></div>` : ''}</div>`;
      })
      .join('') +
    `</div>`;
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
  const free = imagesCache.filter((i) => !i.usedBy);
  const freeSize = free.reduce((a, i) => a + i.size, 0);
  const upd = imagesCache.updates ? Object.keys(imagesCache.updates).filter((k) => imagesCache.updates[k]).length : null;
  const q = imgFilter.toLowerCase();
  let list = imagesCache.filter((i) => (!q || (i.tags.join(' ') || i.id).toLowerCase().includes(q)) && (imgShow === 'all' || (imgShow === 'free' ? !i.usedBy : imgShow === 'used' ? i.usedBy : imagesCache.updates?.[i.tags[0]])));
  list = [...list].sort(imgSort === 'name' ? (a, b) => (a.tags[0] || a.id).localeCompare(b.tags[0] || b.id) : imgSort === 'date' ? (a, b) => b.created - a.created : (a, b) => b.size - a.size);
  const maxSize = Math.max(...imagesCache.map((i) => i.size), 1);
  const seg = (k, label, n) => `<button class="${imgShow === k ? 'on' : ''}" onclick="imgShow='${k}';render()">${label}${n != null ? ' <b>' + n + '</b>' : ''}</button>`;
  el.innerHTML = `<div class="cards">
    ${card('Образов', String(imagesCache.length), fmtMb(total) + ' на диске', null, '')}
    ${card('Используются', String(imagesCache.length - free.length), 'запущены в контейнерах', null, '')}
    ${card('Не используются', String(free.length), fmtMb(freeSize) + ' можно освободить', null, free.length ? 'warn' : '')}
    ${card('Обновления', upd == null ? '…' : String(upd), upd == null ? 'проверяем реестр' : upd ? 'есть новые версии' : 'всё актуально', null, upd ? 'warn' : '')}
  </div>
  <div class="panelbox">
  <div class="toolbar">
    <input placeholder="Найти образ" value="${esc(imgFilter)}" oninput="imgFilter=this.value;render();const i=document.querySelector('.toolbar input');i.focus();i.setSelectionRange(i.value.length,i.value.length)" style="width:240px">
    <div class="seg">${seg('all', 'Все', imagesCache.length)}${seg('used', 'Используются', imagesCache.length - free.length)}${seg('free', 'Свободные', free.length)}${upd ? seg('upd', 'С обновлением', upd) : ''}</div>
    <select onchange="imgSort=this.value;render()" style="width:auto"><option value="size"${imgSort === 'size' ? ' selected' : ''}>Сначала большие</option><option value="date"${imgSort === 'date' ? ' selected' : ''}>Сначала новые</option><option value="name"${imgSort === 'name' ? ' selected' : ''}>По имени</option></select>
    <span style="flex:1"></span>
    ${free.length ? `<button class="btn warn" onclick="delUnused()">Удалить неиспользуемые (${fmtMb(freeSize)})</button>` : ''}
  </div>
  <form onsubmit="pullImage(event)" class="pullform">${ico('pull')}<input name="image" placeholder="Скачать образ: nginx:alpine или ghcr.io/org/image:tag" required><button class="btn y">Скачать</button><span id="pullmsg" class="sm"></span></form>
  <div class="imglist">` +
    list
      .map((i) => {
        const ref = i.tags[0] || i.id;
        const [repo, tag] = ref.includes(':') && !ref.startsWith('sha256') ? [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)] : [ref, ''];
        const hasUpd = i.tags[0] && imagesCache.updates?.[i.tags[0]];
        return `<div class="irow">
        <div class="iname"><div class="mono"><b>${esc(repo)}</b>${tag ? '<span class="tag">' + esc(tag) + '</span>' : ''}${hasUpd ? ' <span class="pill o">есть обновление</span>' : ''}</div>
          <div class="sm">${i.tags.length > 1 ? esc(i.tags.slice(1).join(', ')) + ' · ' : ''}создан ${new Date(i.created * 1000).toLocaleDateString('ru-RU')}</div></div>
        <div class="isize"><div class="lt"><i style="width:${Math.max((i.size / maxSize) * 100, 2)}%"></i></div><span class="digit">${fmtMb(i.size)}</span></div>
        <div>${i.usedBy ? '<span class="pill b">в ' + i.usedBy + ' конт.</span>' : '<span class="pill g">не используется</span>'}</div>
        <div class="acts">${kebab(`imgMenu(event,'${esc(ref)}',${i.usedBy ? 1 : 0})`)}</div></div>`;
      })
      .join('') +
    (list.length ? '' : '<p class="sm" style="padding:14px 4px">Ничего не найдено. Сбросьте фильтр или поиск.</p>') +
    `</div></div>`;
  if (!imagesCache.updates) {
    api('/api/images/updates')
      .then((r) => {
        imagesCache.updates = r.updates;
        if (tab === 'i') render();
      })
      .catch(() => {});
  }
}

let imgFilter = '', imgShow = 'all', imgSort = 'size';
function imgMenu(ev, ref, used) {
  const items = [
    { icon: 'pull', label: 'Обновить из реестра', fn: () => pullRef(ref) },
    { icon: 'copy', label: 'Скопировать имя', fn: () => copyText(ref, 'Имя образа') },
    { icon: 'copy', label: 'Скопировать docker pull', fn: () => copyText('docker pull ' + ref, 'Команда') },
    { icon: 'link', label: 'Открыть на Docker Hub', fn: () => window.open('https://hub.docker.com/' + (ref.includes('/') ? 'r/' : '_/') + ref.split(':')[0], '_blank', 'noopener') },
  ];
  if (!used) items.push('-', { icon: 'trash', label: 'Удалить образ', danger: true, fn: () => delImage(ref) });
  openMenu(ev, ref, items);
}
async function pullRef(ref) {
  toast('Скачиваю ' + ref + '…');
  try {
    await postJson('/api/images/pull', { image: ref });
    toast(ref + ' обновлён');
    imagesCache = null;
    render();
  } catch (e) {
    toast(e.message, 'bad');
  }
}
async function delUnused() {
  const free = imagesCache.filter((i) => !i.usedBy);
  if (!confirm('Удалить ' + free.length + ' неиспользуемых образов? Контейнеры их не используют, при необходимости их можно скачать заново.')) return;
  let ok = 0, fail = 0;
  for (const i of free) {
    try {
      await postJson('/api/images/delete', { ref: i.tags[0] || i.id });
      ok++;
    } catch { fail++; }
  }
  toast('Удалено образов: ' + ok + (fail ? ', не удалось: ' + fail : ''), fail ? 'bad' : '');
  imagesCache = null;
  render();
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
    await postJson('/api/images/delete', { ref });
    toast('Образ ' + ref + ' удалён');
    imagesCache = null;
    render();
  } catch (e) {
    toast(e.message, 'bad');
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
      <pre id="execout" style="background:rgba(10,11,14,.45);border:1px solid var(--edge2);border-radius:12px;padding:12px 14px;color:#c4c3bd;font-family:var(--mono);font-size:12px;overflow:auto;max-height:280px;display:none;margin:10px 0 0"></pre>
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
  <h3 style="margin:4px 0 12px">Настройки</h3>
  <form onsubmit="saveSettings(event)" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;max-width:1100px">
    <div><label class="sm">S3 endpoint</label><input name="endpoint" value="${esc(b.settings.s3?.endpoint || '')}" placeholder="https://storage.yandexcloud.net" style="width:100%"></div>
    <div><label class="sm">Bucket</label><input name="bucket" value="${esc(b.settings.s3?.bucket || '')}" style="width:100%"></div>
    <div><label class="sm">Access Key</label><input name="accessKey" value="${esc(b.settings.s3?.accessKey || '')}" style="width:100%"></div>
    <div><label class="sm">Secret Key</label><input name="secretKey" type="password" value="" placeholder="${b.settings.s3?.hasSecret ? 'сохранён — введите новый, чтобы заменить' : 'не задан'}" autocomplete="new-password" style="width:100%"></div>
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
function goPath(p) {
  filesPath = p;
  filesCache = null;
  render();
}
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
    ${f.path ? `<tr><td colspan="2"><a href="#" data-p="${esc(f.path.split('/').slice(0, -1).join('/'))}" onclick="goPath(this.dataset.p);return false">↩ ..</a></td></tr>` : ''}
    ${f.entries.map((x) => `<tr><td>${x.dir ? '📁' : '📄'} <a href="#" data-p="${esc((f.path ? f.path + '/' : '') + x.name)}" onclick="goPath(this.dataset.p);return false" style="color:inherit">${esc(x.name)}</a>${x.dir ? '' : ` <span class="sm">` + fmtMb(x.size) + `</span>`}</td><td class="sm">${x.dir ? '' : fmtMb(x.size)}</td></tr>`).join('')}
    </table>
    <p class="sm" style="margin-top:10px">Редактируются текстовые файлы до 300 КБ. Перед сохранением предыдущая версия копируется в файл.bak-ДАТА.</p></div>`;
  } else {
    el.innerHTML = `<div class="panelbox"><h3>Редактор · ${esc(f.path)} <span class="sm">(${fmtMb(f.size)})</span></h3>
    <div style="margin-bottom:10px"><a href="#" data-p="${esc(f.path.split('/').slice(0, -1).join('/'))}" onclick="goPath(this.dataset.p);return false">↩ Назад к списку</a></div>
    <textarea id="fedit" style="width:100%;height:50vh;background:rgba(10,11,14,.45);color:#c4c3bd;border:1px solid var(--edge);border-radius:14px;padding:14px 16px;font:12.5px/1.6 var(--mono);resize:vertical">${esc(f.content)}</textarea>
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

const SITE_PRESETS = [
  { k: 'static', t: 'Статический сайт', g: 'Сайт', d: 'Пустая страница на nginx. Файлы кладёте сами в каталог сайта.', db: false, ram: '~10 МБ', time: 'секунды', mark: 'HTML', col: '#9cc9e6' },
  { k: 'wordpress', t: 'WordPress', g: 'CMS', d: 'Блог или сайт компании. Мастер установки откроется по адресу сайта.', db: true, ram: '~150 МБ', time: '1–2 мин', mark: 'WP', col: '#9cc9e6' },
  { k: 'joomla', t: 'Joomla 5', g: 'CMS', d: 'Сайт с гибкой структурой разделов и пользователей.', db: true, ram: '~150 МБ', time: '1–2 мин', mark: 'J', col: '#e9c27a' },
  { k: 'drupal', t: 'Drupal 11', g: 'CMS', d: 'Сложные порталы с большим количеством типов контента.', db: true, ram: '~180 МБ', time: '1–2 мин', mark: 'D', col: '#9cc9e6' },
  { k: 'bitrix', t: '1С-Битрикс', g: 'CMS', d: 'PHP-окружение и мастер установки. Реквизиты базы покажем после создания.', db: true, ram: '~200 МБ', time: '2–3 мин', mark: '1С', col: '#ee8f86' },
  { k: 'opencart', t: 'OpenCart 4', g: 'Магазин', d: 'Интернет-магазин с корзиной и оплатой. Админ создаётся сразу.', db: true, ram: '~200 МБ', time: '2–4 мин', mark: 'OC', col: '#9cc9e6' },
  { k: 'prestashop', t: 'PrestaShop 8', g: 'Магазин', d: 'Магазин с большим каталогом и модулями.', db: true, ram: '~250 МБ', time: '2–4 мин', mark: 'PS', col: '#ee8f86' },
  { k: 'nextcloud', t: 'Nextcloud', g: 'Сервис', d: 'Своё облако для файлов, календарей и контактов.', db: true, ram: '~250 МБ', time: '2–3 мин', mark: 'NC', col: '#9cc9e6' },
  { k: 'n8n', t: 'n8n', g: 'Сервис', d: 'Автоматизации и интеграции между сервисами без кода.', db: false, ram: '~200 МБ', time: '1 мин', mark: 'n8n', col: '#ee8f86' },
  { k: 'jenkins', t: 'Jenkins CI', g: 'Сервис', d: 'Сборка и деплой проектов по расписанию или по коммиту.', db: false, ram: '~500 МБ', time: '1–2 мин', mark: 'CI', col: '#e9c27a' },
  { k: 'ubuntu', t: 'Сервер Ubuntu 24.04', g: 'Сервер', d: 'Отдельная машина с SSH на своём порту. Доступы покажем один раз.', db: false, ram: '~50 МБ', time: '1–2 мин', mark: 'U', col: '#e9c27a' },
];
let newSite = { preset: 'wordpress', name: '', domain: '', nameTouched: false, group: 'Все' };
function renderNew(el) {
  const groups = ['Все', ...new Set(SITE_PRESETS.map((p) => p.g))];
  const list = SITE_PRESETS.filter((p) => newSite.group === 'Все' || p.g === newSite.group);
  el.innerHTML = `<div class="newsite">
  <div>
    <div class="panelbox">
      <div class="ph"><h3>1. Что разворачиваем</h3><div class="seg">${groups.map((g) => `<button type="button" class="${newSite.group === g ? 'on' : ''}" onclick="newSite.group='${g}';render()">${g}</button>`).join('')}</div></div>
      <div class="presets">${list.map((p) => `<button type="button" class="preset ${newSite.preset === p.k ? 'on' : ''}" onclick="pickPreset('${p.k}')" aria-pressed="${newSite.preset === p.k}">
        <span class="pm" style="--pc:${p.col}">${p.mark}</span>
        <span class="pt">${p.t}</span><span class="pd">${p.d}</span>
        <span class="pf"><span>${p.db ? 'своя база MariaDB' : 'без базы'}</span><span>${p.ram}</span><span>${p.time}</span></span></button>`).join('')}</div>
    </div>
    <div class="panelbox">
      <h3>2. Адрес и имя</h3>
      <form id="create" class="nsform" onsubmit="createSite(event)" oninput="nsInput(event)" autocomplete="off">
        <input type="hidden" name="preset" value="${newSite.preset}">
        <div class="fld"><label for="ns-domain">Домен</label><input id="ns-domain" name="domain" placeholder="shop.example.ru" value="${esc(newSite.domain)}" required><div class="fh" id="h-domain"></div></div>
        <div class="fld"><label for="ns-name">Короткое имя</label><input id="ns-name" name="name" placeholder="shop" value="${esc(newSite.name)}" required><div class="fh" id="h-name"></div></div>
        <button class="btn y big" id="ns-go">Создать сайт</button>
      </form>
      <div id="msg"></div>
    </div>
  </div>
  <aside class="panelbox summary" id="ns-sum"></aside>
  </div>`;
  nsUpdate();
}
function pickPreset(k) {
  newSite.preset = k;
  render();
}
function nsInput(e) {
  const f = e.target.form || e.target;
  if (e.target.name === 'name') newSite.nameTouched = !!e.target.value;
  newSite.domain = f.domain.value.trim().toLowerCase();
  if (!newSite.nameTouched) {
    newSite.name = newSite.domain.split('.')[0].replace(/[^a-z0-9-]/g, '').slice(0, 40);
    f.name.value = newSite.name;
  } else newSite.name = f.name.value.trim().toLowerCase();
  nsUpdate();
}
function nsUpdate() {
  const p = SITE_PRESETS.find((x) => x.k === newSite.preset);
  const n = newSite.name, d = newSite.domain;
  const nameOk = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(n);
  const domOk = /^[a-z0-9._-]+\.[a-z]{2,}$/.test(d);
  const nameBusy = data?.containers.some((c) => c.name === 'aksite-' + n);
  const domBusy = data?.sites.some((s) => s.domain === d);
  const hint = (id, txt, bad) => { const h = document.getElementById(id); if (h) { h.textContent = txt; h.className = 'fh ' + (bad ? 'bad' : 'okh'); } };
  hint('h-domain', !d ? 'DNS-запись домена должна указывать на этот сервер' : !domOk ? 'Похоже на опечатку: нужен домен вида site.ru' : domBusy ? 'Этот домен уже обслуживается сервером' : 'Домен подходит, сертификат выпустится автоматически', d && (!domOk || domBusy));
  hint('h-name', !n ? 'Латиница, цифры и дефис, 3–40 символов' : !nameOk ? 'Только a–z, 0–9 и дефис, 3–40 символов, без дефиса по краям' : nameBusy ? 'Контейнер aksite-' + n + ' уже существует' : 'Свободно', n && (!nameOk || nameBusy));
  const ready = nameOk && domOk && !nameBusy && !domBusy;
  const go = document.getElementById('ns-go');
  if (go) go.disabled = !ready;
  const nm = n || '<имя>', dm = d || '<домен>';
  const rows = [
    ['Адрес', 'https://' + dm],
    ['Контейнер', 'aksite-' + nm],
    [p.k === 'static' ? 'Файлы сайта' : 'Данные', p.k === 'static' ? '/opt/fleet/deploy/aksites/html/' + nm : 'том aksite-' + nm + '-data'],
  ];
  if (p.db) rows.push(['База данных', 'отдельная база и пользователь в aksite-db']);
  if (p.k === 'ubuntu') rows.push(['Доступ', 'SSH на отдельном порту']);
  rows.push(['Прокси', 'блок в Caddyfile и HTTPS-сертификат']);
  const sum = document.getElementById('ns-sum');
  if (sum) sum.innerHTML = `<h3>Что будет создано</h3>
    <div class="sp"><span class="pm" style="--pc:${p.col}">${p.mark}</span><div><b>${p.t}</b><div class="sm">${p.g}</div></div></div>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd class="mono">${esc(v)}</dd>`).join('')}</dl>
    <div class="meta"><div><span>Память</span><b>${p.ram}</b></div><div><span>Развёртка</span><b>${p.time}</b></div></div>
    <ol class="steps">
      <li class="${domOk && !domBusy ? 'done' : ''}">Указать домен</li>
      <li class="${nameOk && !nameBusy ? 'done' : ''}">Проверить имя</li>
      <li>Создать и дождаться запуска</li>
      <li>${p.db || p.k === 'bitrix' ? 'Пройти мастер установки на сайте' : p.k === 'ubuntu' ? 'Подключиться по SSH' : 'Загрузить файлы сайта'}</li>
    </ol>
    <p class="sm">Пароли и доступы покажем один раз сразу после создания. Сохраните их.</p>`;
}

/* ---------- действия ---------- */
async function load() {
  try {
    data = await api('/api/overview');
    sample();
    const typing = document.activeElement?.closest?.('#out') && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (tab === 'n') nsUpdate();
    else if (!typing) render();
  } catch (e) {
    const el = $('#out');
    if (el && !data) el.innerHTML = '<p class="bad">Ошибка связи: ' + esc(e.message) + '</p>';
  }
}
const ACT_DONE = { start: 'запущен', stop: 'остановлен', restart: 'перезапущен', pause: 'приостановлен', unpause: 'продолжает работу', kill: 'завершён принудительно' };
async function act(id, a) {
  if (a === 'stop' && !confirm('Остановить контейнер?')) return;
  if (a === 'kill' && !confirm('Завершить контейнер принудительно (SIGKILL)? Несохранённые данные процесса могут потеряться.')) return;
  const name = data?.containers.find((x) => x.id === id)?.name || id;
  try {
    await postJson('/api/containers/' + id + '/action', { action: a });
    toast(name + ' ' + ACT_DONE[a]);
    load();
  } catch (e) {
    toast(e.message, 'bad');
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
    const r = await fetch('/api/containers/' + logId + '/logs?lines=400');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const box = $('#logs');
    let lines = (await r.text()).split('\n');
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
  msg.textContent = 'Создаём сайт. Первый запуск CMS может занять несколько минут: скачивается образ.';
  const go = $('#ns-go');
  if (go) { go.disabled = true; go.textContent = 'Создаём…'; }
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
    const out = $('#out');
    out.classList.remove('intro');
    void out.offsetWidth;
    out.classList.add('intro');
    clearTimeout(window.__introT);
    window.__introT = setTimeout(() => out.classList.remove('intro'), 1600);
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
