// Scan every enrolled course for new courseware documents.
//
// Each course is opened on its courseware page first: the list API only answers
// inside that page context, and from the course index it returns the platform's
// "会话结束" HTML, which would otherwise read as "this course has no files".
//
// Usage: node scan.mjs <configDir> [workDir] [sitePath]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadSite, browserProfile, resolvePort, connect, openCourseware,
  readTree, readRows, selectFolder, listNode, readJson, VIDEO_EXT, sleep,
} from './lib.mjs';

const configDir = process.argv[2];
if (!configDir) {
  console.error('usage: node scan.mjs <configDir> [workDir] [sitePath]');
  process.exit(2);
}
const workDir = process.argv[3] || join(configDir, 'work');
const site = loadSite(configDir, process.argv[4]);
mkdirSync(workDir, { recursive: true });

const manifest = readJson(join(configDir, 'manifest.json'), { known: {} });
const courses = readJson(join(configDir, 'courses.json'));
const known = manifest.known ?? {};

const port = resolvePort(browserProfile(site));
const cdp = await connect(port, null, site);

const results = [];

for (const [name, course] of Object.entries(courses)) {
  const entry = { course: name, code: course.code };
  try {
    if (!await openCourseware(cdp, site, course)) {
      entry.error = '课件页未就绪';
      results.push(entry);
      console.error(`  ${name}: 页面未就绪`);
      continue;
    }

    const nodes = await readTree(cdp);
    const seen = new Map();
    let htmlCount = 0;

    for (const node of nodes) {
      const parsed = await listNode(cdp, site, course, node.id);
      if (!parsed) { htmlCount += 1; continue; }
      for (const x of parsed.resList ?? []) {
        if (!x.rpId || seen.has(x.rpId)) continue;
        seen.set(x.rpId, {
          rpId: x.rpId,
          name: x.rpName,
          ext: (x.extName ?? '').toLowerCase(),
          inputTime: x.inputTime,
          stuDownload: x.stu_download,
          sizeMB: x.rpSize,
          folder: node.name,
        });
      }
      await sleep(80);
    }

    // The API answered with HTML for every node: fall back to the rendered rows,
    // which still carry names and rpIds even when the endpoint refuses.
    let items = [...seen.values()];
    if (!items.length && htmlCount) {
      for (const node of nodes) {
        // DOM rows carry no extension, so a video cannot be told apart by suffix.
        // The platform files videos under explicitly named folders, so skip those.
        if (/视频|录像|回放/.test(node.name)) continue;
        if (!await selectFolder(cdp, node.name)) continue;
        await sleep(2400);
        for (const row of await readRows(cdp)) {
          if (!row.rpId || seen.has(row.rpId)) continue;
          seen.set(row.rpId, {
            rpId: row.rpId, name: row.name, ext: '', inputTime: '',
            stuDownload: null, sizeMB: '', folder: node.name,
          });
        }
      }
      items = [...seen.values()];
      entry.usedDom = true;
    }

    const documents = items.filter((x) => !VIDEO_EXT.has(x.ext)
      // Belt-and-braces for DOM rows: a name ending in a video suffix is a video.
      && !/\.(mp4|mov|avi|mkv|flv|wmv|webm|m4v|mpg|mpeg|3gp)$/i.test(x.name));
    const fresh = documents.filter((x) => !known[x.rpId]);

    Object.assign(entry, {
      total: items.length,
      documents: documents.length,
      videos: items.length - documents.length,
      newCount: fresh.length,
      newItems: fresh,
    });
    console.error(`  ${name}: 文档 ${documents.length} / 视频 ${items.length - documents.length}`
      + ` / 新增 ${fresh.length}${entry.usedDom ? ' (DOM 兜底)' : ''}`);
  } catch (error) {
    entry.error = String(error.message || error);
    console.error(`  ${name}: 错误 ${entry.error}`);
  }
  results.push(entry);
}

cdp.close();

const outPath = join(workDir, 'scan.json');
writeFileSync(outPath, JSON.stringify({
  scannedAt: new Date().toISOString(),
  xqCode: site.xqCode,
  courses: results,
  summary: {
    courses: results.length,
    errored: results.filter((r) => r.error).length,
    newDocuments: results.reduce((n, r) => n + (r.newCount ?? 0), 0),
  },
}, null, 2), 'utf8');

const total = results.reduce((n, r) => n + (r.newCount ?? 0), 0);
console.error(`\n新增文档合计 ${total}，失败课程 ${results.filter((r) => r.error).length}`);
console.error(`写出: ${outPath}`);
