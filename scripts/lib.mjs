// Shared helpers for the courseware sync scripts.
//
// All site-specific values (hosts, ports, paths, session code) come from
// site.json, so this file stays generic. The browser's debugging port changes on
// every launch and is therefore read from DevToolsActivePort rather than fixed.

import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { request } from 'node:http';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const VIDEO_EXT = new Set(['mp4', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'webm',
  'm4v', 'mpg', 'mpeg', '3gp']);

export function readJson(path, fallback = null) {
  if (!existsSync(path)) {
    if (fallback !== null) return fallback;
    throw new Error(`文件不存在: ${path}`);
  }
  // PowerShell's Set-Content -Encoding UTF8 writes a BOM, which JSON.parse
  // rejects; strip it so files edited by either toolchain stay readable.
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

export function loadSite(configDir, override = null) {
  const path = override && isAbsolute(override) ? override : join(configDir, 'site.json');
  const site = readJson(path);

  const { scheme = 'http', host, port } = site.platform ?? {};
  if (!host) throw new Error('site.json 缺少 platform.host');

  const platformBase = `${scheme}://${host}${port ? `:${port}` : ''}`;
  const fileBase = site.fileServer?.host
    ? `${site.fileServer.scheme ?? 'http'}://${site.fileServer.host}`
      + `${site.fileServer.port ? `:${site.fileServer.port}` : ''}`
    : '';

  const paths = site.paths ?? {};
  return {
    ...site,
    platformBase,
    fileBase,
    coursewareUrl: `${platformBase}${paths.coursePlatform ?? '/ve/back/coursePlatform/coursePlatform.shtml'}`,
    listPath: paths.courseResource ?? '/ve/back/coursePlatform/courseResource.shtml',
    resourcePath: paths.resourceSpace ?? '/ve/back/resourceSpace.shtml',
    docType: site.docType ?? '1',
  };
}

export function browserProfile(site) {
  const p = site.browser?.profile || process.env.DSH_EDGE_PROFILE;
  if (!p) {
    throw new Error('site.json 缺少 browser.profile，或设置环境变量 DSH_EDGE_PROFILE');
  }
  return p;
}

export function resolvePort(profile) {
  const file = join(profile, 'DevToolsActivePort');
  if (!existsSync(file)) {
    throw new Error(`DevToolsActivePort 不存在: ${file}\n托管浏览器没有在运行，先启动它。`);
  }
  const port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port <= 0) throw new Error('DevToolsActivePort 内容无效');
  return port;
}

export function httpJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', () => reject(new Error('ws error')));
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
      }, 90000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    }
    return r.result?.value;
  }

  close() { try { this.ws.close(); } catch {} }
}

// Attach to the course-platform tab, preferring one already on the platform host.
export async function connect(port, targetIdArg, site) {
  const targets = await httpJson(port, '/json/list');
  const pages = targets.filter((t) => t.type === 'page');
  const wantHost = site?.platform?.host;
  const page = (targetIdArg && pages.find((t) => t.id === targetIdArg))
    ?? (wantHost ? pages.find((t) => t.url.includes(wantHost)) : null)
    ?? pages[0];
  if (!page) throw new Error('没有可用的浏览器标签页');
  await httpJson(port, `/json/activate/${page.id}`).catch(() => null);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  return cdp;
}

// Open a course's courseware page, rebuilding the session when it has expired.
// Returns true only when the page is really showing the courseware tab.
export async function openCourseware(cdp, site, course) {
  const url = `${site.coursewareUrl}?method=toCoursePlatform&courseToPage=10450`
    + `&courseId=${encodeURIComponent(course.code)}&dataSource=1`
    + `&cId=${encodeURIComponent(course.cid)}`
    + `&xkhId=${encodeURIComponent(course.xkh)}`
    + `&xqCode=${encodeURIComponent(site.xqCode)}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await cdp.send('Page.navigate', { url: site.jumpUrl });
    await sleep(1800);
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 22; i += 1) {
      await sleep(400);
      const ok = await cdp.eval('document.body.innerText.includes("课程资源")'
        + ' && location.href.includes("courseToPage=10450")').catch(() => false);
      if (ok) return true;
    }
  }
  return false;
}

// All chapter nodes of the courseware tree; a flat course yields just the root.
export async function readTree(cdp) {
  return cdp.eval(`(() => {
    try {
      const t = jQuery.fn.zTree.getZTreeObj('treeDemo');
      if (!t) return [{ name: 'root', id: '0' }];
      const flat = [];
      (function w(list) {
        for (const n of list) {
          flat.push({ name: n.name, id: String(n.id) });
          if (n.children) w(n.children);
        }
      })(t.getNodes());
      return flat.length ? flat : [{ name: 'root', id: '0' }];
    } catch { return [{ name: 'root', id: '0' }]; }
  })()`);
}

// Select a chapter node so its rows render. Returns false when it is not found.
export async function selectFolder(cdp, folderName) {
  return cdp.eval(`(() => {
    const t = jQuery.fn.zTree.getZTreeObj('treeDemo');
    if (!t) return false;
    const want = ${JSON.stringify(folderName)};
    const find = (list) => {
      for (const n of list) {
        if ((n.name || '') === want) return n;
        if (n.children) { const h = find(n.children); if (h) return h; }
      }
      return null;
    };
    const node = find(t.getNodes());
    if (!node) return false;
    t.selectNode(node, false, true);
    const a = document.getElementById(node.tId + '_a');
    if (a) a.click();
    return true;
  })()`);
}

// File rows of the currently selected folder: display name plus rpId.
export async function readRows(cdp) {
  return cdp.eval(`(() => Array.from(document.querySelectorAll('li'))
    .filter((el) => (el.getAttribute('onclick') || '').includes('goDetail'))
    .map((el) => ({
      name: (el.getAttribute('title') || el.innerText || '').trim(),
      rpId: (el.getAttribute('onclick') || '').match(/goDetail\\('([^']+)'/)?.[1],
    }))
    .filter((x) => x.name))()`);
}

// One node's resource list via the platform API; null means the response was not JSON.
export async function listNode(cdp, site, course, upId) {
  const qs = new URLSearchParams({
    method: 'stuQueryUploadResourceForCourseList',
    courseId: course.code, cId: course.code, xkhId: course.xkh,
    xqCode: site.xqCode, docType: site.docType, up_id: upId, searchName: '',
  }).toString();
  const raw = await cdp.eval(`fetch(${JSON.stringify(site.listPath + '?' + qs)},
    { credentials: 'include' }).then((r) => r.text())`).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
