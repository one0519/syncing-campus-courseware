# 平台接口与页面结构

国内高校的教学平台多用同一套架构：jQuery + zTree + layer，接口挂在 `/ve/` 下。
下面是从一个实际平台整理出来的结构，字段名与路径在同类产品里高度一致，
换学校后按 `site.json` 改域名端口即可。

## 主机与入口

| 角色 | 占位符 | 说明 |
| --- | --- | --- |
| 课程平台 | `<PLATFORM_HOST>:<PORT>` | 教学平台本体，通常 HTTP |
| 文件服务器 | `<FILE_HOST>:<PORT>` | 预览与真实文件直链，校园网内免登录 |
| 教学服务平台 | `<LMS_HOST>` | 门户里「本科教学服务平台」的落地站 |
| 统一认证 | `<SSO_HOST>` | 单点登录 |
| 智慧课程平台跳转 | `<jumpUrl>` | 带 `sessionId` 跳进课程平台 |

新旧入口要分清：一些学校同时保留「旧 CAS 入口」（已下线）和新的服务平台跳转，
走旧的会一直失败。

## 接口

### 文件列表

```
GET  <courseResource>
     ?method=stuQueryUploadResourceForCourseList
     &courseId=<课程代码>&cId=<课程代码>&xkhId=<xkhId>
     &xqCode=<xqCode>&docType=1&up_id=<树节点id>&searchName=
```

`docType=1` 是电子课件。`up_id` 是 zTree 节点的 `id`，根节点为 `0`。
返回 `{ resList: [...], STATUS: "0" }`。

`resList` 单条字段：

| 字段 | 说明 |
| --- | --- |
| `rpId` | 资源唯一标识，**判重依据** |
| `rpName` | 文件名（不含扩展名） |
| `extName` | 扩展名 |
| `rpSize` | 大小，MB |
| `inputTime` | 上传时间 |
| `stu_download` | `2`=可下载，`1`=仅预览 |
| `resId` | 资源序号 |
| `play_url` / `res_url` | 通常为空 |

**调用前提**：必须在 `courseToPage=10450` 的课件页里发起。从别处调用返回一段
GBK 编码的「会话结束」HTML，`JSON.parse` 失败——这会被误读成「课程没有课件」。

### 下载地址解析

```
POST <resourceSpace>?method=rpinfoDownloadUrl&rpId=<rpId>
```

返回 `{ flag: true, download_type: "0", rpUrl: "...", html: "..." }`。

`rpUrl` 形如 `<PLATFORM_HOST>/ve/download.shtml?userId=<学号>&id=<rpId>&p=rp&g=<URL编码的文件名>`。

**注意**：`stu_download=1` 的文件这里同样返回 `flag:true` 和完整 `rpUrl`，
但 GET 该地址得到 HTTP 500、0 字节。**元数据正常不代表文件可取**——
这一点最容易把人带偏，误判成「平台文件损坏」。

### 预览直链

课件页点 `goDetail(rpId)` 后，右侧渲染 `#pdfIframe`，其 `src`：

```
<FILE_HOST>:<PORT>/kk/onlinePreview?url=<base64>
```

base64 解码（`atob`）后是真实文件：

```
<FILE_HOST>:<PORT>/kk/rp/2025/11/10/20251110164125420062.pdf
```

office 文件常只解析到转换件 `.../kk/rp/2026/09/08/swf/....pdf`，
下载得到的是预览版 PDF，扩展名用 `.pdf`。

`preview_realurl.json` 就是 `rpId -> 真实地址` 的缓存，命中可跳过整个解析流程。

## 页面结构

| 选择器 | 内容 |
| --- | --- |
| `#treeDemo` | 左侧章节树（zTree） |
| `ul.fileInfoBoxHead` | 表头：文件名称 / 属性 / 操作 |
| `ul.fileInfoBoxDeatil2` | 每个文件一行，首个 `<li>` 的 `title` 是文件名 |
| 行内 `onclick` | `goDetail('<rpId>','undefined','0',...)` |
| `#pdfIframe` | 预览查看器 |
| `.courseItem` | 「我的课程」课程卡片，`onclick="goPage(cId, code, xkhId, xqCode)"` |

zTree 对象：`jQuery.fn.zTree.getZTreeObj('treeDemo')`，
可用 `getNodes()` / `getNodeByTId()` / `selectNode()`。

章节节点是**惰性加载**的折叠节点：点击只是切换展开状态，必须展开后子节点才存在，
而文件行的渲染又是另一层异步，所以读行要单独等待。

## 会话行为

- 课程平台 `sessionId` 只活十几分钟，过期后所有接口返回「会话结束」HTML。
- 走一次 `<jumpUrl>` 即可重建，无需重新输密码（SSO 通常仍在线）。
- `sessionId` 在跳转后的 URL 里：`coursePlatform.shtml?method=toCoursePlatformIndex&sessionId=XXX`。
- 接口调用靠 cookie，`sessionId` 主要供页面自身使用。

## 课程清单

`courses.json` 形如 `{ 课程名: { cid, code, xkh } }`：

- `cid` 是课程内部数字 ID（如 `130838`）
- `code` 是课程代码（如 `ABC123X`）
- `xkh` 是选课号（如 `2026-2027-1-2ABC123X06`，含学期与课序号）

注意列表接口里 `courseId` 与 `cId` 都传 `code`，不是 `cid`；
只有课件页 URL 里才用 `cid`。这个不一致很容易搞错。

## 已知边界

- 有些课程平台侧确实没有任何电子课件，列表为空是正确结果，不是抓取失败。
- 有些课程列表接口返回空但页面有行，必须读 DOM。
- 视频（mp4/mov/avi/mkv/flv/wmv/webm/m4v/mpg/mpeg/3gp）通常不在同步范围。
- 学期参数 `xqCode` 每学期变一次，变更后要同步更新。
