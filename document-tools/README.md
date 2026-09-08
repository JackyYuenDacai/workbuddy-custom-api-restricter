# WorkBuddy 本地文档工具

通过标准 MCP stdio 为 WorkBuddy 添加常用文件转换功能，不调用额外模型 API、不修改现有 Qwen 路由限制。

| 工具 | 用途 |
| --- | --- |
| `document_tools_info` | 查询允许访问的文档目录及限制 |
| `html_to_pdf` | 本地 HTML/HTM → A4 PDF，保留内联样式 |
| `html_to_markdown` | 本地 HTML/HTM → Markdown，保留标题、列表、链接、代码及基础表格 |
| `markdown_to_pdf` | 本地 Markdown → 带中文字体、代码块、表格样式的 A4 PDF |
| `write_markdown` | 将模型组织好的 Markdown 内容保存为新的 `.md` 文件 |

`write_markdown` 只负责保存文本，内容仍由 WorkBuddy 当前模型生成。HTML 表格仅做基础转换，复杂嵌套、合并单元格和页面布局不保证完整保留。

## 本机已安装的位置与使用方法

MCP 名称：`local-document-tools`，用户级安装。当前专用文档目录：

```text
F:\GitHub\textgen\user_data\workbuddy-documents
```

把需要转换的文件复制进此目录，再打开 WorkBuddy 新会话。若工具列表尚未刷新，保存任务后重启 WorkBuddy或在 MCP 界面刷新连接；安装脚本不会中断当前桌面任务。

可以直接对 WorkBuddy 说：

> 使用 local-document-tools，先查询文档目录，再把 sample.html 转成 report.pdf。

> 把 sample.html 转成 report.md，保存到本地文档目录。

> 把 sample.md 转成 report-from-md.pdf。

> 帮我整理一份项目周报，用 write_markdown 保存为 weekly-report.md。

WorkBuddy 使用延迟工具加载。如果模型说找不到工具，可明确要求：

> 先用 ToolSearch 查找 local-document-tools 的 write_markdown，再按工具说明用 DeferExecuteTool 执行，不要只把调用代码写在回复里。

输出文件已经存在时必须改一个新名称，工具不会覆盖旧文件。参数可以使用文档目录内的相对路径，例如 `sample.html`，也可以使用该目录内部的绝对路径。工具不能读取目录之外的文件；不需要关闭 WorkBuddy 的安全确认来使用。

## 在另一台电脑安装

前提：Node.js 22+、已安装的 Edge 或 Chrome、可正常启动的 WorkBuddy。这里的文档工具依赖 npm 包，和父目录“无需 npm install”的路由补丁不同。

1. 先按父目录说明填写 `paths.local.json`，设置 WorkBuddy 安装目录、用户配置目录及可用 Node。
2. 进入 `document-tools`，安装锁定依赖：

```powershell
npm.cmd ci --ignore-scripts --no-fund
```

不下载 Chromium，使用本机已有浏览器；不启用 npm 安装脚本。

3. 建立一个专用文档文件夹，如 `D:\WorkBuddyDocuments`。不要使用磁盘根目录、用户主目录或放有密钥的目录。
4. 首次复制并编辑本机工具配置：

```powershell
if (!(Test-Path -LiteralPath .\local-install.json)) {
    Copy-Item -LiteralPath .\local-install.example.json -Destination .\local-install.json
}
notepad .\local-install.json
```

```json
{
  "documentRoot": "D:/WorkBuddyDocuments",
  "browserPath": "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
}
```

也可填写真实的 Chrome 路径。`local-install.json` 被 Git 忽略，不应放入 API Key。

5. 将 `examples/sample.html` 和 `examples/sample.md` 复制到文档目录；如果已有同名文件，先检查，勿覆盖自己的文件。
6. 添加工具并检查连接：

```powershell
node workbuddy-install.cjs install
node workbuddy-install.cjs check
```

check 应输出 `registered: true` 和 `connected: true`。安装调用 WorkBuddy 自带 `mcp add-json --scope user`，只新增本工具，不替换其他 MCP 设置。存在同名条目或其状态无法确认时拒绝覆盖。

WorkBuddy 在“查无条目”时也可能返回退出码 0，因此脚本会核对实际状态输出，不能只看外层退出码。

## 测试

```powershell
npm.cmd test
```

默认测试文件边界、基础转换与 MCP stdio 握手；PDF 测试需要浏览器：

```powershell
$env:WORKBUDDY_TEST_PDF = '1'
$env:WORKBUDDY_BROWSER_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
npm.cmd test
```

实际转换四个带时间戳的新文件，以及通过 Qwen 调用一次保存工具：

```powershell
node smoke.mjs
node smoke.mjs workbuddy
```

第二项会调用已配置的 Qwen API，使用固定测试提示，严格只加载本 MCP 服务，并为本次调用允许 ToolSearch、DeferExecuteTool 和指定的保存工具，不改变全局批准规则，不保存会话。WorkBuddy 自身仍可能记录诊断日志。脚本输出摘要，不打印模型密钥或其他 MCP 凭据。

### 本机验证结果（2026-09-06）

- 用户级 MCP 注册成功，WorkBuddy 查询状态为 `Connected`。
- 6 项测试全部通过，包含两种 PDF 转换、Markdown 内容、文件边界、防覆盖、MCP 握手和页面外部请求拦截。
- 四项工具均通过真实 MCP 调用生成了示例输出。
- 指定的 `Qwen3.8-27B-EXL3-3.5bpw` 在 WorkBuddy 中实际完成 `ToolSearch → DeferExecuteTool`，创建包含 `LOCAL_DOCUMENT_TOOL_OK` 的新文件，并回复 `DONE`。
- 路由补丁的原有 10 项完整测试仍通过。文档工具的安装没有修改模型 API 或云端回退策略。

## 安全与兼容边界

- 输入限 `.html`、`.htm`、`.md`、`.markdown`，UTF-8，最大 2 MiB；输出最大 32 MiB。
- 只允许配置的文档目录内部路径，拒绝常规路径穿越、隐藏目录、ADS 以及输出父目录链接越界。
- 输出父目录必须已存在，新文件独占创建，不覆盖已有文件。
- HTML JavaScript 被禁用，渲染上下文离线，拦截外部资源请求，使用 CSP 限制内容；只保证内联 CSS、data 图片等自包含内容的转换。
- 不会抓取网页 URL；外部 CSS、图片、字体、相对路径图片及需要脚本执行的网页可能缺失。需先整理为自包含 HTML。
- 使用 Edge/Chrome 的无界面模式与浏览器沙箱，不使用 `--no-sandbox`。
- 这不是针对恶意本地进程的完整隔离；目录内不要存敏感文件。请求拦截针对文档页面，不代表能禁止浏览器进程自身的所有后台联网。
- 本工具不是 MCP 自动批准规则，不修改 WorkBuddy 的安全确认设置。

## 修改文档目录或卸载

改变 `local-install.json` 不会自动更新已经注册的 MCP 环境变量。需先移除这个条目，再编辑设置并重新 install；不会影响其他工具。

```powershell
node workbuddy-install.cjs remove
# 编辑 local-install.json 后重新安装：
node workbuddy-install.cjs install
```

remove 只移除用户级 `local-document-tools` MCP 条目，不删除源码、文档、测试结果或其他配置。保存现有任务后刷新 WorkBuddy 的 MCP 连接，使变更生效。
