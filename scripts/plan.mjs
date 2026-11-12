// Build the download plan from a scan result.
//
// Emits one entry per new document, carrying everything the downloader needs
// (course ids, chapter folder, display name, rpId, download permission).
//
// Usage: node plan.mjs <configDir> [workDir]

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './lib.mjs';

const configDir = process.argv[2];
if (!configDir) {
  console.error('usage: node plan.mjs <configDir> [workDir]');
  process.exit(2);
}
const workDir = process.argv[3] || join(configDir, 'work');

const scan = readJson(join(workDir, 'scan.json'));
const courses = readJson(join(configDir, 'courses.json'));

const items = [];
for (const course of scan.courses) {
  if (!course.newCount || !course.newItems?.length) continue;
  const info = courses[course.course];
  if (!info) {
    console.error(`警告: courses.json 缺少课程 ${course.course}，跳过`);
    continue;
  }
  for (const doc of course.newItems) {
    items.push({
      course: course.course,
      courseFolder: course.course,
      folder: doc.folder ?? '',
      code: info.code,
      cid: info.cid,
      xkh: info.xkh,
      name: doc.name,
      ext: doc.ext,
      rpId: doc.rpId,
      stuDownload: doc.stuDownload,
      sizeMB: doc.sizeMB,
      inputTime: doc.inputTime,
    });
  }
}

const outPath = join(workDir, 'plan.json');
writeFileSync(outPath, JSON.stringify({
  xqCode: scan.xqCode,
  builtAt: new Date().toISOString(),
  items,
}, null, 2), 'utf8');

if (!items.length) {
  console.log('今日无新增');
} else {
  console.error(`计划 ${items.length} 个文件:`);
  for (const it of items) {
    const how = Number(it.stuDownload) === 2 ? '直下' : '预览';
    console.error(`  [${how}] ${it.course} / ${it.folder} / ${it.name}.${it.ext} (${it.sizeMB} MB)`);
  }
}
console.error(`写出: ${outPath}`);
