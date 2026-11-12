# 教学平台课件增量同步 Skill

把高校教学平台「电子课件」里新增的文档**增量**同步到共享盘。只增、不删、不覆盖，只同步文档，跳过视频。

这是一个 [DeepSeek Harness](https://github.com/) / Codex 风格的 Agent Skill：一个 `SKILL.md` 加一组脚本，
让 agent 在需要时按固定流程干活，而不是每次重新摸索。

## 它解决什么

国内高校的教学平台（竞业达系那类，jQuery + zTree 前端）有几处反直觉的设计，
不知道就会得出错误结论：

| 坑 | 表象 | 真相 |
| --- | --- | --- |
| 列表接口绑定页面上下文 | 换个页面调就返回「会话结束」HTML | 必须在课件页 `courseToPage=10450` 内调用 |
| 「仅预览」文件的下载接口 | 返回 200 + 完整下载地址，真下载时 500 | `stu_download=1` 根本不走 `download.shtml`，得从预览 iframe 取真实直链 |
| 文件行异步渲染 | 点了目录立刻找行，找不到 | 选目录后要等 2-3 秒 |
| 浏览器窗口被最小化到屏幕外 | 所有点击静默落空 | 先跑 `edge-restore.mjs` |
| PowerShell 写 JSON 带 BOM | `JSON.parse` 直接崩 | 读入时剥掉 `\uFEFF` |

第一条和第二条最容易把人带偏——我最初就误判成「平台文件损坏，建议找老师要」。

## 结构

```
syncing-campus-courseware/
├── SKILL.md              主文档：关键事实、7 步流程、故障对照表
├── reference.md          平台接口与页面结构细节
├── site.example.json     站点参数模板
└── scripts/
    ├── lib.mjs           共用：CDP 连接、读树、选目录、读行、调列表接口
    ├── edge-restore.mjs  把浏览器窗口从屏幕外拉回可见区域
    ├── scan.mjs          扫描全部课程，找出新增文档
    ├── plan.mjs          生成下载计划
    ├── download.mjs      按下载权限分流下载
    └── land.mjs          落盘 + 校验 + 更新基线
```

## 用法

1. 复制 `site.example.json` 为 `site.json`，填入平台域名、端口、共享盘路径、学期参数。
2. 准备 `courses.json`、`manifest.json`（可先用空 `known` 跑一遍建立基线）。
3. 按顺序执行：

```bash
cd scripts
node edge-restore.mjs <configDir>
node scan.mjs     <configDir>
node plan.mjs     <configDir>
node download.mjs <configDir>
node land.mjs     <configDir>          # 预演，只报告
node land.mjs     <configDir> --apply  # 真正写入
```

`land.mjs` 默认预演。它只增不覆盖：同名且字节数一致就跳过，不一致写 `_新` 后缀。
所有写入都会核对字节数和文件头（PDF `25 50 44 46`、ZIP 系 `50 4B 03 04`、OLE `D0 CF 11 E0`）。
只要有一个校验不过，基线就不更新，避免把没写成功的文件标成已同步。

## 依赖

- Node.js ≥ 22（用了内置 `WebSocket` 和 `fetch`）
- 一个可控的 Chromium/Edge 实例，开启了远程调试（脚本从 profile 下的 `DevToolsActivePort` 读端口，端口是动态的）
- 能连校园网与共享盘

## 适配到自己学校

主要改 `site.json`：

```json
{
  "platform": { "host": "你的课程平台域名", "port": 88 },
  "fileServer": { "host": "你的文件服务器", "port": 1936 },
  "jumpUrl": "带 sessionId 的跳转地址",
  "xqCode": "学期参数",
  "shareRoot": "\\\\你的文件服务器\\共享路径\\课件",
  "browser": { "profile": "你的浏览器 profile 目录" }
}
```

接口路径、字段名、DOM 选择器在同类平台里高度一致，通常不用改。
如果字段名不同，改 `scripts/lib.mjs` 里的 `listNode`。

## 注意

- 登录态会过期，脚本每次都会重建会话；遇到验证码、短信、扫码、人脸等环节会明确停下等人接管，不会乱试。
- 平台改版后选择器可能失效，先看 `reference.md` 再调。
- 这个仓库不含任何真实账号、密码、内网地址或单位信息。

## License

MIT
