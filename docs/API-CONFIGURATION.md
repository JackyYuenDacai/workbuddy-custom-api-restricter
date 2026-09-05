# 替换 API 地址、模型与密钥

## 1. 先区分三类配置

| 配置位置 | 管什么 | 修改后是否需要重新生成补丁 |
| --- | --- | --- |
| WorkBuddy 自定义模型设置 / 本机 `models.json` | 注册模型、密钥、能力声明及界面地址 | 只换密钥通常不用；换模型/地址还必须改策略 |
| 本仓库 `policy.cjs` | 真正允许的模型、API 地址和请求校验 | **需要 prepare → install → 重启** |
| 本仓库 `paths.local.json` | 安装目录、用户配置目录、Node、备份目录 | 不改变 API；用于安装/测试/回滚工具定位文件 |

安装时会把策略函数的源码复制进两个 JS bundle。运行中的 WorkBuddy 不会实时读取仓库里的 `policy.cjs`，也不会把 `paths.local.json` 当作 API 配置。

所以：**只在界面更换 URL 会被补丁覆盖；只修改 policy.cjs 也不会立刻生效。** 不需要修改任何全局登录服务器或搜索服务地址。

## 2. 仅更换 API Key

模型 ID、地址不变时：

1. 在 WorkBuddy 自定义模型设置中更新该模型的 API Key。
2. 保存后重新启动 WorkBuddy，使相关进程重新加载配置。
3. 运行 `node smoke.cjs local`；确认实际回复成功。

一般不必重建补丁，因为 `localConfig()` 保留原配置的其他字段，包括密钥。如果仍返回 401，应检查服务端密钥是否有效及 WorkBuddy 是否加载了正确配置目录。

不要把密钥写入 `policy.cjs`、路径配置、README 或 Git。不要覆盖整个 `models.json`，也不要把它复制进仓库。登录令牌与自定义模型的 API Key 是两回事。

## 3. 换端口或 Base URL

当前策略在 `policy.cjs` 中有三个相互对应的地址设置：

```javascript
const base = 'http://127.0.0.1:8317/v1';
// guardRequest 中：
url.origin !== 'http://127.0.0.1:8317'
url.pathname !== '/v1/chat/completions'
```

例如迁移到本机端口 `9000`，路径保持 `/v1`，需要改为：

```javascript
const base = 'http://127.0.0.1:9000/v1';
// 原有 if 条件中的两个比较项：
url.origin !== 'http://127.0.0.1:9000'
url.pathname !== '/v1/chat/completions'
```

这是对应位置的修改示例，不是把后两行作为独立代码追加到文件末尾。应编辑原有条件，保留其他校验项和逻辑。

如果新 Base URL 是 `https://llm.example.com/openai/v1`，三处应对应为：

| 项目 | 新值 |
| --- | --- |
| `base` | `https://llm.example.com/openai/v1` |
| `url.origin` 允许值 | `https://llm.example.com` |
| `url.pathname` 允许值 | `/openai/v1/chat/completions` |

使用实际域名，不要直接照搬示例。改成远程 API 后，仍然是“指定 API 专用”，但**不再是仅本机推理**。如果仍要求本机模型，就继续使用回环地址，并检查本地代理的后端路由。

注意：

- Base URL 不要以 `/` 结尾，不要含 `/chat/completions`。
- 本补丁仅支持 OpenAI Chat Completions 路径，不是只改 URL 就能兼容 Responses 或 Anthropic Messages。
- URL 不允许用户名、密码、查询字符串或片段。密钥应放在模型认证配置中。
- `localhost`、`127.0.0.1`、不同端口属于不同 origin，要在策略与界面中保持一致。
- 无论地址怎样变更，都保留禁止重定向、禁止推理系统代理和禁止模型回退的逻辑。

## 4. 更换模型

编辑 `policy.cjs` 开头：

```javascript
const model = '你的接口返回的精确模型ID';
```

保留：

```javascript
const id = 'custom-local:' + model;
```

随后在 WorkBuddy 中注册同名自定义模型、设置相同 Base URL 和对应密钥。不要修改 `custom-local:` 前缀逻辑，也不要把它传给实际 API；请求 JSON 的 `model` 必须是原始模型 ID。

`smoke.cjs` 的 local 模式现在直接读取 `policy.id`，无需另外手改它的默认模型。`auto` 和 `cloud` 模式是故意传入其他选择来测试强制路由。

更换模型时还要检查后端是否支持 WorkBuddy 所需的工具调用、流式响应和上下文长度。本项目不会为不支持工具调用的模型自动补上该能力。

## 5. 同步测试用例

`test.cjs` 中有明确的“不允许”样例，例如端口 `5000`、模型 `gpt-5.5` 和 `hy3`。如果你把其中某项改成新的允许目标，必须将对应的拒绝样例换成另一个确实不允许的值，否则测试会正确地报告预期冲突。

例如只改为端口 9000，现有 5000 拒绝样例仍有效；如果改为 5000，就将该拒绝样例改成 8317 或其他非允许端口。

```powershell
npm test
```

测试名称中的 Qwen 只是历史命名，但断言内容仍需与你的新策略一致。当前默认策略和 README 验证结果只适用于原始 Qwen 配置，不代表新模型已经经过实测。

## 6. 已安装补丁时的完整更换顺序

严格按以下顺序，避免失去旧备份或把新策略叠加到旧补丁：

1. 保存当前任务并正常退出 WorkBuddy，按安装文档检查进程。
2. **保持旧 `backupDir` 不变**，执行 `node patch.cjs restore`，先恢复原始程序。
3. 把旧 `staged/`、`manifest.json` 和旧路径设置移到一个独立的本机归档目录中，保留旧备份目录，不删除它。
4. 在 WorkBuddy 中配置新的自定义模型 / API，保存后再次完全退出。此时是未补丁状态，不要在该过渡阶段开始普通推理会话。
5. 修改 `policy.cjs` 的模型、Base URL、origin 和必要的 pathname；同步拒绝样例并运行 `npm test`。
6. 在 `paths.local.json` 中设置一个**尚不存在**的新 `backupDir`，如 `.workbuddy/local-qwen-program-backup-api9000`。如设置过 `WORKBUDDY_BACKUP_DIR`，也需同步，避免它覆盖 JSON。
7. 依次运行以下命令，然后启动 WorkBuddy。

```powershell
node patch.cjs prepare
node patch.cjs install
npm run test:installed
node smoke.cjs local
node smoke.cjs auto
node smoke.cjs cloud
node smoke.cjs search
```

归档只涉及本仓库内指定生成文件，建议用文件管理器明确选择并移动到 `archives/本次标识/`，不要用清空整个仓库的命令。`archives/` 被 Git 忽略。如果复制旧 `paths.local.json` 到归档，复制后在根目录保留/编辑新设置，不要让脚本意外退回默认路径。

第一次安装时还没有旧补丁，不需要 restore；直接完成模型设置、策略修改和路径配置后，按安装文档 prepare/install。

## 7. 验收与限制

检查实际响应模型、助手回复、搜索工具结果及完整测试，而不是只看界面标签。必要时查看你自己 API 服务的脱敏访问记录，确认请求到达新地址。

如果 API 不可用，应报错而不是改走云端。补丁不控制代理服务内部的模型别名、负载均衡和回退；要满足“只能本地模型”，服务端也必须保证该模型不会被映射到云端。

更换后如需回滚该次程序补丁，使用新备份目录；如果还要退回旧 API 策略，应先恢复原始程序，再选择并验证对应旧版本的生成文件，或从旧策略源码重新生成。不要混用不同轮次的 manifest、staged 和 backup。
