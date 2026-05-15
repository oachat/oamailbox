# Mailbox

基于 Cloudflare Workers 的 Telegram 双向私聊机器人。每位用户自动创建独立话题，消息完全隔离。

## 功能

- **双向通信** — 用户发消息给 Bot → 转发到超级群组对应话题；Owner 在话题回复 → 转发到用户私聊
- **引用回复** — 双向支持嵌套引用，对话上下文清晰
- **Emoji 回应** — 双向转发表情反应；🕊 表示消息已送达
- **消息编辑** — 双方编辑消息实时同步（仅文本）
- **消息删除** — 回复消息发送 `#del` 即可删除对面的转发
- **拉黑/解封** — 支持静默或通知两种模式
- **人机验证** — Cloudflare Turnstile + Telegram Mini App，防止垃圾消息
- **零成本** — Cloudflare Workers 免费额度内运行

## 架构

```
src/
├── worker.js           # 入口 + 路由
├── handlers/           # 请求处理
│   ├── webhook.js      # Telegram update 分发
│   ├── commands.js     # /start + 管理命令
│   └── verify.js       # 验证 API
├── services/           # 业务逻辑
│   ├── auth.js         # 验证流程
│   └── topic.js        # 消息转发、话题管理
└── lib/                # 工具函数
    ├── telegram.js     # Bot API 封装
    ├── crypto.js       # 签名验证
    ├── kv.js           # KV 存储操作
    └── markdown.js     # MarkdownV2 转义
```

## 部署

### 前置要求

- Cloudflare 账号
- Telegram 账号
- Node.js 18+

### 1. 创建 Bot

1. 向 [@BotFather](https://t.me/BotFather) 发送 `/newbot`
2. 记录 Bot API Token

### 2. 获取你的 UID

向 [@userinfobot](https://t.me/userinfobot) 发送任意消息，记下数字 ID。

### 3. 部署 Worker

```bash
git clone <repo-url> && cd mailbox
npm install
```

编辑 `wrangler.jsonc`：

```jsonc
{
  "name": "mailbox",
  "vars": {
    "MINIAPP_URL": "https://your-miniapp-domain.pages.dev",
    "PREFIX": "yourprefix",
    "OWNER_UID": "你的UID"
  },
  "kv_namespaces": [
    { "binding": "KV", "id": "你的KV命名空间ID" }
  ]
}
```

创建 KV 命名空间：

```bash
npx wrangler kv namespace create KV
```

设置 Secrets：

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put SECRET_TOKEN
npx wrangler secret put TURNSTILE_SECRET
```

部署：

```bash
npx wrangler deploy
```

### 4. 部署 Mini App 前端（可选，用于人机验证）

修改 `index.html` 中的 Turnstile Site Key（在 [Cloudflare Dashboard](https://dash.cloudflare.com/?to=/:account/turnstile) 创建）：

```html
<div class="cf-turnstile" data-sitekey="你的SiteKey" ...></div>
```

将 `index.html` 部署到 Cloudflare Pages：

```bash
mkdir -p /tmp/miniapp && cp index.html /tmp/miniapp/
npx wrangler pages deploy /tmp/miniapp --project-name=your-miniapp
```

### 5. 注册 Webhook

部署完成后，访问以下 URL 注册 Webhook：

```
https://your-worker.workers.dev/PREFIX/setup?token=YOUR_SECRET_TOKEN
```

### 6. 初始化私信群组

1. 创建一个群组并开启 **Topic（话题）** 功能
2. 将 Bot 加入群组并设为管理员（需要 Manage topics 权限）
3. 在群组的 **General Topic** 中发送 `.init`

完成！用户私信 Bot 时会自动创建独立话题。

## 管理命令

所有命令以 `.` 开头，仅 Owner 可用。

### General Topic 中

| 命令 | 说明 |
|------|------|
| `.init` | 初始化私信群组 |
| `.check` | 检查初始化状态 |
| `.reset` | 重置初始化 |

### 用户话题中

| 命令 | 说明 |
|------|------|
| `.ban` | 拉黑（通知对方） |
| `.unban` | 解封（通知对方） |
| `.sban` | 静默拉黑 |
| `.sunban` | 静默解封 |

### Bot 私聊中

| 命令 | 说明 |
|------|------|
| `.reset` | 重置初始化 |

## KV 数据结构

| Key | 值 | 说明 |
|-----|-----|------|
| `config:{ownerUid}` | `{superGroupChatId}` | Bot 初始化配置 |
| `user:{userId}` | `{id, verified, verifiedAt}` | 用户验证状态 |
| `pending:{userId}` | `1` / `done` | 验证状态标记（等待/完成） |
| `prompt:{userId}` | `[msgId, ...]` | 验证提示消息 ID（验证后清除） |
| `topic:from:{chatId}` | `{topicId, fromChatId, ...}` | 用户 → 话题映射 |
| `topic:id:{topicId}` | `{topicId, fromChatId, ...}` | 话题 → 用户映射 |
| `msg:pm:{chatId}:{msgId}` | `{topicId, pmChatId, ...}` | 私聊消息 → 话题消息映射 |
| `msg:topic:{topicId}:{msgId}` | `{topicId, pmChatId, ...}` | 话题消息 → 私聊消息映射 |

## 环境变量

| 变量 | 类型 | 说明 |
|------|------|------|
| `PREFIX` | var | URL 路径前缀 |
| `OWNER_UID` | var | Owner 的 Telegram UID |
| `MINIAPP_URL` | var | Mini App 页面地址（验证用） |
| `BOT_TOKEN` | secret | Bot API Token |
| `SECRET_TOKEN` | secret | Webhook 安全令牌 |
| `TURNSTILE_SECRET` | secret | Cloudflare Turnstile 密钥 |

## 注意事项

- 拉黑是单向的：对方消息不再转发到话题，但你仍可主动发消息给对方
- 消息编辑仅支持文本，图片等媒体编辑不生效
- `#del` 只能删除 Bot 转发的消息（Bot 无法删除用户自己发送的）
- 验证通过后 `pending` 标记永久保留作为 KV 最终一致性兜底
- 每位用户固定占用 3 条 KV（user + 2 条话题映射），每条消息额外占用 2 条（双向映射）
- KV 免费额度：读 10 万/天、写 1 千/天，个人使用完全够用