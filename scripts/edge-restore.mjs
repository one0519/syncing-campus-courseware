// Restore and foreground the managed browser window.
//
// Other automation can minimise this window to (-32000, -32000). While it sits
// there, every synthetic click lands outside the viewport and fails silently,
// which reads as "the page ignores my clicks" rather than a window problem.
// Run this before any UI interaction.
//
// Usage: node edge-restore.mjs [configDir] [x] [y] [w] [h]

import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { readJson } from './lib.mjs';

const [configDirArg, x = '100', y = '60', w = '1280', h = '900'] = process.argv.slice(2);

// The profile directory name is what identifies the window in the command line,
// so a handle written down earlier is never relied on.
let profileDir = process.env.DSH_EDGE_PROFILE || '';
if (!profileDir && configDirArg) {
  try { profileDir = readJson(join(configDirArg, 'site.json')).browser?.profile ?? ''; }
  catch { /* fall through to a generic match */ }
}
const profileTag = profileDir ? basename(profileDir) : 'kept-edge';

const findScript = `
$tag = '${profileTag.replace(/'/g, "''")}'
$procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like "*$tag*" -and $_.CommandLine -notlike '*--type=*' }
$hwnd = $null
foreach ($p in $procs) {
  $h = (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle
  if ($h -and $h -ne 0) { $hwnd = $h; break }
}
if ($hwnd) { Write-Output $hwnd } else { Write-Output '' }
`;

const hwnd = execFileSync('powershell', ['-NoProfile', '-Command', findScript],
  { encoding: 'utf8' }).trim();

if (!hwnd) {
  console.error(`未找到浏览器窗口（profile 标识: ${profileTag}），请先启动浏览器。`);
  process.exit(1);
}

const script = `
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool r);
'@
$h = [IntPtr]${hwnd}
[W.U]::ShowWindow($h, 9) | Out-Null
[W.U]::MoveWindow($h, ${x}, ${y}, ${w}, ${h}, $true) | Out-Null
[W.U]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
"restored"
`;

const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
process.stdout.write(`${out.trim()} (hwnd=${hwnd})\n`);
