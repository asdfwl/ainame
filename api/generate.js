import { createClient } from '@supabase/supabase-js';

/**
 * AI 起名 · Vercel Serverless 函数（多模型切换版）
 *
 * 职责：
 *  1. 接收前端 POST 请求（起名需求 + 用户选定的 provider）
 *  2. 用一套共用调用代码，流式调用所选大模型（doubao / deepseek / qwen / kimi），
 *     把增量结果以 SSE（text/event-stream）推给前端
 *  3. 流结束后把「用户需求 + 生成结果 + 模型名」写入 Supabase
 *
 * 密钥全部从环境变量读取（Vercel 项目 Settings → Environment Variables），零硬编码。
 */

// ============================================================
// 模型配置中心：所有可切换模型都在这里登记
//   provider  前端下拉框 value
//   label     前端展示名
//   endpoint  OpenAI 兼容的 /chat/completions 地址
//   envKey    读取密钥的环境变量名
//   defaultModel 默认模型
// ============================================================
const modelConfigMap = {
  kimi: {
    label: 'Kimi（Moonshot）',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    envKey: 'MOONSHOT_API_KEY',
    modelEnv: 'MOONSHOT_MODEL',
    defaultModel: 'kimi-k3.1-pro',
  },
  doubao: {
    label: '豆包（火山方舟）',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    envKey: 'DOUBAO_API_KEY',
    modelEnv: 'DOUBAO_MODEL',
    defaultModel: 'doubao-seed-2-1-pro-260915',
  },
  deepseek: {
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    envKey: 'DEEPSEEK_API_KEY',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-chat',
  },
  qwen: {
    label: '通义千问（阿里云百炼）',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    envKey: 'QWEN_API_KEY',
    modelEnv: 'QWEN_MODEL',
    defaultModel: 'qwen-plus',
  },
};

const DEFAULT_PROVIDER = 'deepseek';

const SYSTEM_PROMPT = `你是专业的姓名起名专家，精通中文姓名的音、形、义、五行与寓意。
请根据用户提供的需求，给出 3 组起名方案。
要求：
1. 每组方案包含：名字、读音、五行、寓意解释、适合理性分析。
2. 名字要朗朗上口、避免生僻字与谐音歧义，寓意积极向上、贴合用户期望。
3. 用清晰的小标题分组展示，例如：方案一、方案二、方案三。
4. 语气亲切、专业，输出使用简体中文。`;

/** 拼接用户请求内容 */
function buildUserContent(input) {
  const parts = [];
  if (input.surname) parts.push(`姓氏：${input.surname}`);
  if (input.gender) parts.push(`性别：${input.gender}`);
  if (input.nameType) parts.push(`类型：${input.nameType}`);
  if (input.style) parts.push(`风格偏好：${input.style}`);
  if (input.keywords) parts.push(`希望融入的关键字：${input.keywords}`);
  if (input.requirements) parts.push(`寓意/补充需求：${input.requirements}`);
  parts.push(`请给出 ${input.count || 3} 组起名方案。`);
  return parts.join('\n');
}

/**
 * 解析本次请求要使用哪个模型。
 * 优先级：前端 body.provider（下拉框选择） > 环境变量 LLM_PROVIDER > 默认 DEFAULT_PROVIDER。
 * 返回 { provider, label, endpoint, apiKey, model }；缺失密钥时 apiKey 为 ''。
 */
function resolveProvider(providerName) {
  const requested = (providerName || '').toLowerCase();
  let key = modelConfigMap[requested]
    ? requested
    : modelConfigMap[(process.env.LLM_PROVIDER || '').toLowerCase()]
      ? (process.env.LLM_PROVIDER || '').toLowerCase()
      : DEFAULT_PROVIDER;

  if (!modelConfigMap[key]) key = DEFAULT_PROVIDER;
  const cfg = modelConfigMap[key];

  return {
    provider: key,
    label: cfg.label,
    endpoint: cfg.endpoint,
    apiKey: process.env[cfg.envKey] || '',
    model: process.env[cfg.modelEnv] || cfg.defaultModel,
  };
}

export default async function handler(req, res) {
  // ---- 仅允许 POST ----
  if (req.method !== 'POST') {
    res.status(405).json({ error: '仅支持 POST 请求' });
    return;
  }

  // ---- 解析请求体 ----
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    res.status(400).json({ error: '请求体不是合法的 JSON' });
    return;
  }

  const input = {
    surname: (body.surname || '').trim(),
    gender: (body.gender || '').trim(),
    nameType: (body.nameType || '').trim(),
    style: (body.style || '').trim(),
    keywords: (body.keywords || '').trim(),
    requirements: (body.requirements || '').trim(),
    count: Math.min(Math.max(parseInt(body.count, 10) || 3, 1), 5),
  };

  // 至少要有一点需求内容
  if (!input.requirements && !input.keywords && !input.surname) {
    res.status(400).json({ error: '请至少填写姓氏或起名需求' });
    return;
  }

  // ---- 解析模型提供商（前端下拉框选择，优先级最高）----
  const conf = resolveProvider(body.provider);
  if (!conf.apiKey) {
    res.status(500).json({ error: `服务端未配置 ${modelConfigMap[conf.provider].envKey}（模型 ${conf.provider} 的密钥）` });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  // ---- 切换到 SSE 流式响应 ----
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // 通知前端连接就绪，并回显当前模型
  res.write(`data: ${JSON.stringify({ type: 'ready', provider: conf.provider, label: conf.label, model: conf.model })}\n\n`);

  const controller = new AbortController();
  // 客户端断开时取消上游请求
  req.on('close', () => controller.abort());

  /** 累计纯文本内容（用于入库） */
  let fullText = '';

  try {
    // ============ 一套共用调用代码 ============
    const upstream = await fetch(conf.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${conf.apiKey}`,
      },
      body: JSON.stringify({
        model: conf.model,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserContent(input) },
        ],
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      res.write(`data: ${JSON.stringify({ type: 'error', message: `上游 API 错误 ${upstream.status}: ${errText}` })}\n\n`);
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // 按行处理，避免 SSE 事件被截断
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        let json;
        try {
          json = JSON.parse(payload);
        } catch (e) {
          continue; // 忽略不完整/非法片段
        }

        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          res.write(`data: ${JSON.stringify({ type: 'content', text: delta })}\n\n`);
        }
      }
    }

    // 冲刷剩余缓冲
    if (buffer.trim().startsWith('data: ')) {
      const payload = buffer.trim().slice(6).trim();
      if (payload !== '[DONE]') {
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            res.write(`data: ${JSON.stringify({ type: 'content', text: delta })}\n\n`);
          }
        } catch (e) { /* ignore */ }
      }
    }

    // 通知前端流结束
    res.write(`data: ${JSON.stringify({ type: 'done', provider: conf.provider, model: conf.model })}\n\n`);
    res.end();

    // ---- 落库（不阻塞响应，失败仅记录日志）----
    if (supabaseUrl && supabaseKey) {
      try {
        const supabase = createClient(supabaseUrl, supabaseKey, {
          auth: { persistSession: false },
        });
        const { error } = await supabase.from('name_generations').insert({
          requirements: [
            input.requirements,
            input.keywords && `关键字:${input.keywords}`,
            input.style && `风格:${input.style}`,
          ].filter(Boolean).join('；'),
          surname: input.surname,
          gender: input.gender,
          name_type: input.nameType,
          style: input.style,
          keywords: input.keywords,
          result: fullText,
          model: conf.model,
          raw_response: { provider: conf.provider, label: conf.label },
        });
        if (error) console.error('[Supabase 写入失败]', error.message);
      } catch (err) {
        console.error('[Supabase 客户端异常]', err);
      }
    } else {
      console.warn('[Supabase] 未配置 SUPABASE_URL / SUPABASE_ANON_KEY，跳过落库');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      res.write(`data: ${JSON.stringify({ type: 'error', message: '连接已中断' })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    }
    try { res.end(); } catch (e) { /* already closed */ }
  }
}
