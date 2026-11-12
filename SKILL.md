# 教学平台课件增量同步

把教务/课程平台「电子课件」里新增的文档增量同步到共享盘。只增、不删、不覆盖，只同步文档，跳过视频。

适用于国内高校常见的教学平台（zTree + jQuery 前端那一类，如竞业达系产品）。
本文用占位符表示与你学校相关的部分，对应 `site.json` 的字段。

## 为什么写成一个 skill

这类平台有几处反直觉的坑，不知道就会得出错误结论并浪费大量时间：

- 列表接口只在**课件页上下文**里可用，换个页面调就返回「会话结束」，看起来像「没有课件」
- 标记为「仅预览」的文件，下载接口返回 200 和完整下载地址，但真要下载时 **HTTP 500**
- 左侧目录树点开后文件行是**异步渲染**的，同一个 tick 里读不到
- 托管浏览器窗口可能被最小化到屏幕外，此时**所有点击静默失效**

这些坑我都踩过一遍，写在这里省你一次。

## 目录结构

```
syncing-campus-courseware/
├── SKILL.md
├── reference.md          平台接口与页面结构细节
├── site.example.json     站点参数模板，复制成 site.json 后填自己的
└── scripts/
    ├── lib.mjs           共用：CDP 连接、读树、选目录、读行
    ├── edge-restore.mjs  把浏览器窗口从屏幕外拉回来
    ├── scan.mjs          扫描全部课程，找出新增文档
    ├── plan.mjs          生成下载计划
    ├── download.mjs      按下载权限分流下载
    └── land.mjs          落盘 + 校验 + 更新基线
```

## 一条命令跑完

```bash
cd scripts
node edge-restore.mjs                                  # 必须：否则所有点击静默失效
node scan.mjs     <configDir> <workDir>                # 产出 work/scan.json
node plan.mjs     <configDir> <workDir>                # 产出 work/plan.json
node download.mjs <configDir> <workDir>                # 下载到暂存区
node land.mjs     <configDir> <workDir> --apply        # 落盘 + 校验 + 更新基线
```

`land.mjs` 不加 `--apply` 是预演，只报会做什么。**先预演再写入。**

`<configDir>` 需含：

| 文件 | 作用 |
| --- | --- |
| `site.json` | 站点参数，从 `site.example.json` 复制后填写 |
| `courses.json` | `{ 课程名: { cid, code, xkh } }` |
| `manifest.json` | 增量基线，`known` 里是已同步过的 `rpId` |
| `preview_realurl.json` | 预览直链缓存，可选 |

`<workDir>` 默认 `<configDir>/work`。

无新增时 `plan.mjs` 直接打印「今日无新增」，可以收工。

## 关键事实

1. **登录入口要选对**。很多学校同时存在新旧两套入口，旧的会跳已下线的 CAS。
   正确链路一般是：门户 → 教学服务平台 → 智慧课程平台跳转 → 落到课程平台并带上 `sessionId`。
   `<jumpUrl>` 就是那个带 `sessionId` 的跳转地址。SSO 往往还活着，失效的只是下游会话，
   走一次跳转即可重建，通常不需要重新输密码。

2. **列表接口只在课件页上下文里可用**。
   `<courseResource>?method=stuQueryUploadResourceForCourseList` 必须在该课的
   `courseToPage=10450` 页面内调用。从课程首页调用会返回「会话结束」的 HTML，
   `JSON.parse` 失败会被误读成「这门课没课件」。

3. **部分课程接口返回空但页面有数据**。这类只能读渲染后的 DOM：
   文件行是 `.fileInfoBoxDeatil2`，首个 `<li>` 的 `title` 是文件名，
   `onclick` 里的 `goDetail('<rpId>'` 是唯一标识。

4. **「仅预览」文件不能走下载接口**。`stu_download=1` 的文件，
   `rpinfoDownloadUrl` 仍返回 `flag:true` 和完整 `rpUrl`，但 GET 该地址得到 HTTP 500、0 字节。
   正确做法是走预览 iframe：读 `#pdfIframe.src` 形如
   `<fileServer>/kk/onlinePreview?url=<base64>`，base64 解码后得到
   `<fileServer>/kk/rp/年/月/日/时间戳.ext`，该地址在校园网内直取，无需登录。
   office 文件可能只解析到转换后的预览 PDF（路径含 `/swf/`），扩展名用 `.pdf`。

5. **周目录里的文件必须先选目录**。点 zTree 节点后行列表异步渲染，
   必须「选目录 → 等 2-3 秒 → 再找行点击」。

6. **窗口可能被最小化到屏幕外 `(-32000,-32000)`**，此时所有合成点击静默落空，
   表现为「点了没反应」。任何点击前先跑 `edge-restore.mjs`。

## 详细步骤

### 1. 准备

```powershell
Test-Path '<shareRoot>'      # 共享盘可达
```

托管浏览器需在运行。调试端口每次启动都会变，从浏览器 profile 下的
`DevToolsActivePort` 文件读取，**不要写死端口**。

### 2. 登录并验证

访问门户的教学服务平台入口：

- 直接进平台且能看到自己的用户名 → 会话还在，走跳转即可。
- 落到 SSO 登录页 → 用配置里的账号密码重新登录。
- **出现图形验证码、短信、扫码、人脸等任何无法自动完成的环节，立即停下请人接管**，
  不要猜、不要反复重试。

然后走 `<jumpUrl>`，确认落地「我的课程」并记下 URL 里的 `sessionId`。

### 3. 扫描增量

对 `courses.json` 里每门课：

1. 走 `<jumpUrl>` 重建会话；
2. 导航到该课课件页 `courseToPage=10450&courseId=<code>&dataSource=1&cId=<cid>&xkhId=<xkh>&xqCode=<xqCode>`；
3. 等页面出现「课程资源」且 URL 含 `courseToPage=10450`；
4. 用 zTree 取全部节点，对每个节点调列表接口（`up_id=<节点id>`，根节点是 `0`）；
5. 合并去重，过滤视频扩展名（mp4/mov/avi/mkv/flv/wmv/webm/m4v/mpg/mpeg/3gp）；
6. 用 `rpId` 与 `manifest.json` 的 `known` 比对，不在其中的即新增。

接口返回 HTML 而非 JSON 的课程，`scan.mjs` 会自动回落到读渲染后的 DOM。
DOM 行没有扩展名，视频靠目录名（含「视频」「录像」「回放」）和文件名后缀双重过滤。

### 4. 下载

按 `stu_download` 分流：

- `2` → `rpinfoDownloadUrl` 拿 `rpUrl`，直接取字节。
- `1` → 预览直链方式（见关键事实 4）。

`preview_realurl.json` 里已解析过的 `rpId` 可直接命中，省掉解析步骤。

### 5. 落盘

目标目录 `<shareRoot>/<平台课程名>`，名称不一致的课程在 `site.json` 的 `folderMap` 里配映射。
文件夹不存在才新建，**先列目录确认**。

文件名 `<rpName>.<ext>`，把 `\ / : * ? " < > |` 替换为 `_`。

- **写入前**：目标已存在且字节数一致 → 跳过；字节数不同 → 存为 `<name>_新.<ext>`，绝不覆盖。
- **写入后**：逐个比对字节数与源一致，并抽查文件头：
  PDF `25 50 44 46`、docx/pptx/zip `50 4B 03 04`、doc/ppt `D0 CF 11 E0`。

### 6. 更新基线

成功落盘后，把新 `rpId` 追加进 `manifest.json` 的 `known`：

```json
"<rpId>": {
  "course": "课程名", "name": "文件名", "ext": "pdf",
  "inputTime": "2026-11-10 16:41:25", "stu_download": 1,
  "status": "added_YYYY-MM-DD"
}
```

同时把解析出的预览直链写进 `preview_realurl.json`。改前先备份 `*.bak-<日期>`。

`land.mjs` 只在全部校验通过后才更新基线，避免把没写成功的文件标成已同步。

### 7. 汇报

有新增：列出哪几门课、哪几个文件、大小、校验结果。
无新增：明确说「今日无新增」，不要含糊。

登录失效且自动登录失败、连不上校园网或共享盘：说明原因并停下，
**不要假装完成，不要重复无效重试**。

## 故障对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 点击没反应 | 窗口在 `(-32000,-32000)` | 先跑 `edge-restore.mjs` |
| 接口返回 HTML | 不在课件页上下文 / 会话过期 | 导航到 `courseToPage=10450` 重试 |
| 接口返回空但页面有行 | 该课只走 UI | 改 DOM 兜底 |
| 下载 HTTP 500 | `stu_download=1` 仅预览 | 走预览 iframe 取直链 |
| 找不到文件行 | 行列表异步未渲染 | 选目录后等 2-3 秒再找 |
| 读到上一个文件的内容 | 预览 iframe 有单元格状态 | 每个文件重新加载页面 |
| 落盘后文件打不开 | 取到了预览转换件 | office 用 `.pdf` 扩展名 |
| JSON 解析报 BOM 错误 | 文件被 PowerShell 写过 | 读入时剥掉 `\uFEFF` |

## 生效前提

- 电脑开机、托管浏览器运行、能连校园网与共享盘。
- 登录态可能隔夜失效。
- 学期变更后需更新 `site.json` 的 `xqCode` 与 `courses.json` 的课程列表。

## 更多

- 平台接口与页面结构细节：[reference.md](reference.md)
