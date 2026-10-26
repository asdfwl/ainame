# AI 起名 · Vercel Node 网页应用

智能起名工具，底层大模型**四选一**：**DeepSeek**、**Kimi（Moonshot）**、**豆包（火山方舟）**、**通义千问（阿里云百炼）**。

- 前端页面：输入姓氏、性别、风格、寓意需求 → 一键生成 **3 组名字方案 + 寓意解析**
- **流式输出**：AI 生成结果通过 SSE 实时打字机式推送
- **多模型切换**：前端**下拉框**直接选择模型，后端 `modelConfigMap` 集中登记、一套共用调用代码
- **Supabase 持久化**：自动保存「用户需求 + 生成结果 + 模型名」
- **密钥安全**：所有密钥从环境变量读取，零硬编码

## 目录结构

```
ainame-task/
├── package.json          # 依赖与脚本
├── vercel.json           # Vercel 配置（Node20 + 函数流式）
├── .env.example          # 环境变量模板
├── .gitignore
├── api/
│   └── generate.js       # 核心 Serverless 函数：modelConfigMap 多模型 + 流式 + 落库 Supabase
├── public/
│   ├── index.html        # 页面结构（含模型下拉框）
│   ├── style.css         # 样式
│   └── app.js            # 前端：采集表单 + 模型选择 + 消费 SSE 流渲染
├── supabase/
│   └── schema.sql        # Supabase 建表 SQL（在 SQL Editor 执行）
└── README.md
```

## 运行前提

| 资源 | 用途 | 获取方式 |
|------|------|----------|
| DeepSeek API Key | 调用 DeepSeek 起名 | https://platform.deepseek.com → API Keys |
| Moonshot API Key | 调用 Kimi 起名 | https://platform.moonshot.cn/console/api-keys |
| 火山方舟 API Key | 调用豆包起名 | https://console.volcengine.com/ark → API Key |
| 通义千问 API Key | 调用通义千问起名 | https://bailian.console.aliyun.com → API-KEY |
| Supabase 项目 | 存储起名记录 | https://supabase.com → New Project |

## 一、建表（Supabase）

1. 登录 Supabase，进入你的项目 → **SQL Editor**
2. 粘贴 `supabase/schema.sql` 全部内容 → **Run**
3. 完成后会生成表 `public.name_generations`

> 表结构说明（详见 `supabase/schema.sql`）：
> `surname / gender / style / keywords / requirements`（用户输入）、
> `result`（AI 完整输出）、`model`（所用模型）、`created_at`、`raw_response`（预留）。
> 默认开启 RLS 并提供「匿名 INSERT」策略，配合 anon key 使用；生产建议改用 Service Role Key。

## 二、配置环境变量

本地开发：复制 `.env.example` 为 `.env`，填入真实值。

线上部署（Vercel）：
1. 把代码推送到 GitHub 仓库
2. Vercel → **Add New Project** → 导入该仓库
3. **Settings → Environment Variables** 添加：
   | 变量名 | 必填 | 说明 |
   |--------|------|------|
   | `LLM_PROVIDER` | 否 | 默认模型兜底（deepseek / kimi / doubao / qwen） |
   | `DEEPSEEK_API_KEY` | 四选一 | DeepSeek 密钥 |
   | `MOONSHOT_API_KEY` | 四选一 | Kimi（Moonshot）密钥 |
   | `DOUBAO_API_KEY` | 四选一 | 火山方舟（豆包）密钥 |
   | `QWEN_API_KEY` | 四选一 | 通义千问（阿里云百炼）密钥 |
   | `MOONSHOT_MODEL` / `DOUBAO_MODEL` / `DEEPSEEK_MODEL` / `QWEN_MODEL` | 否 | 覆盖默认模型 |
   | `SUPABASE_URL` | ✅ | Supabase 项目 URL |
   | `SUPABASE_ANON_KEY` 或 `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase 密钥（二选一） |
4. 点击 **Deploy**

> 模型选择由**前端下拉框**传给后端 `body.provider`，优先级：下拉框选择 > 环境变量 `LLM_PROVIDER` > 默认 `deepseek`。

> 框架无需额外选择（本项目是纯 Node，未用 Next.js）；Vercel 会自动识别 `api/` 目录为 Serverless 函数、`public/` 为静态资源，并按 `vercel.json` 启用流式。

## 三、本地运行

```bash
cd ainame-task
npm install
npm run dev          # 等价于 vercel dev，启动 http://localhost:3000
```

打开浏览器访问 `http://localhost:3000`，填写需求即可测试。

## 四、接口说明

### `POST /api/generate`

请求体（JSON）：

```json
{
  "provider": "deepseek",
  "surname": "李",
  "gender": "男孩",
  "style": "古典文雅",
  "requirements": "希望孩子平安健康、前程似锦",
  "keywords": "梓,轩",
  "count": 3
}
```

> `provider` 可选：`deepseek` / `kimi` / `doubao` / `qwen`（由前端下拉框自动带上）。

响应为 **SSE（text/event-stream）**，事件格式 `data: {...}`：

| type | 含义 |
|------|------|
| `ready` | 连接就绪，附带 `model` |
| `content` | 新增文本片段，字段 `text` |
| `done` | 流结束 |
| `error` | 出错信息 |

### 大模型调用（modelConfigMap 统一管理，一套共用代码）

所有可切换模型集中在 `modelConfigMap` 登记（端点、密钥环境变量、默认模型），`resolveProvider(provider)` 解析前端下拉框选择的 provider，随后走**同一套** `fetch` 流式调用：

```js
// ===== 模型配置中心 =====
const modelConfigMap = {
  kimi:     { label: 'Kimi（Moonshot）',   endpoint: 'https://api.moonshot.cn/v1/chat/completions',
              envKey: 'MOONSHOT_API_KEY', modelEnv: 'MOONSHOT_MODEL', defaultModel: 'kimi-k3.1-pro' },
  doubao:   { label: '豆包（火山方舟）',    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
              envKey: 'DOUBAO_API_KEY',   modelEnv: 'DOUBAO_MODEL',   defaultModel: 'doubao-seed-2-1-pro-260915' },
  deepseek: { label: 'DeepSeek',           endpoint: 'https://api.deepseek.com/v1/chat/completions',
              envKey: 'DEEPSEEK_API_KEY', modelEnv: 'DEEPSEEK_MODEL', defaultModel: 'deepseek-chat' },
  qwen:     { label: '通义千问（阿里云百炼）', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
              envKey: 'QWEN_API_KEY',     modelEnv: 'QWEN_MODEL',     defaultModel: 'qwen-plus' },
};

// ===== 共用调用代码（对四个模型完全一致）=====
await fetch(conf.endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conf.apiKey}` },
  body: JSON.stringify({ model: conf.model, stream: true,
    messages: [ { role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: buildUserContent(input) } ] }),
});
```

## 五、数据落库（对应需求）

流结束后，服务端将以下内容写入 `name_generations` 表：

- 用户需求：`surname / gender / style / keywords / requirements`
- 生成结果：`result`（完整流式文本）
- 模型：`model`（当前生效模型的名称，如 `kimi-k3.1-pro` 或豆包模型 ID）

```js
await supabase.from('name_generations').insert({
  surname, gender, style, keywords, requirements,
  result: fullText, model: conf.model,
});
```

## 六、安全说明

- 所有密钥仅存在于 Vercel 环境变量，前端代码不含任何密钥
- `.env` 已被 `.gitignore` 忽略，不会进入版本库
- 落库失败不影响起名主流程（仅记录日志）
- 建议对模型输出做长度与敏感内容兜底校验（服务端已限制 `count` 1–5）
