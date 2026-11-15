// voice-call 探针 MCP server：注册内嵌面板资源 + 本地 WS 服务 + 结果回传工具
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import {
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ListToolsRequestSchema, CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, '..', 'ui');
const PROJECT_DIR = process.env.ZCODE_PROJECT_DIR || process.cwd();
const OUT_DIR = path.join(PROJECT_DIR, '.voice-call');
const OUT_FILE = path.join(OUT_DIR, 'probe.json');

const PANEL_URI = 'ui://voice-call-probe/v3/panel.html';
const ASSET_PREFIX = 'ui://voice-call-probe/v3/assets/';
const HTML_MIME = 'text/html;profile=mcp-app';

// 面板元数据：申请麦克风权限 + 放行到本地服务的 fetch/WebSocket/图片
const LOCAL_ORIGINS = Array.from({ length: 6 }, (_, i) => 8710 + i).flatMap((p) => [
  `http://127.0.0.1:${p}`,
  `ws://127.0.0.1:${p}`
]);
const PANEL_META = {
  ui: {
    permissions: { microphone: {} },
    prefersBorder: false
  },
  'zcode/csp': {
    connectDomains: LOCAL_ORIGINS,
    resourceDomains: LOCAL_ORIGINS.filter((o) => o.startsWith('http:'))
  }
};

// ---- 本地探针服务（HTTP + WS echo）----
let PORT = 8710;
const httpServer = http.createServer((req, res) => {
  // 面板可以不依赖 MCP 握手，直接 POST 诊断结果过来
  if (req.method === 'POST' && req.url.startsWith('/report')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const prev = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};
        const payload = JSON.parse(body || '{}');
        const merged = { ...prev, ...payload, updatedAt: new Date().toISOString(), port: PORT };
        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2));
        console.error('[probe] 收到诊断:', payload.stage || 'payload');
      } catch (e) {
        console.error('[probe] 诊断写入失败:', e.message);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end('{"ok":true}');
    });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
    });
    res.end();
    return;
  }
  if (req.url.startsWith('/beacon')) {
    // 面板用 <img> 打点：不依赖 fetch/CSP connect-src，用来判断 JS 是否执行
    const u = new URL(req.url, 'http://127.0.0.1');
    try {
      const prev = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};
      const beacons = Array.isArray(prev.beacons) ? prev.beacons : [];
      beacons.push({ at: new Date().toISOString(), ...Object.fromEntries(u.searchParams) });
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(OUT_FILE, JSON.stringify({ ...prev, beacons, updatedAt: new Date().toISOString() }, null, 2));
      console.error('[probe] beacon:', u.search);
    } catch { /* 忽略 */ }
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Access-Control-Allow-Origin': '*' });
    res.end(gif);
    return;
  }
  if (req.url.startsWith('/ping')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, port: PORT }));
    return;
  }
  res.writeHead(404); res.end();
});

httpServer.listen(PORT, '127.0.0.1');

// 极简 WS：完成握手后把收到的文本原样回显（只用于探测连通性）
const wss = new WebSocketServer({ server: httpServer });
// ws 会把 http server 的 error 转发到 wss 上；不接住会在端口占用时直接崩进程
wss.on('error', () => {});
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const s = data.toString();
    const text = s.includes('ping') ? 'pong' : s;
    try { ws.send(text); } catch { /* 连接已断 */ }
  });
});

let portTries = 20;
httpServer.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && portTries-- > 0) {
    PORT += 1;
    httpServer.listen(PORT, '127.0.0.1');
  } else {
    console.error('[probe] http error', e.message);
  }
});

let announced = false;
httpServer.on('listening', () => {
  if (announced) return;
  announced = true;
  console.error(`[probe] 本地探针服务: http://127.0.0.1:${PORT}`);
});

httpServer.listen(PORT, '127.0.0.1');

httpServer.listen(PORT, '127.0.0.1', () => {
  console.error(`[probe] 本地探针服务: http://127.0.0.1:${PORT}`);
});

// 记录宿主发来的每个 MCP 请求，便于排查面板为何没加载
function traceReq(kind, detail) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(path.join(OUT_DIR, 'mcp.log'), `${new Date().toISOString()} ${kind} ${detail}\n`);
  } catch { /* 忽略 */ }
}

// ---- MCP server ----
const server = new Server(
  { name: 'voice-call-probe', version: '0.0.1' },
  { capabilities: { resources: {}, tools: {} } }
);

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  traceReq('listResources', PANEL_URI);
  return {
    resources: [{ uri: PANEL_URI, name: 'panel', mimeType: HTML_MIME, _meta: PANEL_META }]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;
  traceReq('readResource', uri);
  if (uri === PANEL_URI) {
    let html = fs.readFileSync(path.join(UI_DIR, 'panel.html'), 'utf8');
    // 把打包好的面板脚本内联进去（宿主对面板只取一个 HTML 资源，外部 script 不好取）
    const bundlePath = path.join(UI_DIR, 'app.bundle.js');
    const bundle = fs.existsSync(bundlePath) ? fs.readFileSync(bundlePath, 'utf8') : 'console.error("bundle missing")';
    html = html.replace('/*__BUNDLE__*/', () => bundle);
    html = html.replaceAll('__PORT__', String(PORT)); // 端口可能在启动时递增
    return { contents: [{ uri, mimeType: HTML_MIME, text: html, _meta: PANEL_META }] };
  }
  if (uri.startsWith(ASSET_PREFIX)) {
    const name = decodeURIComponent(uri.slice(ASSET_PREFIX.length));
    const file = path.normalize(path.join(UI_DIR, name));
    if (!file.startsWith(UI_DIR) || !fs.existsSync(file)) throw new Error('unknown asset');
    const mime = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/plain';
    return { contents: [{ uri, mimeType: mime, text: fs.readFileSync(file, 'utf8') }] };
  }
  throw new Error('unknown resource');
});

const REPORT_TOOL = {
  name: 'report',
  description: '把探针结果写入项目目录（面板内部使用）',
  inputSchema: {
    type: 'object',
    properties: { results: { type: 'object' } },
    required: ['results']
  },
  _meta: { ui: { visibility: ['app'] } }
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [REPORT_TOOL] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'report') throw new Error('unknown tool');
  const results = req.params.arguments?.results || {};
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ at: new Date().toISOString(), port: PORT, results }, null, 2));
  return { content: [{ type: 'text', text: 'ok' }] };
});

await server.connect(new StdioServerTransport());
console.error('[probe] MCP 已连接');
