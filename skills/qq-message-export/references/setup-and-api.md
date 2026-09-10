# QCE 接入与已核对协议

## 运行前提

上游：[shuakami/qq-chat-exporter](https://github.com/shuakami/qq-chat-exporter)，[使用文档](https://shuakami.github.io/qq-chat-exporter/)，[发行版](https://github.com/shuakami/qq-chat-exporter/releases)。2026-09-09 查阅其 master README 和 Rust API/前端请求构造源码；本工具为独立 HTTP 客户端，没有复制或安装 QCE 运行代码。API 可能随版本变化，遇到不匹配明确失败，不猜端点重试。

QCE README 提供 Windows 安装包和 Shell 便携包。Shell 模式使用官方包内 launcher-user.bat，由用户在本机扫码登录后打开 `http://localhost:40653/qce`。这需要 QQ 登录态/NapCat 桥接，不是仅启动一个历史文件 viewer。部署前核对当前发行版说明、支持平台、是否会影响已运行 QQ、文件落点及用户授权；不要直接对现有 QQ 安装注入插件或强制退出。

本轮环境发现：QQ.exe 文件 ProductVersion 为 `9.9.19.34740-12e4987f`，安装目录另有 `9.9.21-39038` 资源；不能仅凭 launcher 文件版本断言实际运行资源版本。未发现默认端口 40653 的监听；GUI 检查工具初始化失败，因此未确认本机 QQ 的导出菜单，也未核对目标群号。

## 配置

客户端从运行环境读取：

| 变量 | 值 |
| --- | --- |
| QCE_BASE_URL | 默认 http://127.0.0.1:40653；只允许 loopback HTTP origin，无路径/查询/凭据 |
| QCE_TOKEN_FILE | 保存 QCE API token 的 UTF-8 本地文件路径；优先于 QCE_TOKEN |
| QCE_TOKEN | 可选进程环境 token；不要放入工具参数、命令行或对话 |
| QCE_EXPORT_ROOT | 本地导出根目录；默认技能集合所在父目录下 qq-message-exports |
| WORKBUDDY_COMPUTER_PYTHON | MCP 包装层调用的现有 Python，使用原 computer-tools 配置 |

Token 由用户在 QCE 当前会话生成/显示的本地界面取得，保存在仅本人可读的文件中。不自动读取终端输出或浏览器 URL 来提取认证秘密。WorkBuddy 现有 local-computer-tools 的 env 可添加 QCE_TOKEN_FILE；不要覆盖其他配置，也不要在日志中显示 env 值。改变后重连该 MCP 服务；不需要重启 TextGen 模型服务器。

QCE 与本客户端应运行在同一 Windows 主机并能访问相同 outputDir。Docker/远程服务的路径不一定可见，本工具不自动下载 URL 或挂载文件；完成后找不到本地文件时报告路径映射问题。

## 最小 API 契约

所有 API 使用 `Authorization: Bearer <token>`（如 QCE 配置要求），响应需有 `success:true,data:...`。无认证、standalone、schema 错误与连接失败都不解释为“没有消息”。

| 方法/端点 | 本工具用途 |
| --- | --- |
| GET /api/system/info | 读取 version、mode、napcat.online、selfInfo.uin |
| GET /api/groups?page=N&limit=200 | groups 数组、groupCode/groupName，使用 hasNext 分页 |
| GET /api/friends?page=N&limit=200 | friends 数组、uin/uid/nick/remark/chatType，使用 hasNext 分页 |
| POST /api/messages/export | 创建单次正常历史导出，返回 taskId |
| GET /api/tasks/:taskId | 只查本客户端已有 receipt 的任务 |

群聊 peer 为 `chatType:2, peerUid:groupCode, peerUin:groupCode`；正常好友为 `chatType:1, peerUid:内部 uid, peerUin:QQ号`。字段全部来自后端匹配结果，不从群昵称推导数字 ID。

filter 使用 Unix **秒** 的 startTime/endTime；上游标准批量过滤为 `msg_time >= start && msg_time <= end`。客户端将结束排除边界减 1 秒，符合 QQ 秒级时间戳；拒绝含小数秒的输入以免悄悄改变区间。date-only end 先推进到次日零点。群内发送人使用 includeUserUins。

默认普通 JSON 导出，batchSize 5000，skipDownloadResourceTypes 为 image/video/audio/file。不去掉系统消息或纯图片消息；关闭资源下载不等于删除这些消息。请求 outputDir 指向每次独立 UUID 子目录，无覆盖原文件操作。

该客户端暂不调用 experimental roaming、发送、删除、登录、设置修改或定时任务接口。QCE 可导出的消息受本地缓存、漫游保留、登录权限、资源有效期和后端实现约束；最近消息更适合先做小范围测试。长历史可能仍需等待同步/扫描，不能保证固定速度。

## 诊断与提交不确定性

1. 连接拒绝：确认 QCE 正在运行以及自定义端口；不要把 QQ.exe 的其他本地端口当作 QCE。
2. 401/403：在本地配置正确 token。不要重置 QQ 安全策略。
3. ready=false：由用户完成登录，或使用支持抓取的模式；standalone 不能解决此问题。
4. 群名多个匹配：展示匹配名字/群号供选择，不读取无关群消息。
5. POST 超时：请求可能已成功创建任务，receipt 标为 unknown；在 QCE UI 按会话和时间找到原任务，不再自动 POST。
6. completed 但文件不存在：检查相同主机路径、QCE 版本是否支持 outputDir；不使用返回的任意 downloadUrl 代读其他文件。
7. 完成后内容缺失：核对时间区间、发送人条件、最早/最晚消息、QQ 可见记录与资源失败，明确实际覆盖范围。不能自动扩展到其他群、所有好友或全部历史。
