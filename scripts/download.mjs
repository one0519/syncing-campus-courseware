// Download the planned documents into the staging directory.
//
// Two paths, chosen by the platform's own permission flag:
//   stu_download=2 -> rpinfoDownloadUrl gives rpUrl; fetch it directly.
//   stu_download=1 -> preview-only. download.shtml answers HTTP 500 for these,
//                     so the real file is reached through the viewer iframe:
//                     select chapter -> click row -> read #pdfIframe.src ->
//                     decode the base64 url= param -> GET the file-server path.
//
// Usage: node download.mjs <configDir> [workDir] [stagingDir]

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import {
  loadSite, browserProfile, resolvePort, connect, openCourseware,
  selectFolder, readJson, sleep,
} from './lib.mjs';

const configDir = process.argv[2];
if (!configDir) {
  console.error('usage: node download.mjs <configDir> [workDir] [stagingDir]');
  process.exit(2);
}
const workDir = process.argv[3] || join(configDir, 'work');
// Absolute paths keep the record usable no matter where land.mjs is run from.
const stagingDir = resolve(process.argv[4] || join(workDir, 'staging'));

const site = loadSite(configDir);
const plan = readJson(join(workDir, 'plan.json'));
const urlCache = readJson(join(configDir, 'preview_realurl.json'), {});

mkdirSync(stagingDir, { recursive: true });
if (!plan.items.length) {
  console.log('今日无新增，无需下载');
  process.exit(0);
}

const port = resolvePort(browserProfile(site));
const cdp = await connect(port, null, site);

function safeName(name, ext) {
  return `${name}${ext ? `.${ext}` : ''}`.replace(/[\\/:*?"<>|]/g, '_');
}

async function fetchBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadDirect(item) {
  const resolved = await cdp.eval(`(async () => {
    const r = await fetch(${JSON.stringify(site.resourcePath)}
      + '?method=rpinfoDownloadUrl&rpId=' + ${JSON.stringify(item.rpId)},
      { method: 'POST', credentials: 'include' });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { notJson: true }; }
  })()`);
  if (resolved?.notJson) throw new Error('会话失效');
  if (!resolved?.rpUrl) throw new Error('未取得下载地址');
  return fetchBytes(resolved.rpUrl);
}

async function downloadPreview(item) {
  // A cached real URL skips the viewer entirely.
  const cached = urlCache[item.rpId];
  if (cached) {
    try { return { buf: await fetchBytes(cached), real: cached }; }
    catch { /* stale cache: fall through to re-resolve */ }
  }

  if (!await openCourseware(cdp, site, { code: item.code, cid: item.cid, xkh: item.xkh })) {
    throw new Error('课件页未就绪');
  }
  if (item.folder && !await selectFolder(cdp, item.folder)) {
    throw new Error(`目录未找到: ${item.folder}`);
  }
  // Rows render asynchronously; reading in the same tick finds nothing.
  await sleep(2600);

  const clicked = await cdp.eval(`(() => {
    const rpId = ${JSON.stringify(item.rpId)};
    const li = Array.from(document.querySelectorAll('li'))
      .find((el) => (el.getAttribute('onclick') || '').includes(rpId));
    if (!li) return false;
    li.click();
    return true;
  })()`);
  if (!clicked) throw new Error('文件行未找到');
  await sleep(4200);

  const real = await cdp.eval(`(() => {
    const f = document.getElementById('pdfIframe')
      || Array.from(document.querySelectorAll('iframe'))
        .find((x) => (x.src || '').includes('onlinePreview'));
    if (!f || !f.src) return null;
    const m = f.src.match(/[?&]url=([^&]+)/);
    if (!m) return null;
    try {
      const u = atob(decodeURIComponent(m[1]));
      return /^https?:\\/\\//.test(u) ? u : null;
    } catch { return null; }
  })()`);
  if (!real) throw new Error('未解析出预览直链');

  return { buf: await fetchBytes(real), real };
}

const results = [];

for (const item of plan.items) {
  try {
    let buf;
    let real = null;

    if (Number(item.stuDownload) === 1) {
      const got = await downloadPreview(item);
      buf = got.buf;
      real = got.real;
    } else {
      buf = await downloadDirect(item);
    }

    if (!buf?.length) throw new Error('取到 0 字节');

    // Extension comes from the resolved path when the platform omits it, and an
    // office file served as a converted PDF must be named .pdf to stay openable.
    let ext = item.ext || '';
    const realExt = real ? (real.match(/\.([a-z0-9]{2,5})(?:\?|$)/i) || [])[1]?.toLowerCase() : '';
    if (/\/swf\//.test(real ?? '') && realExt) ext = realExt;
    if (!ext) {
      const head = buf.subarray(0, 4).toString('hex');
      ext = head.startsWith('25504446') ? 'pdf'
        : head.startsWith('504b0304') ? 'zip'
          : head.startsWith('d0cf11e0') ? 'doc' : (realExt || '');
    }

    const target = join(stagingDir, item.courseFolder, item.folder, safeName(item.name, ext));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf);

    results.push({ ...item, ok: true, ext, bytes: buf.length, real, path: target });
    console.error(`  成功: ${item.name}.${ext} (${(buf.length / 1024).toFixed(0)} KB)`);
    await sleep(200);
  } catch (error) {
    results.push({ ...item, ok: false, error: String(error.message || error) });
    console.error(`  失败: ${item.name}: ${error.message || error}`);
  }
}

cdp.close();

writeFileSync(join(workDir, 'download.json'), JSON.stringify(results, null, 2), 'utf8');

// Refresh the preview URL cache so the next run can skip resolution.
const cachePath = join(configDir, 'preview_realurl.json');
const merged = { ...urlCache };
for (const r of results) if (r.ok && r.real) merged[r.rpId] = r.real;
writeFileSync(cachePath, JSON.stringify(merged, null, 2), 'utf8');

const ok = results.filter((r) => r.ok).length;
console.error(`\n下载完成: ${ok}/${results.length}`);
if (ok !== results.length) process.exitCode = 1;
