# pi-notify

[English](README.md) | **简体中文**

让 Pi 编程助手把通知发到你的手机——任务完成、任务失败、有问题在等你回答、goal 事件，以及你让助手设的提醒。
支持两种通道：[Bark](https://bark.day.app/#/en-us/?id=bark) 和 [ntfy](https://docs.ntfy.sh/config/)。

```text
Pi 跑完一个长任务  ->  pi-notify  ->  https://api.day.app/...  ->  手机震动
```

## 功能

- **两种通道**：Bark（iOS）与 ntfy（iOS、Android、桌面、网页）。在配置里选，或用 `/notify provider bark|ntfy` 切换。
- **可选加密**：Bark 的 AES-128-CBC / AES-256-GCM 请求体加密（官方 `crypto.ts` 方案），以及自建 ntfy 的 AES-256-GCM 信封，助手可以把它解回明文。
- **自动或手动**：一个总开关、一个自动开关、每个场景各自一个开关。只要 `manual` 场景开着，你随时可以让助手主动发。
- **通知场景**：任务完成 / 失败 / 中止、`ask_user_question` 在等你回答、goal 开始 / 完成 / 阻塞 / 暂停、阻塞式输入对话框、工具报错、提醒。
- **提醒与定时通知**：相对时间（`in 20m`）、绝对时间（`at 08:30`、`tomorrow 09:00`）、周期重复（`every 1d`），落盘保存，重启后仍会送达。
- **降噪**：最短运行时长、每个场景的节流、重复抑制、正文长度上限、TTL 过期丢弃。

## 安装

```bash
pi install git:github.com/voorjaar/pi-notify
```

或者让 Pi 直接指向本地目录：

```bash
pi -e /path/to/pi-notify/index.ts
```

## 开始使用

在 `~/.pi/agent/pi-notify.json` 里至少写下你要用的通道：

```json
{
  "provider": "bark",
  "bark": { "key": "your-bark-device-key" }
}
```

完整选项见 [`config.example.json`](config.example.json)。然后检查配置：

```text
/notify status
/notify test
```

也可以不开 Pi 会话直接验证送达：

```bash
node scripts/send.ts "pi-notify" "hello" info
```

## 配置

配置逐层合并，后面的层覆盖前面的层：

1. 内置默认值
2. `~/.pi/agent/pi-notify.json`
3. `<项目>/.pi/pi-notify.json`
4. `<项目>/.pi/pi-notify.local.json`（个人覆盖；`.pi/` 已被 gitignore）
5. `PI_NOTIFY_*` 环境变量

非法值会被忽略并在 `/notify status` 里报告，不会让会话启动失败。

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `provider` | `bark` | `bark` 或 `ntfy` |
| `enabled` | `true` | 总开关。关掉后什么都不发，包括手动发送。 |
| `titlePrefix` | `Pi` | 通知标题前缀；`null` 表示不加前缀。 |
| `includeSession` | `true` | 标题里附上项目名。 |
| `timeoutMs` | `8000` | 单次请求超时。 |
| `retries` | `2` | 5xx 与网络错误的重试次数（4xx 不重试）。 |
| `bark.key` / `bark.keys` | - | Bark App 里的设备密钥。多个密钥会给多台设备发送。 |
| `bark.baseUrl` | `https://api.day.app` | 自建 Bark 服务器地址。 |
| `bark.group` | `pi` | Bark 分组。 |
| `bark.sound` | `glass` | Bark 提示音。 |
| `bark.level` | `active` / `timeSensitive` / `critical` | 把我们的等级映射到 Bark 的打扰等级。 |
| `bark.callOnCritical` | `true` | critical 时带 `call=1`，可以突破勿扰模式。 |
| `bark.ttlSeconds` | `600` | `ttl`：设备离线超过这个时长就丢弃通知。 |
| `bark.encryption.enabled` | `false` | 加密请求体。 |
| `bark.encryption.algorithm` | `aes-128-cbc` | `aes-128-cbc` 或 `aes-256-gcm`。 |
| `bark.encryption.key` | - | AES-128 用 16 字符，AES-256 用 32 字符。 |
| `bark.encryption.iv` | - | AES-128-CBC 必填（16 字符）。AES-256-GCM 用随机 IV。 |
| `ntfy.server` | `https://ntfy.sh` | 服务器地址；公开 topic 不需要 token。 |
| `ntfy.topic` | - | 发布用的 topic。用公共 ntfy.sh 时选一个不易被猜到的。 |
| `ntfy.token` | - | 私有 topic 的访问令牌（`k...`）。 |
| `ntfy.user` / `ntfy.password` | - | HTTP basic 认证，用于自建服务器。 |
| `ntfy.priority` | `3` / `4` / `5` | 把我们的等级映射到 ntfy 优先级（1-5，5 为最高）。 |
| `ntfy.encryption.enabled` | `false` | 发送 AES-256-GCM 信封（需要自建 ntfy 并配置 `cache-enc-key`）。 |
| `ntfy.encryption.key` | - | 任意口令，用 PBKDF2-SHA256 派生；也可以直接给 32 字节密钥的十六进制。 |
| `auto.enabled` | `true` | 自动场景通知。 |
| `auto.scopes` | 见下表 | 每个场景各自的开关。 |
| `auto.minRunSeconds` | `20` | 只有运行时长不少于这个值才通知。 |
| `auto.throttleSeconds` | `15` | 同一场景两次通知之间的最小间隔。 |
| `auto.maxBodyChars` | `900` | 正文超过这个长度会被截断。 |
| `auto.notifyAborted` | `false` | 运行被中止时是否通知。 |
| `scheduleFile` | `~/.pi/agent/pi-notify-schedule.json` | 提醒的存储位置。 |
| `maxLateMs` | `21600000` | 到点后超过这个时长才触发的提醒会被丢弃而不是补发。 |
| `logFile` | `~/.pi/agent/pi-notify-log.jsonl` | 每次发送（包括被跳过）写一行 JSON。用 `/notify log` 查看。 |
| `logEnabled` | `true` | 关掉发送历史。 |
| `schedules` | `[]` | 预置的定时通知，例如每天一次的站会提醒。 |

场景开关（`auto.scopes`），除 `tool_error` 外默认都是 `true`：

| 场景 | 触发时机 |
| --- | --- |
| `task_complete` | 一次运行结束，且时长不少于 `minRunSeconds` |
| `task_failed` | 一次运行以 API/模型错误结束 |
| `question` | `ask_user_question` 正在等你回答 |
| `goal` | goal 开始 / 完成 / 阻塞 / 暂停 |
| `tool_error` | 某次工具调用返回错误 |
| `ui_prompt` | 某个扩展打开了阻塞式输入框 |
| `reminder` | 定时提醒到点 |
| `manual` | 你或助手明确要求的一次发送 |

环境变量覆盖（优先级高于配置文件）：`PI_NOTIFY_PROVIDER`、`PI_NOTIFY_ENABLED`、
`PI_NOTIFY_TITLE`、`PI_NOTIFY_AUTO_ENABLED`、`PI_NOTIFY_AUTO_SCOPES=question:on,goal:off`、
`PI_NOTIFY_MIN_RUN_SECONDS`、`PI_NOTIFY_THROTTLE_SECONDS`、`PI_NOTIFY_BARK_KEY`
（逗号分隔可写多台设备）、`PI_NOTIFY_BARK_BASE_URL`、`PI_NOTIFY_BARK_GROUP`、
`PI_NOTIFY_BARK_SOUND`、`PI_NOTIFY_BARK_ICON`、`PI_NOTIFY_BARK_ENCRYPT`、
`PI_NOTIFY_BARK_ENCRYPT_KEY`、`PI_NOTIFY_BARK_ENCRYPT_IV`、`PI_NOTIFY_BARK_ENCRYPT_ALGORITHM`、
`PI_NOTIFY_NTFY_SERVER`、`PI_NOTIFY_NTFY_TOPIC`、`PI_NOTIFY_NTFY_TOKEN`、`PI_NOTIFY_NTFY_USER`、
`PI_NOTIFY_NTFY_PASSWORD`、`PI_NOTIFY_NTFY_ENCRYPT`、`PI_NOTIFY_NTFY_ENCRYPT_KEY`。

## 让助手使用

直接用自然语言说：

- “20 分钟后提醒我拉伸一下”
- “构建结束后通知我”
- “每天 09:30 提醒我备份已经跑完”

助手会用 `notify` 工具（`in`、`at`、`every`、`level`、`url`、`group`、`sound`），
以及 `notify_reminders` 来列出、取消或清空已排定的通知。`notify_status` 会告诉助手当前通知是怎么配置的——
通道、开关、待发送的提醒、最近的发送记录——这样它就能告诉你通知到底会不会发出去。

## 命令

```text
/notify                        查看状态
/notify on | off               总开关（本次会话）
/notify auto on | off          自动场景通知
/notify scope <name> on|off    单个场景开关
/notify provider bark|ntfy     切换通道（本次会话）
/notify test                   发一条通知验证送达
/notify send <text>            立刻发送
/notify schedule <when> <text> 例如 /notify schedule 20m stretch
/notify list                   列出已排定的通知
/notify cancel <id>            取消一条
/notify clear                  全部取消
/notify mute [分钟]            暂停自动通知（默认 30 分钟）
/notify unmute                 恢复自动通知
/notify log [n]                最近 n 次发送记录（已发、被跳过、失败）
/notify decrypt <text>         解密一条 pi-notify 的 ntfy 信封
```

`/notify` 的改动只对当前会话生效；要长期生效请改配置文件。

## 加密

**Bark。** 扩展发出的信封与官方 Bark App 完全一致：`?c=1&zone=...` 加一段 base64 正文，
明文是 `key:body`（或 `title:body:sound:link:group:icon:call:level`），用 AES-128-CBC 或
AES-256-GCM 加密。密文会补齐到 16 字节的整数倍，这是 Bark 的要求。请在 Bark App 的
*Encryption* 里设置同样的密钥（AES-128-CBC 还需要同样的 IV）。

**ntfy。** 公共 ntfy.sh topic 走的是普通 HTTPS——知道 topic 的人都能读到内容。要真正保密，
请用配置了 `cache-enc-key` 的自建 ntfy，并把 `ntfy.encryption.enabled` 设为 `true`：
扩展会发布 `pi-notify:v1:<iv>:<tag>:<ciphertext>` 信封（AES-256-GCM，密钥由你的口令经
PBKDF2-SHA256 派生），只有持有口令的客户端能读。`/notify decrypt` 和助手都能把这种信封解回可读文本。

## 开发

```bash
node --test tests/selftest.ts
```

自测覆盖时间解析、配置分层、两种通道、两种加密路径、提醒调度以及通知开关。测试使用假通道，
不会真的发通知。

## 已知限制

- 通知只在 Pi 会话运行时触发，没有常驻守护进程。Pi 关闭期间到点的提醒会在下次会话启动时补发
  （超过 `maxLateMs` 太旧则直接丢弃）。
- 关闭加密时，单次提醒会使用 ntfy 的服务端定时（`Send At`）；周期性提醒由扩展自己调度。
- 扩展读不到你的手机，所以无法确认通知是否真的送达。
