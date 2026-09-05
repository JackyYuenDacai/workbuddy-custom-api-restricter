# WorkBuddy Custom API Restricter

将 WorkBuddy 的模型推理限制到一个指定的 OpenAI Compatible API 和模型，同时保留现有登录、联网搜索及其他非模型网络功能。

这是针对特定 WorkBuddy 构建的非官方程序补丁，**不是通用插件，也不是防火墙或离线模式**。仓库只提供补丁源码、测试和文档，不分发 WorkBuddy 程序、模型、登录信息或 API Key。

## 当前默认配置

| 项目 | 值 |
| --- | --- |
| 模型 | `Qwen3.8-27B-EXL3-3.5bpw` |
| OpenAI Compatible Base URL | `http://127.0.0.1:8317/v1` |
| 实际请求 | `POST http://127.0.0.1:8317/v1/chat/completions` |
| WorkBuddy 内部模型 ID | `custom-local:Qwen3.8-27B-EXL3-3.5bpw` |
| 已验证版本 | WorkBuddy `5.5.3` |
| 已验证 build | `104760a280d1710d375d024bc87a03f08d97c590` |
| 验证环境 | Windows x64，WorkBuddy 自带 Node `22.22.2-2` |
| 验证日期 | 2026-09-06 |

默认地址是 **8317，不是 5000**。设置中填写 Base URL，不要再加 `/chat/completions`。

## 详细文档

- [完整安装、验证、回滚与更新流程](docs/INSTALL.md)
- [替换 API 地址、模型和 API Key](docs/API-CONFIGURATION.md)
- [排查过程、程序修改原理与验证记录](docs/IMPLEMENTATION.md)

首次使用请先读安装文档。源码中有构建相关的精确匹配条件，不能直接拿旧补丁覆盖新版本 WorkBuddy。

## 限制的实际行为

- CLI/ACP 返回的可用模型列表只保留指定模型。
- 默认模型和走相同模型管理器的辅助代理使用指定模型。
- CLI 启动时传入 Auto 或其他模型，会被强制覆盖为指定模型，而不是执行云端推理。
- 运行时切换到非允许模型会被拒绝；底层请求再次校验模型和 URL。
- 模型回退拦截器被禁用，模型请求不使用系统 HTTP 代理、不跟随重定向。
- 不修改登录、搜索客户端、通用网络配置、TextGen 或 8317 代理配置。

桌面主程序缓存仍可能显示 Auto，这不等于执行引擎仍会使用 Auto。应用更新可能覆盖补丁。本项目限制的是 WorkBuddy 发出的模型请求；指定 API 背后的实际模型映射与服务端回退仍需你自己控制。

## 已完成验证

在上述版本和默认配置上完成：

- WorkBuddy 冷启动正常，现有登录会话可用。
- 10 项源码及安装测试全部通过。
- 分别以 Qwen、`auto`、`gpt-5.5` 启动实际 CLI 测试，三次均收到助手回复 `LOCAL_QWEN_OK`，响应模型均为 Qwen。
- 本地 Qwen 实际调用 `WebSearch`，工具状态 `completed`，结果包含 `docs.python.org`，最终会话 `success`。
- 已安装程序哈希匹配，备份可重建补丁，受完整性保护的 `app.asar` 未变更。

未验证所有桌面操作、所有辅助代理或退出后重新登录；这些结果不能替代新版本、新接口的重新测试。

## 仓库文件

| 文件 | 用途 |
| --- | --- |
| `policy.cjs` | 允许的模型、API 地址和请求校验策略；重新生成时注入程序 |
| `patch.cjs` | 准备、安装和回滚两个 CLI bundle |
| `paths.cjs` | 读取本机路径，不改变注入的路由策略 |
| `paths.example.json` | 无密钥的本机路径示例 |
| `test.cjs` | 策略、语法、哈希和备份重建测试 |
| `smoke.cjs` | 通过实际 CLI 测试推理和搜索，输出脱敏摘要 |
| `docs/` | 详细使用和实现文档 |

`paths.local.json`、`staged/`、`manifest.json`、日志、备份均被 Git 忽略。本机已有安装的这些文件应保留，不能因为不提交就删除；回滚和完整验证会用到它们。

只运行不依赖 WorkBuddy 安装的 6 项策略测试：

```powershell
npm test
```

无需 `npm install`，脚本仅使用 Node.js 内置模块。完整安装测试在准备并安装补丁后执行：

```powershell
npm run test:installed
```
 

本项目不包含 WorkBuddy 本身；使用者需自行合法安装 WorkBuddy，并遵守软件条款和相关 API 服务条款。
