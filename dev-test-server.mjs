/**
 * 本地免登录测试服务器（临时验证用）
 *
 * 用途：在没有 Vercel 登录凭证时，直接挂载 api/generate.js，
 *       用 .env 的真实密钥验证「流式出名字 + Supabase 落库」完整链路。
 *
 * 运行：node dev-test-server.mjs   →  http://localhost:3000/api/generate
 *
 * 说明：仅用于本地联调，正式开发/部署请用 `vercel dev`（需 vercel login）。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';

const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

// ---- 读取 .env 注入 process.env ----
fs.readFileSync(new URL('.env', import.meta.url), 'utf8')
  .split('\n')
  .forEach((l) => {
    const i = l.indexOf('=');
    if (i > 0 && !l.trim().startsWith('#')) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  });

const { default: handler } = await import('./api/generate.js');

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && (req.url === '/api/generate' || req.url === '/api/generate/')) {
    // 收集请求体
    let raw = '';
    for await (const chunk of req) raw += chunk;
    req.body = raw;

    // 补充 handler 依赖的 res.status(...).json(...)（原生 http 没有该方法）
    res.status = (code) => ({
      json: (obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      },
    });

    await handler(req, res);
    return;
  }

  // ---- 静态页面（预览用）----
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found（仅支持 POST /api/generate 与 public/ 静态文件）');
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`[dev-test-server] 页面预览：http://localhost:${PORT}/`);
  console.log(`[dev-test-server] 接口测试：http://localhost:${PORT}/api/generate`);
  console.log(`[dev-test-server] 当前模型提供商：${process.env.LLM_PROVIDER}`);
});
