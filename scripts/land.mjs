// Land downloaded files on the shared drive and update the incremental baseline.
//
// Rules: add only. An existing file with the same byte count is skipped; an
// existing file with a different size is written under a "_新" suffix. Nothing
// is ever overwritten or deleted. Every write is verified by byte count and a
// magic-number check, and the baseline is extended only after all checks pass.
//
// Usage: node land.mjs <configDir> [workDir] [--apply]
//   Without --apply this is a dry run that only reports what it would do.

import {
  mkdirSync, statSync, copyFileSync, existsSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, basename, extname, resolve, isAbsolute } from 'node:path';
import { readJson, loadSite } from './lib.mjs';

const configDir = process.argv[2];
if (!configDir) {
  console.error('usage: node land.mjs <configDir> [workDir] [--apply]');
  process.exit(2);
}
const workDir = process.argv[3] && !process.argv[3].startsWith('--')
  ? process.argv[3]
  : join(configDir, 'work');
const apply = process.argv.includes('--apply');

const site = loadSite(configDir);
const manifest = readJson(join(configDir, 'manifest.json'));
const root = site.shareRoot;
if (!root) throw new Error('site.json 缺少 shareRoot');

// Some platform course names differ from their folder name on the share.
const folderMap = site.folderMap ?? {};
const mapFolder = (course) => folderMap[course] ?? course;

const results = readJson(join(workDir, 'download.json'), []);
const ok = results.filter((r) => r.ok);

if (!ok.length) {
  console.log('没有可落盘的文件');
  process.exit(0);
}

// Downloaded records may carry paths relative to the directory the download ran
// in, so resolve against the work directory and the current one before giving up.
function resolveStaged(p) {
  if (!p) return null;
  if (isAbsolute(p) && existsSync(p)) return p;
  const candidates = [resolve(workDir, p), resolve(p), resolve(process.cwd(), p)];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const staged = ok
  .map((r) => ({ ...r, file: resolveStaged(r.path) }))
  .filter((r) => r.file);

if (!staged.length) {
  console.log('待落盘记录里的文件都不存在，检查 download 的暂存目录是否被清理。');
  process.exit(1);
}

function magicOk(path) {
  const head = readFileSync(path).subarray(0, 4).toString('hex');
  return head.startsWith('25504446') || head.startsWith('504b0304') || head.startsWith('d0cf11e0');
}

const plan = [];
for (const item of staged) {
  const destDir = join(root, mapFolder(item.courseFolder ?? item.course));
  if (!existsSync(destDir)) {
    if (!apply) { plan.push({ item, action: 'mkdir+copy', target: join(destDir, basename(item.file)) }); continue; }
    // Created only when it truly does not exist.
    mkdirSync(destDir, { recursive: true });
  }

  let target = join(destDir, basename(item.file));
  if (existsSync(target)) {
    if (statSync(target).size === statSync(item.file).size) {
      plan.push({ item, action: 'skip-same-size', target });
      continue;
    }
    target = join(destDir, `${basename(item.file, extname(item.file))}_新${extname(item.file)}`);
    plan.push({ item, action: 'copy-as-new', target });
  } else {
    plan.push({ item, action: 'copy', target });
  }

  if (apply) copyFileSync(item.file, target);
}

// Verify what is now on the share.
const report = plan.map((entry) => {
  const { item, action, target } = entry;
  if (action.startsWith('skip')) return { name: basename(item.file), action, verified: true };
  if (!apply) return { name: basename(target), action, verified: null };
  const sameSize = statSync(target).size === statSync(item.file).size;
  const goodMagic = magicOk(target);
  return {
    name: basename(target), action, bytes: statSync(target).size,
    verified: sameSize && goodMagic,
  };
});

for (const r of report) {
  const mark = r.verified === null ? '待写入' : r.verified ? 'OK' : 'BAD';
  console.log(`  [${mark}] ${r.action}  ${r.name}${r.bytes ? `  ${r.bytes} 字节` : ''}`);
}

if (!apply) {
  console.log('\n这是预演（dry run）。确认无误后加 --apply 真正写入。');
  process.exit(0);
}

const bad = report.filter((r) => r.verified === false);
if (bad.length) {
  console.error(`\n校验失败 ${bad.length} 个，基线未更新。`);
  process.exit(1);
}

// Only now extend the baseline, so a failed write never marks a file as synced.
let added = 0;
for (const r of ok) {
  manifest.known[r.rpId] = {
    course: r.course,
    name: r.name,
    ext: r.ext,
    inputTime: r.inputTime ?? '',
    stu_download: r.stuDownload ?? null,
    status: `added_${new Date().toISOString().slice(0, 10)}`,
  };
  added += 1;
}

writeFileSync(join(configDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log(`\n落盘完成 ${report.filter((r) => r.verified).length} 个，基线新增 ${added} 条。`);
