// Infra Panel — отдельная панель управления docker-контейнерами и сайтами сервера.
// Зависимостей нет: чистый Node (HTTP + unix-сокет к dockerd). Своя авторизация (env ADMIN_USER/ADMIN_PASSWORD).
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const PORT = Number(process.env.PORT || 8080);
const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const HOST_DEPLOY = process.env.HOST_DEPLOY_DIR || '/host-deploy';
// Путь к каталогу деплоя на СТОРОНЕ ХОСТА: probe-контейнеры монтируют его в helper-пути
// (bind всегда разрешается на хосте, а /host-deploy существует только внутри контейнера панели).
const HOST_DEPLOY_HOST = process.env.HOST_DEPLOY_HOST || '/opt/fleet/deploy';
const DATA_DIR = process.env.DATA_DIR || '/data';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.PANEL_SECRET || crypto.randomBytes(24).toString('hex');
const SESSION_DAYS = 7;

const CLIENT_JS = await readFile(new URL('./client.js', import.meta.url), 'utf8').catch(() => '// client.js не найден');

/* ---------- описания контейнеров: что внутри ---------- */

const DESCRIPTIONS = {
  'infra-panel': 'Эта панель управления инфраструктурой',
};

function describe(c) {
  if (DESCRIPTIONS[c.name]) return DESCRIPTIONS[c.name];
  const m = /^aksite-(.+)$/.exec(c.name);
  if (m && c.preset && PRESETS[c.preset]) return `${PRESETS[c.preset].title} — aksite-${m[1]}`;
  if (m) return `Статический сайт ${m[1]} — nginx, файлы в /opt/fleet/deploy/aksites/html/${m[1]}`;
  if (c.project === 'aksites') return 'Статический сайт (nginx)';
  return '';
}

/* ---------- auth ---------- */

const sign = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
// сравнение за постоянное время: длина не утекает, т.к. сравниваются хэши
const safeEqual = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

function makeSession(user) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const payload = `${user}.${exp}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function checkSession(cookieHeader) {
  const raw = /(?:^|;\s*)panel_session=([^;]+)/.exec(cookieHeader || '')?.[1];
  if (!raw) return null;
  const [b64, sig] = raw.split('.');
  if (!b64 || !sig) return null;
  const payload = Buffer.from(b64, 'base64url').toString();
  if (!safeEqual(sign(payload), sig)) return null;
  const [user, exp] = payload.split('.');
  if (user !== ADMIN_USER || Number(exp) < Date.now()) return null;
  return user;
}

const loginAttempts = new Map();
let globalFails = [];
function loginLimited(ip) {
  const now = Date.now();
  const list = (loginAttempts.get(ip) || []).filter((t) => now - t < 600_000);
  if (list.length) loginAttempts.set(ip, list);
  else loginAttempts.delete(ip);
  globalFails = globalFails.filter((t) => now - t < 600_000);
  // общий потолок: подмена IP не даёт перебирать пароль бесконечно
  return list.length >= 5 || globalFails.length >= 50;
}
function loginFailed(ip) {
  const list = loginAttempts.get(ip) || [];
  list.push(Date.now());
  loginAttempts.set(ip, list);
  globalFails.push(Date.now());
  if (loginAttempts.size > 10000) loginAttempts.clear();
}
// IP клиента: последний адрес X-Forwarded-For дописан нашим reverse proxy, первые клиент может подделать
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress || 'local';
}
// защита от CSRF: изменяющие запросы принимаются только со своей страницы
function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return req.headers['sec-fetch-site'] ? req.headers['sec-fetch-site'] === 'same-origin' : true;
  try {
    const o = new URL(origin);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return o.host === host;
  } catch {
    return false;
  }
}
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/* ---------- docker socket ---------- */

function dockerRequest(path, { method = 'GET', body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET, path, method, headers: body ? { 'Content-Type': 'application/json' } : {}, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('docker timeout')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/* потоковый прокси (docker events) */
function dockerStream(path, res) {
  const req = http.request({ socketPath: SOCKET, path, timeout: 0 }, (up) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    up.pipe(res);
    up.on('error', () => res.end());
  });
  req.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.end();
  req.on('close', () => res.end());
  res.on('close', () => req.destroy());
}

async function dockerJson(path, opts) {
  const r = await dockerRequest(path, opts);
  try {
    return { status: r.status, data: JSON.parse(r.body.toString('utf8')) };
  } catch {
    return { status: r.status, data: null, raw: r.body.toString('utf8').slice(0, 300) };
  }
}

function demux(buf) {
  if (buf.length < 8) return buf.toString('utf8');
  const size = buf.readUInt32BE(4);
  if (buf[0] > 2 || size === 0 || size > buf.length - 8) return buf.toString('utf8');
  const out = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off + 4);
    if (len === 0 || off + 8 + len > buf.length) break;
    out.push(buf.subarray(off + 8, off + 8 + len));
    off += 8 + len;
  }
  return Buffer.concat(out).toString('utf8');
}

function parseDomains(source) {
  const domains = [];
  for (const line of source.split('\n')) {
    const m = /^([a-z0-9*.,_\-:/ ]+)\{\s*$/.exec(line.trim().toLowerCase());
    if (!m) continue;
    for (const token of m[1].split(',')) {
      const d = token.trim().replace(/^https?:\/\//, '');
      if (!d || d.includes('*') || d.startsWith(':')) continue;
      if (/^[a-z0-9._-]+\.[a-z]{2,}$/.test(d) && !domains.includes(d)) domains.push(d);
    }
  }
  return domains;
}

/* домен → бэкенд (reverse_proxy) из Caddyfile */
function parseBackendMap(source) {
  const map = {};
  let domains = null;
  for (const line of source.split('\n')) {
    const t = line.trim();
    const head = /^([a-z0-9.,_\- ]+)\{\s*$/.exec(t.toLowerCase());
    if (head) {
      domains = head[1].split(',').map((d) => d.trim()).filter((d) => /^[a-z0-9._-]+\.[a-z]{2,}$/.test(d));
      continue;
    }
    const rp = /^reverse_proxy\s+([^\s{]+)/.exec(t);
    if (rp && domains) for (const d of domains) map[d] = rp[1];
    if (t === '}') domains = null;
  }
  return map;
}

/* образы, тома, сети */
async function collectImages() {
  const [{ data: images }, { data: containers }] = await Promise.all([dockerJson('/images/json?all=0'), dockerJson('/containers/json?all=1')]);
  if (!Array.isArray(images)) return [];
  const usage = new Map();
  for (const c of containers || []) usage.set(c.ImageID, (usage.get(c.ImageID) || 0) + 1);
  return images
    .map((i) => ({
      id: i.Id.replace(/^sha256:/, '').slice(0, 12),
      tags: (i.RepoTags || ['<none>']).filter((t) => t !== '<none>:<none>'),
      size: i.Size,
      created: i.Created,
      usedBy: usage.get(i.Id) || 0,
    }))
    .sort((a, b) => b.size - a.size);
}

async function collectVolumes() {
  const [{ data: vols }, { data: df }] = await Promise.all([dockerJson('/volumes'), dockerJson('/system/df')]);
  if (!Array.isArray(vols?.Volumes)) return [];
  const sizeMap = new Map((df?.data?.Volumes || []).map((v) => [v.Name, v.UsageData?.Size || 0]));
  return vols.Volumes.map((v) => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint, size: sizeMap.get(v.Name) || 0, labels: v.Labels || {} })).sort((a, b) => b.size - a.size);
}

async function collectNetworks() {
  const [{ data: nets }, { data: containers }] = await Promise.all([dockerJson('/networks'), dockerJson('/containers/json?all=1')]);
  if (!Array.isArray(nets)) return [];
  const usedByNet = new Map();
  for (const n of nets) usedByNet.set(n.Id, []);
  for (const c of containers || []) {
    for (const nid of Object.keys(c.NetworkSettings?.Networks || {})) {
      const net = nets.find((n) => n.Id === nid);
      if (net) usedByNet.get(nid).push(c.Names[0]?.replace(/^\//, ''));
    }
  }
  return nets
    .filter((n) => !['host', 'none'].includes(n.Name))
    .map((n) => ({
      id: n.Id.slice(0, 12),
      name: n.Name,
      driver: n.Driver,
      subnet: n.IPAM?.Config?.[0]?.Subnet || null,
      scope: n.Scope,
      containers: usedByNet.get(n.Id) || [],
      internal: n.Internal,
    }))
    .sort((a, b) => b.containers.length - a.containers.length);
}

/* ---------- S3 (SigV4, чистый Node) ---------- */

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function s3Request(method, key, query, payload, s3) {
  const { endpoint, bucket, accessKey, secretKey, region } = s3;
  const ep = endpoint.replace(/\/+$/, '');
  const qs = query ? '?' + query : '';
  const url = `${ep}/${bucket}/${key}${qs}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(payload || Buffer.alloc(0));
  const headers = {
    host: new URL(ep).host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  const sortedQ = qs
    ? qs
        .slice(1)
        .split('&')
        .map((p) => p.split('='))
        .map(([k, v]) => [k, decodeURIComponent(v || '')])
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`)
        .join('&')
    : '';
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${String(headers[k]).trim()}\n`)
    .join('');
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalRequest = [method, `/${bucket}/${key}`, sortedQ, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmac(`AWS4${secretKey}`, dateStamp);
  k = hmac(k, region);
  k = hmac(k, 's3');
  k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const r = await fetch(url, { method, headers, body: payload || undefined, redirect: 'manual' });
  const body = Buffer.from(await r.arrayBuffer());
  return { status: r.status, body };
}

/* ---------- настройки ---------- */

const SETTINGS_FILE = `${DATA_DIR}/settings.json`;
const settings = {
  s3: null, // {endpoint, bucket, accessKey, secretKey, region, prefix}
  backup: { volumes: null, keepLocal: 7, keepS3: 14, auto: false, hour: 4 },
  lastAutoRun: null,
};

async function loadSettings() {
  try {
    const raw = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    Object.assign(settings, raw);
  } catch { /* дефолты */ }
}

async function saveSettings() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings));
}

/* ---------- бэкапы ---------- */

const HOST_BACKUPS = process.env.HOST_BACKUPS_DIR || '/opt/fleet/backups'; // путь на ХОСТЕ (для helper-биндов)
const LOCAL_BACKUPS = process.env.LOCAL_BACKUPS || '/backups'; // путь внутри контейнера панели (mount)
let backupRunning = false;

function verifyBackup(name, vols) {
  // архив должен содержать записи _data хотя бы половины выбранных томов
  return runProbe(`tar tzf /out/${name} 2>/dev/null | grep -c '_data'`, [`${HOST_BACKUPS}:/out:ro`]).then((out) => {
    const n = parseInt(out.trim(), 10) || 0;
    return n >= Math.max(1, Math.floor(vols.length / 2)) ? n : 0;
  });
}

async function runBackup() {
  if (backupRunning) throw new Error('Бэкап уже выполняется');
  backupRunning = true;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 14);
  const name = `backup-${stamp}.tar.gz`;
  try {
    let vols = settings.backup.volumes;
    if (!vols) {
      const { data: all } = await dockerJson('/volumes');
      vols = (all?.Volumes || []).map((v) => v.Name).filter((n) => n !== 'infra-panel-data');
    }
    if (!vols.length) throw new Error('Нет томов для бэкапа');
    const volPaths = vols.map((v) => `vols/${v.replace(/[^\w-]/g, '')}`).join(' ');
    // busybox tar: -C применяется только к ближайшему аргументу — используем cd + полные пути
    const makeCmd = `cd / && tar czf /out/${name} --exclude='*node_modules*' --exclude='*.git*' --exclude='*aksites/html*' ${volPaths} deploy 2>&1 | tail -5; ls -la /out/${name}`;
    // биндим каждый том отдельно: bind родительской директории даёт старый снапшот inode
    // для недавно пересозданных docker'ом каталогов томов
    const backupBinds = [
      ...vols.map((v) => `/var/lib/docker/volumes/${v}:/vols/${v}:ro`),
      `${HOST_DEPLOY}:/deploy:ro`,
      `${HOST_BACKUPS}:${HOST_BACKUPS}:rw`,
      `${HOST_BACKUPS}:/out:rw`,
    ];
    let volEntries = 0;
    let probeOut = '';
    for (let attempt = 1; attempt <= 2 && !volEntries; attempt++) {
      probeOut = await runProbe(makeCmd, backupBinds, 'alpine:3');
      volEntries = await verifyBackup(name, vols);
      if (!volEntries && attempt === 1) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!volEntries) {
      const { unlink } = await import('node:fs/promises');
      await unlink(`${LOCAL_BACKUPS}/${name}`).catch(() => {});
      throw new Error('Архив без данных томов. CMD=[' + makeCmd + '] OUT: ' + probeOut.slice(0, 600));
    }
    const { stat } = await import('node:fs/promises');
    const size = (await stat(`${LOCAL_BACKUPS}/${name}`).catch(() => null))?.size || 0;
    // выгрузка в S3
    let uploaded = false;
    if (settings.s3?.accessKey) {
      const body = await readFile(`${LOCAL_BACKUPS}/${name}`);
      const key = `${settings.s3.prefix || 'fleet'}${name}`;
      const r = await s3Request('PUT', key, '', body, settings.s3);
      if (r.status >= 400) throw new Error('S3 upload: HTTP ' + r.status + ' ' + r.body.toString('utf8').slice(0, 200));
      uploaded = true;
    }
    // ротация
    await pruneBackups();
    settings.lastAutoRun = new Date().toISOString().slice(0, 10);
    await saveSettings();
    return { ok: true, name, size, uploaded, volEntries };
  } finally {
    backupRunning = false;
  }
}

async function listLocalBackups() {
  const { readdir } = await import('node:fs/promises');
  try {
    const files = await readdir(LOCAL_BACKUPS);
    const out = [];
    for (const f of files.filter((f2) => f2.endsWith('.tar.gz') && f2.startsWith('backup-'))) {
      const { stat } = await import('node:fs/promises');
      const s = await stat(`${LOCAL_BACKUPS}/${f}`).catch(() => null);
      out.push({ name: f, size: s?.size || 0, at: s?.mtime });
    }
    return out.sort((a, b) => (a.name < b.name ? 1 : -1));
  } catch {
    return [];
  }
}

async function listS3Backups() {
  if (!settings.s3?.accessKey) return [];
  const prefix = settings.s3.prefix || 'fleet';
  const q = 'list-type=2&prefix=' + encodeURIComponent(prefix);
  const r = await s3Request('GET', '', q, null, settings.s3);
  if (r.status >= 400) return [];
  const xml = r.body.toString('utf8');
  const items = [];
  const re = /<Key>([^<]+)<\/Key><LastModified>([^<]+)<\/LastModified>(?:<ETag>[^<]*<\/ETag><Size>(\d+)<\/Size>)?/g;
  let m;
  while ((m = re.exec(xml))) items.push({ name: m[1].slice(prefix.length), full: m[1], size: Number(m[3] || 0), at: m[2] });
  return items.sort((a, b) => (a.full < b.full ? 1 : -1));
}

async function pruneBackups() {
  const local = await listLocalBackups();
  for (const b of local.slice(settings.backup.keepLocal)) {
    const { unlink } = await import('node:fs/promises');
    await unlink(`${LOCAL_BACKUPS}/${b.name}`).catch(() => {});
  }
  if (settings.s3?.accessKey) {
    const remote = await listS3Backups();
    for (const b of remote.slice(settings.backup.keepS3)) {
      await s3Request('DELETE', b.full, '', null, settings.s3).catch(() => {});
    }
  }
}

/* планировщик: раз в 10 минут проверяем время автобэкапа */
setInterval(async () => {
  try {
    if (!settings.backup.auto || backupRunning || !settings.s3) return;
    const now = new Date();
    if (now.getHours() !== settings.backup.hour) return;
    const today = now.toISOString().slice(0, 10);
    if (settings.lastAutoRun === today) return;
    await runBackup();
  } catch { /* следующий цикл */ }
}, 600_000);

/* ---------- проверка обновлений образов ---------- */

const updateCache = { at: 0, map: {} };

async function checkImageUpdates(images) {
  if (Date.now() - updateCache.at < 3600_000) return updateCache.map;
  const map = {};
  await Promise.all(
    images.slice(0, 40).map(async (img) => {
      const tag = (img.tags || [])[0];
      if (!tag) return;
      try {
        let registry = 'registry-1.docker.io';
        let repo = tag.split(':')[0];
        const path = tag.split(':')[0];
        if (path.includes('ghcr.io')) {
          registry = 'ghcr.io';
          repo = path.replace('ghcr.io/', '');
        } else if (path.includes('/')) {
          repo = path;
        } else {
          repo = 'library/' + path;
        }
        const local = await dockerJson(`/images/${encodeURIComponent(tag)}/json`);
        const localDigest = (local.data?.RepoDigests?.[0] || '').split('@')[1];
        if (!localDigest) return;
        const tokenUrl =
          registry === 'ghcr.io'
            ? `https://ghcr.io/token?scope=repository:${repo}:pull`
            : `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
        const tk = await fetch(tokenUrl).then((r) => r.json());
        const mr = await fetch(`https://${registry}/v2/${repo}/manifests/latest`, {
          headers: { Authorization: `Bearer ${tk.token || tk.access_token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' },
          redirect: 'manual',
        });
        const remoteDigest = mr.headers.get('docker-content-digest');
        if (remoteDigest) map[tag] = remoteDigest !== localDigest;
      } catch { /* registry не ответил — пропускаем */ }
    }),
  );
  updateCache.at = Date.now();
  updateCache.map = map;
  return map;
}

/* ---------- файловый менеджер (только /host-deploy) ---------- */

const FILES_ROOT = HOST_DEPLOY;

function safePath(p) {
  const clean = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').includes('..')) return null;
  return clean;
}

async function collectFileList(p) {
  const { readdir, stat } = await import('node:fs/promises');
  const abs = `${FILES_ROOT}/${p}`;
  const entries = await readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries.slice(0, 200)) {
    if (['node_modules', '.git', 'dist'].includes(e.name)) continue;
    const s = await stat(`${abs}/${e.name}`).catch(() => null);
    out.push({ name: e.name, dir: e.isDirectory(), size: s?.size || 0 });
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

/* ---------- data ---------- */

let cache = { at: 0, containers: [], sites: [], host: null, alerts: [] };

async function collectHost() {
  const { data: info } = await dockerJson('/info');
  if (!info) return null;
  return {
    name: info.Name,
    version: info.ServerVersion,
    ncpu: info.NCPU,
    memTotal: info.MemTotal,
    containersRunning: info.ContainersRunning,
    containersStopped: info.ContainersStopped,
    containersPaused: info.ContainersPaused,
    images: info.Images,
  };
}

async function collectContainers() {
  const { data: list } = await dockerJson('/containers/json?all=1');
  if (!Array.isArray(list)) return [];
  return (
    await Promise.all(
      list.slice(0, 80).map(async (c) => {
        let stats = null;
        if (c.State === 'running') {
          const s = await dockerJson(`/containers/${c.Id}/stats?stream=false`, { timeout: 8000 }).catch(() => null);
          if (s?.data) {
            const dCpu = s.data.cpu_stats?.cpu_usage?.total_usage - s.data.precpu_stats?.cpu_usage?.total_usage;
            const dSys = s.data.cpu_stats?.system_cpu_usage - s.data.precpu_stats?.system_cpu_usage;
            stats = { cpu: dCpu > 0 && dSys > 0 ? Math.round(((dCpu / dSys) * (s.data.cpu_stats?.online_cpus || 1)) * 1000) / 10 : 0, mem: s.data.memory_stats?.usage || 0 };
          }
        }
        const name = c.Names[0]?.replace(/^\//, '') || c.Id.slice(0, 12);
        return {
          id: c.Id.slice(0, 12),
          name,
          desc: describe({ name, project: c.Labels?.['com.docker.compose.project'], preset: c.Labels?.['aksystems.preset'] }),
          image: (c.Image || '').split('@')[0].split(':')[0],
          state: c.State,
          status: c.Status,
          project: c.Labels?.['com.docker.compose.project'] || null,
          ports: (c.Ports || []).filter((p) => p.PublicPort).map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type}`).slice(0, 4),
          stats,
        };
      }),
    )
  ).sort((a, b) => a.name.localeCompare(b.name));
}

async function checkSite(domain) {
  const t0 = Date.now();
  try {
    const res = await fetch(`https://${domain}/`, { redirect: 'follow', signal: AbortSignal.timeout(9000) });
    return { domain, code: res.status, ms: Date.now() - t0, at: new Date().toISOString() };
  } catch (e) {
    return { domain, code: 0, ms: Date.now() - t0, error: String(e.message || e).slice(0, 120), at: new Date().toISOString() };
  }
}

async function collectSites() {
  const source = await readFile(`${HOST_DEPLOY}/Caddyfile`, 'utf8').catch(() => '');
  const backends = parseBackendMap(source);
  const sites = await Promise.all(parseDomains(source).map(checkSite));
  for (const s of sites) s.backend = backends[s.domain] || null;
  return sites;
}

/* ---------- история нагрузки (24 ч) ---------- */

const HIST_FILE = `${DATA_DIR}/history.json`;
const history = { cpu: [], mem: [], sites: {} }; // cpu/mem: [[t, v]], sites: {domain: {ok: n, total: n}}
const HISTORY_KEEP = 24 * 60 * 60 * 1000;

async function loadHistory() {
  try {
    const raw = JSON.parse(await readFile(HIST_FILE, 'utf8'));
    if (Array.isArray(raw.cpu)) history.cpu = raw.cpu.filter((p) => Date.now() - p[0] < HISTORY_KEEP).slice(-2880);
    if (Array.isArray(raw.mem)) history.mem = raw.mem.filter((p) => Date.now() - p[0] < HISTORY_KEEP).slice(-2880);
    if (raw.sites) history.sites = raw.sites;
  } catch { /* первый запуск */ }
}

async function saveHistory() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(HIST_FILE, JSON.stringify(history));
  } catch { /* том не смонтирован — история только в памяти */ }
}

async function sampleOnce() {
  try {
    const ov = await overview();
    const t = Date.now();
    history.cpu.push([t, Math.round(ov.containers.reduce((a, c) => a + (c.stats?.cpu || 0), 0) * 10) / 10]);
    history.mem.push([t, ov.host?.memTotal ? Math.round((ov.containers.reduce((a, c) => a + (c.stats?.mem || 0), 0) / ov.host.memTotal) * 1000) / 10 : 0]);
    for (const s of ov.sites) {
      const rec = (history.sites[s.domain] ||= { ok: 0, total: 0 });
      rec.total++;
      if (s.code > 0 && s.code < 400) rec.ok++;
      if (rec.total > 100000) {
        rec.total = Math.floor(rec.total / 2);
        rec.ok = Math.floor(rec.ok / 2);
      }
    }
    const cutoff = t - HISTORY_KEEP;
    while (history.cpu.length && history.cpu[0][0] < cutoff) history.cpu.shift();
    while (history.mem.length && history.mem[0][0] < cutoff) history.mem.shift();
  } catch { /* docker не отвечает — пропускаем замер */ }
}

/* ---------- алерты ---------- */

async function collectDisk() {
  const df = await dockerJson('/system/df');
  const host = await runProbe('df -h /host 2>/dev/null | tail -1', ['/:/host:ro']).catch(() => '');
  // Filesystem  Size  Used Avail Use% Mounted
  const parts = host.trim().split(/\s+/);
  const disk = parts.length >= 5 ? { size: parts[1], used: parts[2], avail: parts[3], usePct: parseInt(parts[4], 10) || 0 } : null;
  const images = Array.isArray(df.data?.Images) ? df.data.Images : [];
  const imgSize = images.reduce((a, i) => a + (i.Size || 0) - (i.SharedSize || 0), 0);
  return { disk, docker: { images: images.length, imagesSize: imgSize, containers: df.data?.Containers?.length ?? 0, volumes: df.data?.Volumes?.length ?? 0 } };
}

function buildAlerts(ov, disk) {
  const alerts = [];
  for (const s of ov.sites) {
    if (s.code === 0 || s.code >= 500) alerts.push({ level: 'crit', text: `Сайт недоступен: ${s.domain}${s.error ? ' — ' + s.error : ''}` });
    else if (s.code >= 400) alerts.push({ level: 'warn', text: `Сайт отвечает ${s.code}: ${s.domain}` });
  }
  for (const c of ov.containers) {
    if (c.state === 'exited' && c.project !== 'aksites') alerts.push({ level: 'warn', text: `Контейнер остановлен: ${c.name}` });
  }
  const cpu = ov.containers.reduce((a, c) => a + (c.stats?.cpu || 0), 0);
  const memPct = ov.host?.memTotal ? (ov.containers.reduce((a, c) => a + (c.stats?.mem || 0), 0) / ov.host.memTotal) * 100 : 0;
  if (ov.host?.ncpu && cpu > ov.host.ncpu * 85) alerts.push({ level: 'crit', text: `Перегруз CPU: ${cpu.toFixed(0)}% при ${ov.host.ncpu} ядрах` });
  if (memPct > 90) alerts.push({ level: 'crit', text: `RAM почти исчерпана: ${memPct.toFixed(0)}%` });
  else if (memPct > 75) alerts.push({ level: 'warn', text: `RAM загружена на ${memPct.toFixed(0)}%` });
  if (disk?.disk?.usePct > 90) alerts.push({ level: 'crit', text: `Диск заполнен на ${disk.disk.usePct}% (${disk.disk.used} из ${disk.disk.size})` });
  else if (disk?.disk?.usePct > 75) alerts.push({ level: 'warn', text: `Диск заполнен на ${disk.disk.usePct}%` });
  return alerts;
}

async function overview() {
  if (Date.now() - cache.at < 20_000 && cache.containers.length) return cache;
  const [containers, sites, host, disk] = await Promise.all([collectContainers(), collectSites(), collectHost(), collectDisk().catch(() => null)]);
  cache = { at: Date.now(), containers, sites, host, disk, alerts: buildAlerts({ containers, sites, host }, disk) };
  return cache;
}

/* ---------- probe / helper ---------- */

async function runProbe(cmd, binds = null, image = 'alpine:3') {
  await ensureImage(image);
  const create = await dockerJson('/containers/create', {
    method: 'POST',
    body: { Image: image, Cmd: ['sh', '-c', cmd], HostConfig: { Binds: binds || [`${HOST_DEPLOY_HOST}:${HOST_DEPLOY}`] } },
  });
  if (create.status !== 201) throw new Error(`helper: HTTP ${create.status}`);
  const id = create.data.Id;
  try {
    await dockerRequest(`/containers/${id}/start`, { method: 'POST' });
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await dockerJson(`/containers/${id}/json`).catch(() => null);
      if (!st || st.data?.State?.Status !== 'running') break;
    }
    const log = await dockerRequest(`/containers/${id}/logs?stdout=1&stderr=1&tail=50`).catch(() => null);
    return log ? demux(log.body) : '';
  } finally {
    await dockerRequest(`/containers/${id}?force=1`, { method: 'DELETE' }).catch(() => {});
  }
}

/* ---------- create site ---------- */

const PLACEHOLDER = (domain) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${domain}</title>
<style>body{font-family:system-ui;background:#0b0e14;color:#e8e8e8;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
div{text-align:center}h1{font-size:28px;margin:0 0 8px}p{color:#34d399}</style></head>
<div><h1>${domain}</h1><p>Домен подключён. Наполнение появится позже.</p></div></body></html>`;

/* ---------- middle: create site / presets / http server / routes / pages ---------- */

async function ensureImage(name) {
  const has = await dockerRequest(`/images/${encodeURIComponent(name)}/json`);
  if (has.status === 200) return;
  const pull = await dockerRequest(`/images/create?fromImage=${encodeURIComponent(name)}`, { method: 'POST', timeout: 600000 });
  if (pull.status >= 400) throw new Error(`образ ${name} не скачался`);
}

async function runHelper(shellCmd) {
  await ensureImage('alpine:3');
  const out = await runProbe(shellCmd);
  if (/FAILED|Traceback/i.test(out)) throw new Error('helper: ошибка записи файлов');
}

/* Предустановки популярных систем (как у хостеров): официальный образ + база в общем MariaDB.
   MariaDB (aksite-db) поднимается при первой CMS-установке; у каждого сайта своя БД и пользователь. */
const PRESETS = {
  static: { title: 'Статический сайт', desc: 'Пустая страница-заглушка (nginx)' },
  wordpress: {
    title: 'WordPress',
    image: 'wordpress:php8.3-apache',
    webroot: '/var/www/html',
    env: (d) => ({ WORDPRESS_DB_HOST: 'aksite-db:3306', WORDPRESS_DB_NAME: d.dbName, WORDPRESS_DB_USER: d.dbUser, WORDPRESS_DB_PASSWORD: d.dbPass, WORDPRESS_TABLE_PREFIX: 'wp_' }),
  },
  joomla: {
    title: 'Joomla 5',
    image: 'joomla:5.3-php8.3-apache',
    webroot: '/var/www/html',
    env: (d) => ({ JOOMLA_DB_HOST: 'aksite-db:3306', JOOMLA_DB_NAME: d.dbName, JOOMLA_DB_USER: d.dbUser, JOOMLA_DB_PASSWORD: d.dbPass, JOOMLA_SITE_NAME: d.domain }),
  },
  drupal: {
    title: 'Drupal 11',
    image: 'drupal:11-apache',
    webroot: '/var/www/html',
    env: (d) => ({ DRUPAL_DB_HOST: 'aksite-db:3306', DRUPAL_DB_NAME: d.dbName, DRUPAL_DB_USER: d.dbUser, DRUPAL_DB_PASSWORD: d.dbPass }),
  },
  opencart: {
    title: 'OpenCart 4',
    image: 'bitnami/opencart:4',
    webroot: '/bitnami/opencart',
    binds: ['/bitnami/apache'],
    env: (d) => ({ OPENCART_DATABASE_HOST: 'aksite-db', OPENCART_DATABASE_PORT_NUMBER: '3306', OPENCART_DATABASE_NAME: d.dbName, OPENCART_DATABASE_USER: d.dbUser, OPENCART_DATABASE_PASSWORD: d.dbPass, OPENCART_HOST: d.domain, OPENCART_ENABLE_HTTPS: 'yes', ALLOW_EMPTY_PASSWORD: 'no' }),
  },
  prestashop: {
    title: 'PrestaShop 8',
    image: 'prestashop/prestashop:8',
    webroot: '/var/www/html',
    admin: true,
    env: (d) => ({ DB_SERVER: 'aksite-db', DB_NAME: d.dbName, DB_USER: d.dbUser, DB_PASSWD: d.dbPass, DB_PREFIX: 'ps_', PS_INSTALL_AUTO: '1', PS_DOMAIN: d.domain, PS_FOLDER_INSTALL: 'install_disabled', PS_LANGUAGE: 'ru', PS_COUNTRY: 'RU', ADMIN_MAIL: `admin@${d.domain}`, ADMIN_PASSWD: d.adminPass }),
  },
  nextcloud: {
    title: 'Nextcloud',
    image: 'nextcloud:30-apache',
    webroot: '/var/www/html',
    admin: true,
    env: (d) => ({ MYSQL_HOST: 'aksite-db', MYSQL_DATABASE: d.dbName, MYSQL_USER: d.dbUser, MYSQL_PASSWORD: d.dbPass, NEXTCLOUD_ADMIN_USER: 'admin', NEXTCLOUD_ADMIN_PASSWORD: d.adminPass, OVERWRITEPROTOCOL: 'https', OVERWRITEHOST: d.domain, TRUSTED_DOMAINS: d.domain }),
  },
  bitrix: {
    title: '1C-Битрикс: Управление сайтом',
    image: 'php:8.2-apache',
    webroot: '/var/www/html',
    db: true,
    dbcreds: true,
    setup: 'bitrix',
  },
  n8n: {
    title: 'n8n · автоматизации',
    image: 'n8nio/n8n:latest',
    webroot: '/home/node/.n8n',
    note: 'На первом входе n8n попросит создать владельца (email + пароль).',
    env: (d) => ({ GENERIC_TIMEZONE: 'Europe/Moscow', N8N_ENCRYPTION_KEY: d.adminPass, N8N_DIAGNOSTICS_ENABLED: 'false' }),
    admin: true,
  },
  jenkins: {
    title: 'Jenkins CI',
    image: 'jenkins/jenkins:lts-jdk21',
    webroot: '/var/jenkins_home',
    note: 'После входа Jenkins попросит ключ разблокировки — он в логах контейнера (кнопка «Логи»).',
  },
  ubuntu: {
    title: 'Сервер Ubuntu 24.04',
    image: 'ubuntu:24.04',
    server: true,
  },
};

const BITRIX_SETUP = `export DEBIAN_FRONTEND=noninteractive; \
apt-get update -qq; apt-get install -y -qq libpng-dev libjpeg-dev libonig-dev libzip-dev unzip curl >/dev/null 2>&1; \
docker-php-ext-install -j"$(nproc)" mysqli mbstring zip opcache >/dev/null 2>&1; \
docker-php-ext-configure gd --with-jpeg >/dev/null 2>&1 && docker-php-ext-install -j"$(nproc)" gd >/dev/null 2>&1; \
[ -f /var/www/html/bitrixsetup.php ] || curl -fsSL -o /var/www/html/bitrixsetup.php https://www.1c-bitrix.ru/download/bitrixsetup.php; \
chown -R www-data:www-data /var/www/html; exec apache2-foreground`;

const UBUNTU_SETUP = `export DEBIAN_FRONTEND=noninteractive; \
apt-get update -qq; apt-get install -y -qq openssh-server curl >/dev/null 2>&1; \
mkdir -p /run/sshd; echo 'root:__PASS__' | chpasswd; \
sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config; \
exec /usr/sbin/sshd -D`;

/* Общая MariaDB сайтов: пароль root генерируется при первом запуске и хранится в /data. */
const dbConfigPath = `${DATA_DIR}/aksite-db.json`;
async function sharedDbConfig() {
  let cfg = null;
  try {
    cfg = JSON.parse(await readFile(dbConfigPath, 'utf8'));
  } catch {}
  if (!cfg) {
    cfg = { root: crypto.randomBytes(18).toString('base64url') };
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(dbConfigPath, JSON.stringify(cfg));
  }
  return cfg;
}

async function ensureSharedDb() {
  const cfg = await sharedDbConfig();
  const { data: list } = await dockerJson('/containers/json?all=1');
  if (list?.some((c) => c.Names.includes('/aksite-db'))) return cfg;
  await ensureImage('mariadb:11');
  const create = await dockerJson(`/containers/create?name=${encodeURIComponent('aksite-db')}`, {
    method: 'POST',
    body: {
      Image: 'mariadb:11',
      Env: [`MYSQL_ROOT_PASSWORD=${cfg.root}`],
      Labels: { 'com.docker.compose.project': 'aksites', 'aksystems.site': 'db', 'aksystems.preset': 'mariadb' },
      HostConfig: { Binds: ['aksite-db-data:/var/lib/mysql'], RestartPolicy: { Name: 'unless-stopped' }, NetworkMode: 'fleet_default' },
    },
  });
  if (create.status !== 201) throw new Error(`aksite-db: HTTP ${create.status}`);
  await dockerRequest(`/containers/${create.data.Id}/start`, { method: 'POST' });
  await new Promise((r) => setTimeout(r, 15000));
  return cfg;
}

async function createSiteDb(cfg, name) {
  const dbName = `site_${name.replace(/-/g, '_')}`;
  const dbUser = dbName;
  const dbPass = crypto.randomBytes(12).toString('base64url');
  const sql = `CREATE DATABASE IF NOT EXISTS \`${dbName}\`; CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY '${dbPass}'; GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%'; FLUSH PRIVILEGES;`;
  for (let i = 0; i < 10; i++) {
    const ex = await dockerJson('/containers/aksite-db/exec', { method: 'POST', body: { Attach: false, Env: [`SQL=${sql}`], Cmd: ['sh', '-c', 'mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" -e "$SQL" && echo DB_OK'] } });
    if (ex.status === 201) {
      await dockerRequest(`/exec/${ex.data.Id}/start`, { method: 'POST', body: { Detach: true } });
      return { dbName, dbUser, dbPass };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('aksite-db не отвечает — база сайта не создана');
}

async function createSite(name, domain, presetKey = 'static') {
  const preset = PRESETS[presetKey];
  if (!preset) throw new Error(`Неизвестная предустановка: ${presetKey}`);
  const { data: existing } = await dockerJson('/containers/json?all=1');
  if (existing?.some((c) => c.Names.includes(`/aksite-${name}`))) throw new Error(`aksite-${name} уже существует`);
  const caddy = await readFile(`${HOST_DEPLOY}/Caddyfile`, 'utf8');
  if (caddy.includes(`${domain} {`) || caddy.includes(`, ${domain}`)) throw new Error('домен уже есть в Caddyfile');
  const caddyBlock = Buffer.from(`\n${domain} {\n\timport secure\n\treverse_proxy aksite-${name}:80\n}\n`).toString('base64');

  let image = 'nginx:alpine';
  let env = null;
  let cmd = null;
  let port = null;
  let binds = [`${HOST_DEPLOY}/aksites/html/${name}:/usr/share/nginx/html:ro`];
  let siteResult = { admin: null };

  if (presetKey === 'static') {
    await ensureImage('nginx:alpine');
    const htmlB64 = Buffer.from(PLACEHOLDER(domain)).toString('base64');
    await runHelper(`mkdir -p ${HOST_DEPLOY}/aksites/html/${name} && echo '${htmlB64}' | base64 -d > ${HOST_DEPLOY}/aksites/html/${name}/index.html && echo '${caddyBlock}' | base64 -d >> ${HOST_DEPLOY}/Caddyfile`);
    siteResult.url = `https://${domain}`;
  } else {
    const d = { dbName: null, dbUser: null, dbPass: null, domain, adminPass: null };
    if (preset.db) {
      const cfg = await ensureSharedDb();
      const dbc = await createSiteDb(cfg, name);
      d.dbName = dbc.dbName;
      d.dbUser = dbc.dbUser;
      d.dbPass = dbc.dbPass;
      if (preset.dbcreds) siteResult.db = { host: 'aksite-db:3306', name: d.dbName, user: d.dbUser, password: d.dbPass };
    }
    if (preset.admin) {
      d.adminPass = crypto.randomBytes(10).toString('base64url');
      siteResult.admin = { login: 'admin', password: d.adminPass };
    }
    if (preset.note) siteResult.note = preset.note;
    await ensureImage(preset.image);
    image = preset.image;
    if (preset.env) env = Object.entries(preset.env(d)).map(([k, v]) => `${k}=${v}`);
    if (preset.webroot) binds = [`aksite-${name}-data:${preset.webroot}`, ...(preset.binds || []).map((b) => `aksite-${name}-data:${b}`)];
    if (preset.setup === 'bitrix') cmd = ['bash', '-c', BITRIX_SETUP];
    if (preset.server) {
      const sshPass = crypto.randomBytes(10).toString('base64url');
      port = 30000 + Math.floor(Math.random() * 19000);
      cmd = ['bash', '-c', UBUNTU_SETUP.replace('__PASS__', sshPass)];
      binds = [`aksite-${name}-data:/root`];
      siteResult.ssh = { host: process.env.HOST_PUBLIC_IP || 'IP этого сервера', port, user: 'root', password: sshPass };
    } else {
      await runHelper(`echo '${caddyBlock}' | base64 -d >> ${HOST_DEPLOY}/Caddyfile`);
      siteResult.url = `https://${domain}`;
    }
  }

  const create = await dockerJson(`/containers/create?name=${encodeURIComponent(`aksite-${name}`)}`, {
    method: 'POST',
    body: {
      Image: image,
      Env: env || undefined,
      Cmd: cmd || undefined,
      Labels: { 'com.docker.compose.project': 'aksites', 'aksystems.site': name, 'aksystems.domain': domain, 'aksystems.preset': presetKey },
      HostConfig: {
        Binds: binds,
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: 'fleet_default',
        PortBindings: port ? { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: String(port) }] } : undefined,
      },
    },
  });
  if (create.status !== 201) throw new Error(`контейнер: HTTP ${create.status}`);
  await dockerRequest(`/containers/${create.data.Id}/start`, { method: 'POST' });
  const list = await dockerJson('/containers/json?all=1');
  const caddyC = (list.data || []).find((c) => c.Names[0]?.includes('caddy'));
  if (caddyC) {
    const ex = await dockerJson(`/containers/${caddyC.Id}/exec`, { method: 'POST', body: { Attach: false, Cmd: ['caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'] } });
    if (ex.status === 201) await dockerRequest(`/exec/${ex.data.Id}/start`, { method: 'POST', body: { Detach: true } });
  }
  cache.at = 0;
  return siteResult;
}

/* ---------- HTTP server ---------- */

const json = (res, code, obj, extraHeaders = {}) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(body);
};

const MAX_BODY = 2 * 1024 * 1024;
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_BODY) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });

async function containerLogs(id, lines = 400) {
  const log = await dockerRequest(`/containers/${id}/logs?stdout=1&stderr=1&tail=${lines}`, { timeout: 20000 }).catch(() => null);
  return log ? demux(log.body).toString('utf8') : '';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = clientIp(req);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const user = checkSession(req.headers.cookie);

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return json(res, 403, { error: 'Запрос с чужого сайта отклонён' });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (loginLimited(ip)) return json(res, 429, { error: 'Слишком много попыток. Подождите 10 минут.' });
      const b = await readBody(req);
      const okUser = safeEqual(String(b.user || ''), ADMIN_USER);
      const okPass = safeEqual(String(b.password || ''), ADMIN_PASSWORD);
      if (!ADMIN_PASSWORD || !okUser || !okPass) {
        loginFailed(ip);
        return json(res, 401, { error: 'Неверный логин или пароль' });
      }
      loginAttempts.delete(ip);
      json(res, 200, { ok: true }, { 'Set-Cookie': `panel_session=${makeSession(ADMIN_USER)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}` });
    } else if (url.pathname === '/api/logout' && req.method === 'POST') {
      json(res, 200, { ok: true }, { 'Set-Cookie': `panel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` });
    } else if (url.pathname === '/app.js' && req.method === 'GET') {
      if (!user) return json(res, 401, { error: 'Требуется вход' });
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(CLIENT_JS);
    } else if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(user ? APP_HTML : LOGIN_HTML);
    } else if (!user) {
      json(res, 401, { error: 'Требуется вход' });
    } else if (url.pathname === '/api/overview') {
      json(res, 200, await overview());
    } else if (url.pathname === '/api/history') {
      const uptime = {};
      for (const [d, r] of Object.entries(history.sites)) uptime[d] = r.total ? Math.round((r.ok / r.total) * 1000) / 10 : null;
      json(res, 200, { cpu: history.cpu, mem: history.mem, sites: history.sites, uptime });
    } else if (url.pathname === '/api/events') {
      dockerStream('/events', res);
    } else if (url.pathname === '/api/prune' && req.method === 'POST') {
      const r = await dockerJson('/images/prune', { method: 'POST', body: { filters: { dangling: { true: true } } } });
      json(res, 200, { ok: true, reclaimed: r.data?.SpaceReclaimed || 0 });
    } else if (url.pathname === '/api/images') {
      json(res, 200, { images: await collectImages() });
    } else if (url.pathname === '/api/images/updates') {
      const images = await collectImages();
      await checkImageUpdates(images);
      json(res, 200, { updates: Object.fromEntries(updateCache.map) });
    } else if (url.pathname === '/api/images/pull' && req.method === 'POST') {
      const b = await readBody(req);
      const ref = String(b.image || '').trim();
      if (!/^[a-z0-9./_:@-]{2,200}$/i.test(ref)) return json(res, 400, { error: 'Некорректное имя образа' });
      const r = await dockerRequest(`/images/create?fromImage=${encodeURIComponent(ref)}`, { method: 'POST', timeout: 600000 });
      if (r.status >= 400) return json(res, 500, { error: `не скачался: HTTP ${r.status}` });
      json(res, 200, { ok: true });
    } else if (url.pathname === '/api/images/delete' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await dockerRequest(`/images/${encodeURIComponent(String(b.ref || ''))}?force=0`, { method: 'DELETE' });
      if (r.status >= 400) return json(res, 500, { error: r.raw || 'Не удалось удалить образ (возможно, используется)' });
      json(res, 200, { ok: true });
    } else if (url.pathname === '/api/volumes') {
      json(res, 200, { volumes: await collectVolumes() });
    } else if (url.pathname === '/api/volumes/delete' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await dockerRequest(`/volumes/${encodeURIComponent(String(b.name || ''))}`, { method: 'DELETE' });
      if (r.status >= 400) return json(res, 500, { error: r.raw || 'Не удалось удалить том (возможно, используется)' });
      json(res, 200, { ok: true });
    } else if (url.pathname === '/api/networks') {
      json(res, 200, { networks: await collectNetworks() });
    } else if (url.pathname === '/api/backups') {
      json(res, 200, { settings: { ...settings, s3: settings.s3 ? { ...settings.s3, secretKey: '', hasSecret: !!settings.s3.secretKey } : settings.s3 }, running: backupRunning, local: await listLocalBackups(), s3: await listS3Backups().catch(() => []) });
    } else if (url.pathname === '/api/backups/run' && req.method === 'POST') {
      if (backupRunning) return json(res, 409, { error: 'Бэкап уже идёт' });
      const r = await runBackup();
      json(res, 200, r);
    } else if (url.pathname === '/api/backups/delete' && req.method === 'POST') {
      const b = await readBody(req);
      await deleteBackup(String(b.name || ''), String(b.where || 'local'));
      json(res, 200, { ok: true });
    } else if (url.pathname === '/api/backups/download') {
      const name = String(url.searchParams.get('name') || '').replace(/[^a-zA-Z0-9._-]/g, '');
      const where = url.searchParams.get('where') === 's3' ? 's3' : 'local';
      if (!name) return json(res, 400, { error: 'Имя файла' });
      if (where === 'local') {
        const filePath = `${LOCAL_BACKUPS}/${name}`;
        await readFile(filePath); // проверка существования
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"` });
        res.end(await readFile(filePath));
      } else {
        const data = await s3Request('GET', `${settings.s3.prefix || ''}${name}`, '', null, settings.s3);
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"` });
        res.end(data);
      }
    } else if (url.pathname === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.s3) {
        const next = { ...b.s3 };
        if (!next.secretKey) delete next.secretKey;
        delete next.hasSecret;
        if (next.endpoint && !/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(String(next.endpoint))) return json(res, 400, { error: 'S3 endpoint: нужен адрес вида https://storage.example.com' });
        settings.s3 = { ...settings.s3, ...next };
      }
      if (b.backup) settings.backup = { ...settings.backup, ...b.backup };
      await saveSettings();
      json(res, 200, { ok: true });
    } else if (url.pathname === '/api/files') {
      const rel = safePath(url.searchParams.get('p'));
      if (rel === null) return json(res, 400, { error: 'Недопустимый путь' });
      const { stat } = await import('node:fs/promises');
      const st = await stat(`${FILES_ROOT}/${rel}`).catch(() => null);
      if (!st) return json(res, 404, { error: 'Файл или папка не найдены' });
      if (st.isDirectory()) return json(res, 200, { path: rel, dir: true, entries: await collectFileList(rel) });
      if (st.size > 300 * 1024) return json(res, 400, { error: 'Файл больше 300 КБ, в браузере не редактируется' });
      json(res, 200, { path: rel, dir: false, size: st.size, content: await readFile(`${FILES_ROOT}/${rel}`, 'utf8') });
    } else if (url.pathname === '/api/files/save' && req.method === 'POST') {
      const b = await readBody(req);
      const rel = safePath(String(b.p || ''));
      if (!rel) return json(res, 400, { error: 'Путь вне корня' });
      const filePath = `${FILES_ROOT}/${rel}`;
      await readFile(filePath); // должен существовать
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      await writeFile(`${filePath}.bak-${stamp}`, await readFile(filePath, 'utf8')).catch(() => {});
      await writeFile(filePath, String(b.content ?? ''));
      json(res, 200, { ok: true });
    } else if (url.pathname === '/api/sites' && req.method === 'POST') {
      const b = await readBody(req);
      if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(String(b.name || ''))) return json(res, 400, { error: 'Имя: 3–40 символов a-z, 0-9, дефис' });
      if (!/^[a-z0-9._-]+\.[a-z]{2,}$/.test(String(b.domain || ''))) return json(res, 400, { error: 'Некорректный домен' });
      const p = String(b.preset || 'static');
      if (!PRESETS[p]) return json(res, 400, { error: `Предустановка: ${Object.keys(PRESETS).join(' | ')}` });
      const r = await createSite(String(b.name).toLowerCase(), String(b.domain).toLowerCase(), p);
      json(res, 200, { ok: true, admin: r.admin || undefined, db: r.db || undefined, note: r.note || undefined, ssh: r.ssh || undefined, url: r.url || undefined });
    } else {
      const m = url.pathname.match(/^\/api\/containers\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})\/(action|logs|scan|detail|exec|inspect|remove)$/);
      if (m) {
        const [, id, kind] = m;
        if (kind === 'action' && req.method === 'POST') {
          const b = await readBody(req);
          if (!['start', 'stop', 'restart', 'pause', 'unpause', 'kill'].includes(b.action)) return json(res, 400, { error: 'action: start|stop|restart|pause|unpause|kill' });
          await dockerRequest(`/containers/${id}/${b.action}`, { method: 'POST' });
          cache.at = 0;
          json(res, 200, { ok: true });
        } else if (kind === 'logs') {
          const lines = Math.min(Number(url.searchParams.get('lines')) || 400, 2000);
          const dl = url.searchParams.get('download') ? { 'Content-Disposition': `attachment; filename="logs-${id}.txt"` } : {};
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...dl });
          res.end(await containerLogs(id, lines));
        } else if (kind === 'inspect') {
          const r = await dockerRequest(`/containers/${id}/json`);
          if (r.status !== 200) return json(res, 404, { error: 'Контейнер не найден' });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="inspect-${id}.json"` });
          res.end(JSON.stringify(JSON.parse(r.body.toString('utf8')), null, 2));
        } else if (kind === 'remove' && req.method === 'POST') {
          const { data: d } = await dockerJson(`/containers/${id}/json`);
          if (!d) return json(res, 404, { error: 'Контейнер не найден' });
          if (d.Name === '/infra-panel') return json(res, 400, { error: 'Панель не может удалить сама себя' });
          const r = await dockerRequest(`/containers/${id}?force=1`, { method: 'DELETE' });
          if (r.status >= 400) return json(res, 500, { error: `не удалился: HTTP ${r.status}` });
          cache.at = 0;
          json(res, 200, { ok: true });
        } else if (kind === 'scan') {
          const text = await containerLogs(id, 300);
          const errors = (text.match(/error|fatal|Traceback/gi) || []).length;
          json(res, 200, { errors });
        } else if (kind === 'detail') {
          const { data: d } = await dockerJson(`/containers/${id}/json`);
          if (!d) return json(res, 404, { error: 'Контейнер не найден' });
          json(res, 200, {
            restartPolicy: d.HostConfig?.RestartPolicy?.Name,
            restartCount: d.RestartCount || 0,
            oomKilled: !!d.State?.OOMKilled,
            ip: d.NetworkSettings?.IPAddress,
            networks: Object.keys(d.NetworkSettings?.Networks || {}),
            networkMode: d.HostConfig?.NetworkMode,
            image: d.Config?.Image,
            cmd: (d.Config?.Cmd || []).join(' '),
            created: d.Created,
            started: d.State?.StartedAt,
            env: d.Config?.Env || [],
            mounts: (d.Mounts || []).map((x) => `${x.Source} → ${x.Destination}`),
          });
        } else if (kind === 'exec' && req.method === 'POST') {
          const b = await readBody(req);
          const cmd = String(b.cmd || '').slice(0, 500);
          if (!cmd.trim()) return json(res, 400, { error: 'Пустая команда' });
          const ex = await dockerJson(`/containers/${id}/exec`, { method: 'POST', body: { Attach: true, AttachStdout: true, AttachStderr: true, Cmd: ['sh', '-c', cmd] } });
          if (ex.status !== 201) return json(res, 500, { error: `exec: HTTP ${ex.status}` });
          const out = await dockerRequest(`/exec/${ex.data.Id}/start`, { method: 'POST', body: { Detach: false, Tty: false }, timeout: 30000 }).catch(() => null);
          json(res, 200, { output: out ? demux(out.body).toString('utf8').slice(0, 20000) : '' });
        }
      } else {
        json(res, 404, { error: 'Не найдено' });
      }
    }
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

async function deleteBackup(name, where) {
  if (where === 's3') {
    await s3Request('DELETE', `${settings.s3.prefix || ''}${name.replace(/[^a-zA-Z0-9._-]/g, '')}`, '', null, settings.s3);
  } else {
    const { unlink } = await import('node:fs/promises');
    await unlink(`${LOCAL_BACKUPS}/${name.replace(/[^a-zA-Z0-9._-]/g, '')}`);
  }
  await pruneBackups();
}

const LOGO_SVG = (id) => `<svg class="logo-mark" viewBox="0 0 48 48" aria-hidden="true"><defs>
<linearGradient id="${id}g" x1="8" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#a8e6c9"/><stop offset=".55" stop-color="#8ed1b0"/><stop offset="1" stop-color="#b4a7f5"/></linearGradient>
<linearGradient id="${id}b" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1c2a26"/><stop offset="1" stop-color="#1d1b2c"/></linearGradient></defs>
<rect x="1" y="1" width="46" height="46" rx="14" fill="url(#${id}b)"/>
<rect x="1.5" y="1.5" width="45" height="45" rx="13.5" fill="none" stroke="url(#${id}g)" stroke-opacity=".45"/>
<path d="M24 29.5 11 23l4.2-2.1L24 25.3l8.8-4.4L37 23z" fill="none" stroke="#b4a7f5" stroke-opacity=".55" stroke-width="1.6" stroke-linejoin="round" transform="translate(0 5)"/>
<path d="M24 29.5 11 23l4.2-2.1L24 25.3l8.8-4.4L37 23z" fill="none" stroke="url(#${id}g)" stroke-opacity=".85" stroke-width="1.6" stroke-linejoin="round"/>
<path d="M24 11 37 17.5 24 24 11 17.5z" fill="url(#${id}g)"/>
<path d="M24 11 37 17.5 24 24 11 17.5z" fill="none" stroke="#e3f4ea" stroke-opacity=".5" stroke-width=".8" stroke-linejoin="round"/>
<circle class="logo-pulse" cx="24" cy="17.5" r="2.3" fill="#13261d"/></svg>`;
const LOGO_FAVICON = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2048%2048%22%20aria-hidden%3D%22true%22%3E%3Cdefs%3E%0A%3ClinearGradient%20id%3D%22fg%22%20x1%3D%228%22%20y1%3D%226%22%20x2%3D%2240%22%20y2%3D%2242%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23a8e6c9%22%2F%3E%3Cstop%20offset%3D%22.55%22%20stop-color%3D%22%238ed1b0%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23b4a7f5%22%2F%3E%3C%2FlinearGradient%3E%0A%3ClinearGradient%20id%3D%22fb%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%2248%22%20y2%3D%2248%22%20gradientUnits%3D%22userSpaceOnUse%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%231c2a26%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%231d1b2c%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%0A%3Crect%20x%3D%221%22%20y%3D%221%22%20width%3D%2246%22%20height%3D%2246%22%20rx%3D%2214%22%20fill%3D%22url(%23fb)%22%2F%3E%0A%3Crect%20x%3D%221.5%22%20y%3D%221.5%22%20width%3D%2245%22%20height%3D%2245%22%20rx%3D%2213.5%22%20fill%3D%22none%22%20stroke%3D%22url(%23fg)%22%20stroke-opacity%3D%22.45%22%2F%3E%0A%3Cpath%20d%3D%22M24%2029.5%2011%2023l4.2-2.1L24%2025.3l8.8-4.4L37%2023z%22%20fill%3D%22none%22%20stroke%3D%22%23b4a7f5%22%20stroke-opacity%3D%22.55%22%20stroke-width%3D%221.6%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(0%205)%22%2F%3E%0A%3Cpath%20d%3D%22M24%2029.5%2011%2023l4.2-2.1L24%2025.3l8.8-4.4L37%2023z%22%20fill%3D%22none%22%20stroke%3D%22url(%23fg)%22%20stroke-opacity%3D%22.85%22%20stroke-width%3D%221.6%22%20stroke-linejoin%3D%22round%22%2F%3E%0A%3Cpath%20d%3D%22M24%2011%2037%2017.5%2024%2024%2011%2017.5z%22%20fill%3D%22url(%23fg)%22%2F%3E%0A%3Cpath%20d%3D%22M24%2011%2037%2017.5%2024%2024%2011%2017.5z%22%20fill%3D%22none%22%20stroke%3D%22%23e3f4ea%22%20stroke-opacity%3D%22.5%22%20stroke-width%3D%22.8%22%20stroke-linejoin%3D%22round%22%2F%3E%0A%3Ccircle%20cx%3D%2224%22%20cy%3D%2217.5%22%20r%3D%222.3%22%20fill%3D%22%2313261d%22%2F%3E%3C%2Fsvg%3E";
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">`;

const NEON_CSS = `
:root{--bg:#111318;--glass:rgba(236,234,228,.045);--glass2:rgba(236,234,228,.075);--edge:rgba(236,234,228,.09);--edge2:rgba(236,234,228,.05);
--txt:#eceae4;--mut:#9a9ca6;--acc:#8ed1b0;--acc2:#b4a7f5;--ok:#8ed1b0;--warn:#e9c27a;--red:#ee8f86;
--line:var(--edge);--line2:var(--edge2);--panel:var(--glass);--panel2:var(--glass2);
--mono:'JetBrains Mono',ui-monospace,Consolas,monospace;--sans:'Onest',system-ui,-apple-system,'Segoe UI',sans-serif;
--r-lg:22px;--r-md:14px;--r-sm:9px;--blur:blur(22px) saturate(160%);--ease:cubic-bezier(.22,1,.36,1)}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.55 var(--sans);min-height:100vh;-webkit-font-smoothing:antialiased;position:relative;overflow-x:hidden}
body::before,body::after{content:"";position:fixed;z-index:0;pointer-events:none;border-radius:50%;filter:blur(110px);opacity:.38}
body::before{width:62vw;height:62vw;left:-18vw;top:-24vw;background:radial-gradient(circle,#3f6f64 0%,#2d4756 45%,transparent 70%);animation:drift 38s ease-in-out infinite alternate}
body::after{width:55vw;height:55vw;right:-20vw;bottom:-25vw;background:radial-gradient(circle,#5a4a84 0%,#36564e 50%,transparent 72%);animation:drift 46s ease-in-out infinite alternate-reverse}
@keyframes drift{from{transform:translate(0,0) scale(1)}to{transform:translate(6vw,4vw) scale(1.12)}}
a{color:var(--acc);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3{font-weight:600}
.frame{position:relative;z-index:1}
.logo-mark{display:block;flex:none;filter:drop-shadow(0 8px 18px rgba(142,209,176,.28))}
.side .logo .logo-mark{width:40px;height:40px}
.login .logo-mark{width:56px;height:56px}
.logo-pulse{transform-origin:24px 17.5px;animation:lp 2.8s ease-in-out infinite}
@keyframes lp{50%{transform:scale(.55);opacity:.6}}
.side .logo:hover .logo-mark{filter:drop-shadow(0 8px 22px rgba(142,209,176,.45))}

.glass{background:var(--glass);border:1px solid var(--edge);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 20px 50px -20px rgba(0,0,0,.6)}
.pill{display:inline-block;padding:2px 9px;border-radius:99px;font:600 11px var(--sans)}
.b{background:rgba(142,209,176,.13);color:var(--ok)}
.g{background:rgba(138,151,173,.14);color:var(--mut)}
.o{background:rgba(233,194,122,.13);color:var(--warn)}
.r{background:rgba(238,143,134,.14);color:var(--red)}
.btn{border:1px solid var(--edge);background:var(--glass2);color:var(--txt);padding:6px 14px;border-radius:99px;cursor:pointer;font:500 12.5px var(--sans);transition:background .2s,border-color .2s,color .2s,transform .15s var(--ease)}
.btn:hover{background:rgba(236,234,228,.16);border-color:rgba(236,234,228,.28)}
.btn:active{transform:scale(.96)}
.btn:focus-visible,input:focus-visible,select:focus-visible,.side-nav button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.btn.warn:hover{border-color:var(--red);color:var(--red);background:rgba(238,143,134,.1)}
.btn.y{color:#13261d;border-color:transparent;background:linear-gradient(135deg,#8ed1b0,#9cc9e6);font-weight:600;box-shadow:0 6px 20px -6px rgba(142,209,176,.55)}
.btn.y:hover{filter:brightness(1.08);background:linear-gradient(135deg,#8ed1b0,#9cc9e6)}
.mono{font-family:var(--mono)}
input,select,textarea{background:rgba(10,11,14,.4);border:1px solid var(--edge);color:var(--txt);padding:9px 14px;border-radius:12px;font:inherit;width:260px;outline:none;transition:border-color .2s,box-shadow .2s}
input:focus,select:focus,textarea:focus{border-color:var(--acc);box-shadow:0 0 0 4px rgba(142,209,176,.14)}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(236,234,228,.14);border-radius:99px;border:3px solid transparent;background-clip:padding-box}
@keyframes rise{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
@keyframes grow{from{width:0}}
@keyframes pulse{0%{box-shadow:0 0 0 0 currentColor}70%{box-shadow:0 0 0 7px transparent}100%{box-shadow:0 0 0 0 transparent}}
.digit{font-variant-numeric:tabular-nums;font-family:var(--mono)}
.chip{display:inline-block;background:rgba(180,167,245,.1);border:1px solid rgba(180,167,245,.18);color:#d4ccfa;border-radius:99px;font:11px var(--mono);padding:1px 8px;margin:1px 3px 1px 0}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:1px}
.dot.on{background:var(--ok);color:rgba(142,209,176,.6);animation:pulse 2.4s infinite}
.dot.off{background:#4a4c55}
.dot.warn{background:var(--warn);color:rgba(233,194,122,.6);animation:pulse 2.4s infinite}
.dot.bad{background:var(--red);color:rgba(238,143,134,.6);animation:pulse 1.6s infinite}
.alert{display:flex;gap:10px;align-items:baseline;padding:10px 16px;border-radius:var(--r-md);font-size:13px;margin-bottom:8px;border:1px solid var(--edge);background:var(--glass);backdrop-filter:var(--blur)}
.alert.crit{background:rgba(238,143,134,.1);border-color:rgba(238,143,134,.3);color:#f6cfca}
.alert.warn{background:rgba(233,194,122,.08);border-color:rgba(233,194,122,.28);color:#f1dcae}
.evt{font-size:12px;color:var(--mut);padding:6px 0;border-bottom:1px solid var(--edge2);animation:rise .4s var(--ease) both}
.evt b{color:var(--acc2);font-weight:600}
.evt .bad{color:var(--red)}
.errb{display:inline-block;min-width:17px;text-align:center;background:rgba(238,143,134,.16);color:var(--red);border-radius:99px;font-size:10.5px;padding:0 7px;margin-left:6px;font-family:var(--mono)}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

const LOGIN_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Вход — Infra Panel</title><link rel="icon" href="${LOGO_FAVICON}">${FONTS}
<style>${NEON_CSS}
.login{width:min(380px,100%);border-radius:var(--r-lg);padding:36px 34px;animation:rise .6s var(--ease) both}
.login .mk{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(135deg,#8ed1b0,#b4a7f5);color:#13261d;font:700 15px var(--mono);box-shadow:0 10px 30px -8px rgba(142,209,176,.6)}
.login h1{font-size:22px;margin:18px 0 4px;letter-spacing:-.01em}
.login p{color:var(--mut);margin:0 0 22px;font-size:13.5px}
.login label{display:block;font-size:12.5px;color:var(--mut);margin:14px 0 6px}
.login button{width:100%;margin-top:24px;padding:12px;font-size:14px}
</style></head>
<body class="frame" style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px">
<form id="f" class="login glass">
${LOGO_SVG('l')}
<h1>Infra Panel</h1><p>Войдите, чтобы управлять контейнерами и сайтами сервера.</p>
<label for="u">Логин</label><input id="u" name="user" autocomplete="username" required style="width:100%">
<label for="p">Пароль</label><input id="p" name="password" type="password" autocomplete="current-password" required style="width:100%">
<button class="btn y">Войти</button>
<div id="err" style="color:var(--red);font-size:13px;margin-top:12px;min-height:16px"></div></form>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:f.get('user'),password:f.get('password')})});
if(r.ok)location.reload();else document.getElementById('err').textContent=(await r.json().catch(()=>({}))).error||'Неверный логин или пароль';}</script></body></html>`;

const APP_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Infra Panel</title><link rel="icon" href="${LOGO_FAVICON}">${FONTS}
<style>${NEON_CSS}
.shell{position:relative;z-index:1;display:grid;grid-template-columns:240px 1fr;min-height:100vh;gap:0}
.side{position:sticky;top:14px;margin:14px 0 14px 14px;height:calc(100vh - 28px);display:flex;flex-direction:column;gap:16px;border-radius:var(--r-lg);padding:18px 14px}
.side .logo{display:flex;align-items:center;gap:12px;padding:2px 6px 14px;border-bottom:1px solid var(--edge2)}
.side .logo .mk{width:36px;height:36px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,#8ed1b0,#b4a7f5);color:#13261d;font:700 13px var(--mono);box-shadow:0 8px 24px -8px rgba(142,209,176,.6)}
.side .logo h1{font-size:15px;margin:0;letter-spacing:-.01em}
.side .logo .sub{font-size:11.5px;color:var(--mut)}
.side-nav{display:flex;flex-direction:column;gap:3px}
.side-nav button{position:relative;border:0;background:transparent;color:var(--mut);padding:9px 14px;border-radius:12px;cursor:pointer;font:500 13.5px var(--sans);text-align:left;transition:color .2s,background .2s;width:100%}
.side-nav button:hover:not(.on){color:var(--txt);background:rgba(236,234,228,.06)}
.side-nav button.on{color:var(--txt);background:linear-gradient(90deg,rgba(142,209,176,.16),rgba(180,167,245,.06));box-shadow:inset 0 0 0 1px rgba(142,209,176,.22)}
.side-nav button.on::before{content:"";position:absolute;left:5px;top:50%;width:5px;height:5px;margin-top:-2.5px;border-radius:50%;background:var(--acc);box-shadow:0 0 10px var(--acc)}
.side-nav button.on{padding-left:20px}
.side-foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--edge2);padding-top:14px}
.brand{display:flex;align-items:center;gap:9px;padding:4px 6px 0;opacity:.7}
.brand .word{font:600 11px var(--sans);color:var(--mut)}
.main{min-width:0;padding:14px 14px 30px}
.topbar{position:sticky;top:14px;z-index:9;display:flex;align-items:center;gap:14px;padding:12px 22px;border-radius:var(--r-md);margin-bottom:16px}
.topbar .pt{font-size:18px;font-weight:600;letter-spacing:-.01em}
.topbar .hint{font:12px var(--mono);color:var(--mut)}
#out{max-width:1560px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:16px}
.card{position:relative;overflow:hidden;background:var(--glass);border:1px solid var(--edge);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border-radius:var(--r-md);padding:16px 18px 18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07);transition:transform .35s var(--ease),border-color .3s}
.card::after{content:"";position:absolute;inset:auto -30% -60% auto;width:140px;height:140px;border-radius:50%;background:radial-gradient(circle,var(--glow,rgba(142,209,176,.22)),transparent 70%);pointer-events:none}
.card.warn{--glow:rgba(233,194,122,.22)}.card.bad{--glow:rgba(238,143,134,.25)}
.card:hover{transform:translateY(-2px);border-color:rgba(236,234,228,.24)}
.card .k{font-size:12.5px;color:var(--mut)}
.card .v{font:600 30px/1.15 var(--mono);margin-top:6px;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.card .v .sm{font-size:15px;letter-spacing:0}
.card .s{font-size:12px;color:var(--mut);margin-top:4px}
.card .track{height:6px;background:rgba(236,234,228,.08);border-radius:99px;margin-top:14px;overflow:hidden}
.card .track i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#7cc4a2,#9cc9e6);box-shadow:0 0 12px rgba(142,209,176,.5);transition:width 1s var(--ease)}
.card.warn .v{color:var(--warn)}.card.warn .track i{background:linear-gradient(90deg,#d9a85c,#e9c27a);box-shadow:0 0 12px rgba(233,194,122,.45)}
.card.bad .v{color:var(--red)}.card.bad .track i{background:linear-gradient(90deg,#d9766d,#ee8f86);box-shadow:0 0 12px rgba(238,143,134,.5)}
.hero{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;border-radius:var(--r-lg);padding:26px 30px;margin-bottom:16px;background:linear-gradient(120deg,rgba(142,209,176,.14),rgba(180,167,245,.08) 55%,rgba(236,234,228,.05));border:1px solid rgba(142,209,176,.22);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur)}
.hero.warn{background:linear-gradient(120deg,rgba(233,194,122,.14),rgba(236,234,228,.05));border-color:rgba(233,194,122,.28)}
.hero.crit{background:linear-gradient(120deg,rgba(238,143,134,.16),rgba(236,234,228,.05));border-color:rgba(238,143,134,.32)}
.hero .hl{display:flex;align-items:center;gap:20px;min-width:0}
.hero .orb{flex:none;width:58px;height:58px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#e3f4ea,#7cc4a2 45%,#4b8a70);box-shadow:0 0 40px rgba(142,209,176,.55);animation:breathe 4s ease-in-out infinite}
.hero.warn .orb{background:radial-gradient(circle at 35% 30%,#f7ead0,#e9c27a 45%,#a77d3c);box-shadow:0 0 40px rgba(233,194,122,.5)}
.hero.crit .orb{background:radial-gradient(circle at 35% 30%,#fbe3e0,#ee8f86 45%,#a85750);box-shadow:0 0 40px rgba(238,143,134,.55);animation-duration:1.8s}
@keyframes breathe{50%{transform:scale(1.08);filter:brightness(1.15)}}
.hero .state{font-size:28px;font-weight:700;letter-spacing:-.02em;line-height:1.1}
.hero .s{color:var(--mut);font-size:13.5px;margin-top:4px}
.hero .hr{text-align:right;font-size:12.5px;color:var(--mut);line-height:1.7}
.hero .hr b{color:var(--txt);font-weight:600}
.grid2{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px}
@media(max-width:1100px){.grid2{grid-template-columns:1fr}}
.panelbox{background:var(--glass);border:1px solid var(--edge);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border-radius:var(--r-lg);padding:18px 20px;margin-bottom:16px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.panelbox h3{margin:0 0 14px;font-size:14px;font-weight:600;color:var(--txt)}
canvas.chart{width:100%;height:190px;display:block}
.gauges{display:flex;gap:10px;justify-content:space-around}
.gauges canvas{width:46%;max-width:170px}
table{width:100%;border-collapse:collapse}
th{text-align:left;color:var(--mut);font:500 12px var(--sans);padding:8px 10px;border-bottom:1px solid var(--edge)}
td{padding:9px 10px;border-bottom:1px solid var(--edge2);vertical-align:middle}
tr{transition:background .2s}
tr:hover td{background:rgba(236,234,228,.04)}
.bar{height:6px;background:rgba(236,234,228,.08);border-radius:99px;position:relative;min-width:80px;overflow:hidden;margin-bottom:3px}
.bar i{position:absolute;inset:0 auto 0 0;background:var(--ok);border-radius:99px;transition:width 1s var(--ease)}
.bar.mem i{background:linear-gradient(90deg,#a397ec,#b4a7f5)}
.spark{width:110px;height:28px}
.sites{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.site{background:var(--glass);border:1px solid var(--edge);backdrop-filter:var(--blur);-webkit-backdrop-filter:var(--blur);border-radius:var(--r-md);padding:14px 16px;transition:transform .35s var(--ease),border-color .3s}
.site:hover{transform:translateY(-2px);border-color:rgba(236,234,228,.24)}
.site .d{font-size:13.5px;font-weight:600;word-break:break-all}
.site .m{font-size:11.5px;color:var(--mut);margin-top:4px;font-family:var(--mono)}
.site .lat{height:5px;background:rgba(236,234,228,.08);border-radius:99px;margin-top:10px;overflow:hidden}
.site .lat i{display:block;height:100%;border-radius:99px;transition:width 1s var(--ease)}
#out.intro .card,#out.intro .panelbox,#out.intro .hero,#out.intro .site,#out.intro .alert{animation:rise .7s var(--ease) both}
#out.intro .cards>*:nth-child(2){animation-delay:.06s}#out.intro .cards>*:nth-child(3){animation-delay:.12s}#out.intro .cards>*:nth-child(4){animation-delay:.18s}#out.intro .cards>*:nth-child(5){animation-delay:.24s}#out.intro .cards>*:nth-child(6){animation-delay:.3s}
#out.intro .grid2 .panelbox{animation-delay:.3s}
#out.intro .track i,#out.intro .bar i,#out.intro .lat i{animation:grow 1.2s var(--ease) .25s both}
.overlay-panel{background:rgba(24,26,32,.8);border:1px solid var(--edge);backdrop-filter:blur(28px) saturate(170%);-webkit-backdrop-filter:blur(28px) saturate(170%);box-shadow:0 30px 80px rgba(0,0,0,.6)}
#logbox{position:fixed;inset:5vh 5vw;border-radius:var(--r-lg);padding:0;display:none;z-index:60;flex-direction:column;font-size:12.5px;overflow:hidden}
#logbox.show{display:flex;animation:rise .35s var(--ease) both}
#logbox header,#detail header{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--edge)}
#logbox h3,#detail h3{margin:0;font-size:14px;font-weight:600}
#logs{flex:1;overflow:auto;padding:14px 18px;color:#c4c3bd;font-family:var(--mono);white-space:pre-wrap;word-break:break-all;background:rgba(3,5,10,.5)}
#logs .err{color:#f2b0a9}
#logs .sys{color:var(--mut);font-family:var(--sans)}
#detail{position:fixed;top:12px;right:12px;bottom:12px;width:min(660px,94vw);border-radius:var(--r-lg);padding:0;display:flex;flex-direction:column;font-size:13px;z-index:55;transform:translateX(110%);transition:transform .45s var(--ease);overflow:hidden}
#detail.show{transform:none}
#detail #dbody{flex:1;overflow:auto;padding:16px 18px}
#msg{margin:12px 0;font-size:13px;min-height:18px}.ok{color:var(--ok)}.bad{color:var(--red)}
form#create{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px}
form#create label{display:block;font-size:12.5px;color:var(--mut);margin-bottom:6px}
.sm{color:var(--mut);font-size:12.5px}
.desc{color:var(--mut);font-size:12px;margin-top:2px;max-width:340px}
#alerts{margin-bottom:16px}
@media(max-width:900px){.shell{grid-template-columns:1fr}.side{position:static;height:auto;margin:12px 12px 0;flex-direction:row;flex-wrap:wrap;align-items:center;gap:10px;padding:12px}.side .logo{border:0;padding:0}.side-nav{flex-direction:row;flex-wrap:wrap}.side-nav button{width:auto}.side-foot{margin-left:auto;border:0;padding:0}.brand{display:none}.main{padding:12px}.topbar{top:8px}.hero{padding:20px}.hero .hr{text-align:left}}
.side-nav button{display:flex;align-items:center;gap:11px}
.side-nav svg{width:17px;height:17px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;opacity:.8}
.side-nav button.on svg{color:var(--acc);opacity:1}
.side-nav button.on{padding-left:14px}
.side-nav button.on::before{display:none}
.tstat{display:flex;gap:8px}
.tstat span{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:99px;background:var(--glass2);border:1px solid var(--edge2);font:500 12px var(--mono);color:var(--txt)}
.tstat i{width:6px;height:6px;border-radius:50%;background:var(--c,var(--acc))}
.hero .hr{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;text-align:left}
.hero .hr span{padding:7px 13px;border-radius:12px;background:rgba(10,11,14,.25);border:1px solid var(--edge2);font-size:12px;color:var(--mut);line-height:1.35}
.hero .hr span b{display:block;color:var(--txt);font:600 13.5px var(--mono)}
.hero .orb{width:46px;height:46px}
.chart-empty{display:grid;place-items:center;height:190px;color:var(--mut);font-size:13px}
@media(max-width:900px){.side-nav svg{display:none}.hero .hr{justify-content:flex-start}}
.kebab{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:11px;border:1px solid var(--edge);background:var(--glass2);color:var(--mut);cursor:pointer;transition:background .2s,color .2s,border-color .2s,transform .15s var(--ease)}
.kebab svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
.kebab:hover,.kebab.open{color:var(--txt);background:rgba(236,234,228,.12);border-color:rgba(236,234,228,.2)}
.kebab:active{transform:scale(.94)}
.kebab:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
td.acts,.acts{text-align:right;white-space:nowrap}
.acts .btn{margin-right:8px;vertical-align:middle}
.sm-btn{padding:6px 12px}
#menu{position:fixed;z-index:100;min-width:248px;padding:6px;border-radius:16px;background:rgba(28,30,37,.86);border:1px solid var(--edge);backdrop-filter:blur(26px) saturate(170%);-webkit-backdrop-filter:blur(26px) saturate(170%);box-shadow:0 24px 60px -12px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.06);animation:pop .18s var(--ease) both;transform-origin:top right}
@keyframes pop{from{opacity:0;transform:scale(.94) translateY(-4px)}}
#menu .mh{padding:8px 12px 6px;font:600 12px var(--mono);color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
#menu hr{border:0;border-top:1px solid var(--edge2);margin:5px 6px}
#menu button{display:flex;align-items:center;gap:11px;width:100%;padding:8px 12px;border:0;border-radius:10px;background:transparent;color:var(--txt);font:500 13px var(--sans);text-align:left;cursor:pointer}
#menu button svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;color:var(--mut)}
#menu button:hover,#menu button:focus{background:rgba(236,234,228,.08);outline:none}
#menu button:hover svg,#menu button:focus svg{color:var(--acc)}
#menu button.danger{color:var(--red)}#menu button.danger svg{color:var(--red)}
#menu button.danger:hover{background:rgba(238,143,134,.12)}
#toast{position:fixed;left:50%;bottom:24px;z-index:120;transform:translate(-50%,20px);opacity:0;pointer-events:none;padding:11px 18px;border-radius:14px;background:rgba(28,30,37,.9);border:1px solid var(--edge);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);font-size:13.5px;box-shadow:0 18px 40px -10px rgba(0,0,0,.6);transition:opacity .25s,transform .35s var(--ease)}
#toast.show{opacity:1;transform:translate(-50%,0)}
#toast.bad{border-color:rgba(238,143,134,.4);color:#f6cfca}
.ph{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}.ph h3{margin:0}
.legend{display:flex;gap:14px;font-size:12px;color:var(--mut)}.legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.latlist{display:flex;flex-direction:column;gap:4px}
.lrow{display:grid;grid-template-columns:minmax(120px,220px) 1fr 92px;align-items:center;gap:16px;padding:9px 12px;border-radius:12px;transition:background .2s}
.lrow:hover{background:rgba(236,234,228,.04)}
.lrow .ld{color:var(--txt);font-weight:500;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lt{height:8px;border-radius:99px;background:rgba(236,234,228,.06);overflow:hidden}
.lt i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,rgba(142,209,176,.35),var(--ok));transition:width 1s var(--ease)}
.lrow.slow .lt i{background:linear-gradient(90deg,rgba(233,194,122,.35),var(--warn))}
.lrow.bad .lt i{background:repeating-linear-gradient(135deg,rgba(238,143,134,.5) 0 6px,rgba(238,143,134,.25) 6px 12px)}
.lrow .lv{text-align:right;font:600 13px var(--mono);color:var(--ok)}
.lrow.slow .lv{color:var(--warn)}.lrow.bad .lv{color:var(--red);font-family:var(--sans);font-weight:500}
#out.intro .lt i{animation:grow 1.2s var(--ease) .25s both}
.site .upt{display:flex;justify-content:space-between;margin-top:12px;padding-top:10px;border-top:1px solid var(--edge2);font-size:12px;color:var(--mut)}.site .upt b{color:var(--txt);font:600 12.5px var(--mono)}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.seg{display:inline-flex;padding:3px;border-radius:12px;background:rgba(10,11,14,.35);border:1px solid var(--edge2)}
.seg button{border:0;background:transparent;color:var(--mut);padding:6px 12px;border-radius:9px;font:500 12.5px var(--sans);cursor:pointer;transition:background .2s,color .2s}
.seg button b{font:600 11.5px var(--mono);margin-left:4px;opacity:.75}
.seg button.on{background:rgba(236,234,228,.1);color:var(--txt)}
.pullform{display:flex;align-items:center;gap:10px;padding:8px 8px 8px 14px;border-radius:14px;border:1px dashed var(--edge);margin-bottom:10px}
.pullform svg{width:17px;height:17px;flex:none;fill:none;stroke:var(--mut);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.pullform input{flex:1;width:auto;border:0;background:transparent;padding:6px 0;box-shadow:none}
.imglist{display:flex;flex-direction:column}
.irow{display:grid;grid-template-columns:minmax(200px,1.6fr) minmax(140px,1fr) 150px 48px;align-items:center;gap:18px;padding:12px;border-bottom:1px solid var(--edge2);border-radius:12px;transition:background .2s}
.irow:hover{background:rgba(236,234,228,.035)}
.iname b{font-weight:600}
.iname .tag{margin-left:8px;padding:1px 8px;border-radius:99px;background:rgba(180,167,245,.13);color:#d4ccfa;font-size:11.5px}
.iname .sm{margin-top:3px}
.isize{display:grid;grid-template-columns:1fr 64px;align-items:center;gap:10px}.isize .digit{text-align:right;font-size:12.5px}
.isize .lt i{background:linear-gradient(90deg,rgba(180,167,245,.35),var(--acc2))}
@media(max-width:800px){.irow{grid-template-columns:1fr 48px}.irow .isize,.irow>div:nth-child(3){grid-column:1}.lrow{grid-template-columns:1fr 80px}.lrow .lt{grid-column:1/-1;order:3}}
.newsite{display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start}
.newsite .summary{position:sticky;top:96px}
@media(max-width:1100px){.newsite{grid-template-columns:1fr}.newsite .summary{position:static}}
.presets{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.preset{display:flex;flex-direction:column;align-items:flex-start;gap:6px;text-align:left;padding:16px;border-radius:16px;border:1px solid var(--edge2);background:rgba(236,234,228,.025);color:var(--txt);font:inherit;cursor:pointer;transition:border-color .25s,background .25s,transform .3s var(--ease)}
.preset:hover{border-color:var(--edge);background:rgba(236,234,228,.05);transform:translateY(-2px)}
.preset.on{border-color:rgba(142,209,176,.55);background:linear-gradient(160deg,rgba(142,209,176,.12),rgba(236,234,228,.03));box-shadow:0 0 0 1px rgba(142,209,176,.25),0 14px 30px -14px rgba(142,209,176,.35)}
.preset:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.pm{display:inline-grid;place-items:center;min-width:38px;height:38px;padding:0 8px;border-radius:12px;font:700 12.5px var(--mono);color:var(--pc);background:color-mix(in srgb,var(--pc) 14%,transparent);border:1px solid color-mix(in srgb,var(--pc) 30%,transparent)}
.preset .pt{font-weight:600;font-size:14.5px;margin-top:4px}
.preset .pd{font-size:12.5px;color:var(--mut);line-height:1.45}
.preset .pf{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;padding-top:8px}
.preset .pf span{font-size:11px;padding:2px 8px;border-radius:99px;background:rgba(236,234,228,.06);color:var(--mut)}
.nsform{display:grid;grid-template-columns:1fr 1fr auto;gap:16px;align-items:start}
@media(max-width:800px){.nsform{grid-template-columns:1fr}}
.fld label{display:block;font-size:12.5px;color:var(--mut);margin-bottom:6px}
.fld input{width:100%}
.fh{font-size:12px;margin-top:6px;min-height:17px;color:var(--mut)}
.fh.bad{color:var(--red)}.fh.okh{color:var(--mut)}
.btn.big{padding:11px 22px;font-size:14px;margin-top:23px}
.btn:disabled{opacity:.45;cursor:not-allowed;filter:grayscale(.4);box-shadow:none}
.summary .sp{display:flex;gap:12px;align-items:center;margin-bottom:14px}
.summary dl{display:grid;grid-template-columns:auto 1fr;gap:8px 14px;margin:0 0 14px;font-size:12.5px}
.summary dt{color:var(--mut)}.summary dd{margin:0;word-break:break-all;font-size:12px}
.summary .meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.summary .meta div{padding:10px 12px;border-radius:12px;background:rgba(10,11,14,.3);border:1px solid var(--edge2)}
.summary .meta span{display:block;font-size:11.5px;color:var(--mut)}.summary .meta b{font:600 14px var(--mono)}
.steps{list-style:none;counter-reset:st;margin:0 0 12px;padding:0;display:flex;flex-direction:column;gap:8px}
.steps li{counter-increment:st;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--mut)}
.steps li::before{content:counter(st);display:grid;place-items:center;width:22px;height:22px;border-radius:50%;border:1px solid var(--edge);font:600 11px var(--mono);flex:none}
.steps li.done{color:var(--txt)}.steps li.done::before{content:"✓";background:rgba(142,209,176,.18);border-color:rgba(142,209,176,.5);color:var(--ok)}
#msg:empty{display:none}
#msg{margin-top:14px;padding:12px 14px;border-radius:12px;background:rgba(10,11,14,.3);border:1px solid var(--edge2)}
.panelbox{overflow-x:auto}
.panelbox>table{min-width:560px}
.seg{flex-wrap:wrap;max-width:100%}
@media(max-width:600px){.main{padding:10px}.panelbox{padding:16px 14px;border-radius:18px}.topbar{padding:10px 14px}.topbar .pt{font-size:16px}.tstat span:last-child{display:none}.cards{grid-template-columns:1fr 1fr;gap:10px}.card .v{font-size:24px}.hero{padding:18px}.hero .state{font-size:22px}.presets{grid-template-columns:1fr}}
</style></head>
<body>
<div class="shell">
<aside class="side glass"><div class="logo">${LOGO_SVG('s')}<div><h1>Infra Panel</h1><div class="sub">Сервер и сайты</div></div></div><nav class="tabs side-nav">
<button class="on" data-t="o"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>Обзор</button><button data-t="c"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>Контейнеры</button><button data-t="s"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/></svg>Сайты</button><button data-t="i"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>Образы</button><button data-t="v"><svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"/></svg>Тома</button><button data-t="w"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="m8.2 10.9 7.6-3.8M8.2 13.1l7.6 3.8"/></svg>Сети</button><button data-t="b"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/></svg>Бэкапы</button><button data-t="f"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>Файлы</button><button data-t="n"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>Новый сайт</button></nav>
<div class="side-foot"><span id="clock" class="sm digit"></span><button class="btn" onclick="logout()">Выйти</button></div>
<div class="brand" title="AK Systems"><svg width="20" height="20" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 4H40V36l-4 4H4V8z" fill="none" stroke="#eceae4" stroke-width="2"/><path d="M13 9H35V33l-3 3H9V13z" fill="none" stroke="#ee8f86" stroke-width="2.5"/><text x="12" y="30" fill="#eceae4" font-family="Arial,sans-serif" font-size="15" font-weight="700" letter-spacing="-1">AK</text></svg><span class="word">AK Systems</span></div></aside>
<main class="main"><div class="topbar glass"><span class="pt" id="pagetitle">Обзор</span><span style="flex:1"></span><span class="tstat" id="topstat"></span></div>
<div id="out" class="intro"></div></main>
</div>
<div id="logbox" class="overlay-panel"><header><h3 id="logtitle"></h3><input id="logfilter" placeholder="Поиск по логу" oninput="logFilter=this.value;refreshLogs()" style="width:200px;padding:6px 12px;font-size:12.5px"><span style="flex:1"></span><button class="btn" onclick="toggleAuto()" id="autobtn">Авто: вкл</button><button class="btn" onclick="refreshLogs()">Обновить</button><button class="btn" onclick="closeLogs()">Закрыть</button></header><div id="logs"></div></div>
<div id="detail" class="overlay-panel"><header><h3 id="dtitle"></h3><span style="flex:1"></span><button class="btn" onclick="closeDetail()">Закрыть</button></header><div id="dbody"></div></div>
<script src="/app.js"></script></body></html>`;

/* ---------- старт ---------- */

await loadHistory();
await loadSettings();
await mkdir(LOCAL_BACKUPS, { recursive: true }).catch(() => {});
await sampleOnce();
setInterval(sampleOnce, 30_000);
setInterval(saveHistory, 300_000);
process.on('SIGTERM', () => saveHistory().finally(() => process.exit(0)));

server.listen(PORT, () => console.log(`Infra Panel :${PORT} (user: ${ADMIN_USER})`));
