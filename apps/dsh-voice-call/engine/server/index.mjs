import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';
import { WebSocketServer } from 'ws';
import { loadConfig, DATA_DIR, projectDir, projectKey } from './config.mjs';
import { loadPersonas, getPersona } from './personas.mjs';
import { RealtimeProxy } from './realtime-proxy.mjs';
import { extractMemory, memoryBlock } from './memory.mjs';

// 通知宿主插件：这通电话结束了，唤醒还在等待的 agent
function notifyBridge(active, personaId) {
  const bridge = process.env.VOICE_CALL_BRIDGE;
  if (!bridge) return;
  fetch(`${bridge}/call-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ active, personaId })
  }).catch(() => { /* 宿主可能已退出 */ });
}

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

const cfg = loadConfig();
// 会话令牌：agent 每次启动传入，悬浮球必须凭 agent 给出的带令牌链接才能打开
const TOKEN = process.env.VOICE_CALL_TOKEN || crypto.randomBytes(16).toString('hex');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function gateHtml(extra) {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui,-apple-system,'PingFang SC',sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0b0f1a;color:#9ca3af">
<div style="text-align:center">
  <div style="font-size:44px">📞</div>
  <p style="font-size:17px;color:#e5e7eb;margin:16px 0 6px">${extra || '悬浮球只能通过 agent 打开'}</p>
  <p style="font-size:13px;margin:0">请在 agent 对话中说「给我的 agent 打个电话」</p>
</div>
</body>`;
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return '';
}

const server = http.createServer((req, res) => {
  // 宿主页面与引擎不同端口，属于跨源请求，必须显式放开
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-voice-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, 'http://127.0.0.1');
  const queryToken = u.searchParams.get('token') || '';
  const token = queryToken || req.headers['x-voice-token'] || readCookie(req, 'vc_token');

  if (u.pathname === '/gate') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(gateHtml());
    return;
  }
  if (u.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // 其余所有资源与接口一律校验令牌
  if (token !== TOKEN) {
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(gateHtml('令牌无效或缺失'));
    return;
  }
  if (req.method === 'POST' && u.pathname === '/speak') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on('end', async () => {
      let text = '';
      try { text = JSON.parse(body || '{}').text || ''; } catch { /* 忽略 */ }
      const p = activeProxy;
      let result;
      if (p) {
        result = await p.speak(text);
      } else if (text) {
        pendingSpeech.push(text);
        result = { ok: true, queued: true, reason: '通话尚未建立，已缓存待播' };
      } else {
        result = { ok: false, reason: 'empty text' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  if (u.pathname === '/memory-digest') {
    const pid = u.searchParams.get('persona') || 'xiaonuan';
    let text = '';
    try { text = memoryBlock(pid); } catch { /* 记忆读取失败按空处理 */ }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ persona: pid, text: String(text || '').slice(0, 1500) }));
    return;
  }
  if (u.pathname === '/api/personas') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(loadPersonas().map(p => ({ id: p.id, name: p.name, desc: p.desc || '' }))));
    return;
  }
  const rel = u.pathname === '/' ? '/ball.html' : u.pathname;
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const headers = {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    // 开发期避免浏览器缓存旧版页面/脚本，改完即生效
    'Cache-Control': 'no-store'
  };
  // 用带令牌链接首次打开页面时种同源 Cookie：ball.css/ball.js/worklet.js 等
  // 子资源请求不会带 query token，靠 Cookie 才能通过门禁
  if (queryToken) {
    headers['Set-Cookie'] = `vc_token=${encodeURIComponent(queryToken)}; Path=/; SameSite=Strict`;
  }
  if (path.extname(file) === '.html') {
    // 跨源 iframe 中第三方 Cookie 会被浏览器拦截，因此把令牌直接写进资源地址
    let html = fs.readFileSync(file, 'utf8');
    const q = `?token=${encodeURIComponent(TOKEN)}`;
    html = html
      .replace(/(href=")([^":]+?\.css)(")/g, `$1$2${q}$3`)
      .replace(/(src=")([^":]+?\.js)(")/g, `$1$2${q}$3`);
    res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});

// ---- WebSocket：悬浮球 ↔ sidecar ----
const wss = new WebSocketServer({ server });
// ws 会把 http server 的 error 转发到 wss 上；不接住会直接崩进程（端口重试就失效了）
wss.on('error', () => {});
let lastActivity = Date.now();
let activeProxy = null;   // 当前通话实例（/speak 用）
let pendingSpeech = [];   // 通话尚未建立时，先缓存要念的话

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname !== '/ws' || u.searchParams.get('token') !== TOKEN) {
    ws.close(4001, 'unauthorized');
    return;
  }
  lastActivity = Date.now();

  let proxy = null;
  let persona = null;
  activeProxy = proxy;

  const send = (e) => { try { ws.send(JSON.stringify(e)); } catch { /* 连接已断 */ } };

  async function endCall() {
    if (!proxy) return;
    const p = proxy;
    proxy = null;
    if (activeProxy === p) activeProxy = null;
    const text = p.buildTranscriptText();
    const pDurationMs = Date.now() - p.startedAt;
    p.hangup();
    send({ type: 'state', phase: 'ended' });
    if (persona && text) {
      // 存档转写 → 抽取记忆（失败不影响通话流程）
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        fs.writeFileSync(
          path.join(DATA_DIR, 'transcripts', `${ts}-${persona.id}.json`),
          JSON.stringify({
            project: projectKey(),
            projectDir: projectDir(),
            scope: loadConfig().memoryScope,
            persona: persona.id,
            durationMs: pDurationMs,
            endedAt: new Date().toISOString(),
            transcript: text
          }, null, 2)
        );
      } catch { /* 存档失败不阻塞 */ }
      await extractMemory(persona.id, text);
    }
    persona = null;
    notifyBridge(false, persona?.id);
    send({ type: 'call.ended' });
  }

  ws.on('message', (raw) => {
    lastActivity = Date.now();
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'control' && msg.action === 'start_call') {
      persona = getPersona(msg.personaId);
      if (!persona) { send({ type: 'error', message: '人设不存在' }); return; }
      proxy?.hangup();
      const freshProxy = new RealtimeProxy(persona, (e) => {
        if (e.type === 'call.ready' && pendingSpeech.length) {
          const queued = pendingSpeech.splice(0, pendingSpeech.length);
          for (const t of queued) freshProxy.speak(t).catch(() => {});
        }
        send(e);
      });
      proxy = freshProxy;
      // 用户说的话就是给 agent 的问题：交给宿主，让他回答
      proxy.onUserSpeech = (text) => {
        // 扬声器回声可能被 ASR 当成用户说话：与刚念过的内容高度重合就丢弃
        const last = (proxy.lastSpokenText || '').replace(/\s/g, '');
        const cur = String(text).replace(/\s/g, '');
        if (last && cur.length > 3 && (last.includes(cur) || cur.includes(last.slice(0, Math.min(12, last.length))))) {
          console.log('[voice-call] 丢弃疑似回声转写:', text.slice(0, 40));
          return;
        }
        const bridge = process.env.VOICE_CALL_BRIDGE;
        if (!bridge) return;
        fetch(`${bridge}/task`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, meta: { from: 'voice' } })
        }).catch(() => { /* 宿主可能已退出 */ });
      };
      proxy.start();
      activeProxy = proxy;
      notifyBridge(true, persona.id);
      send({ type: 'state', phase: 'connecting', persona: { id: persona.id, name: persona.name } });
    } else if (msg.type === 'audio.append') {
      proxy?.appendAudio(msg.audio);
    } else if (msg.type === 'control' && msg.action === 'cancel_speak') {
      proxy?.cancelSpeak();
    } else if (msg.type === 'control' && msg.action === 'hangup') {
      endCall();
    }
  });

  ws.on('close', () => { endCall(); });
});

// 30 分钟无浏览器连接自动退出（正常情况下 agent 会话结束会连带退出，这是兜底）
setInterval(() => {
  if (wss.clients.size === 0 && Date.now() - lastActivity > 30 * 60 * 1000) {
    console.log('[voice-call] 长时间无连接，自动退出');
    process.exit(0);
  }
}, 60 * 1000);

// ---- 启动：端口占用则递增 ----
// 注意：不要用 listen(port, host, cb) 递归重试——失败的监听会残留 listening 回调，
// 最终成功时把每个失败端口都打印一遍。改为只注册一次 listening + 复用 error 重试。
let currentPort = cfg.port;
let attemptsLeft = 20;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && attemptsLeft > 0) {
    attemptsLeft--;
    currentPort++;
    server.listen(currentPort, '127.0.0.1');
  } else {
    console.error('[voice-call] 无法监听端口:', e.message);
    process.exit(1);
  }
});

server.once('listening', () => {
  console.log(`[voice-call] 悬浮球已就绪: http://127.0.0.1:${currentPort}/ball.html?token=${TOKEN}`);
  console.log('[voice-call] 数据目录: ' + DATA_DIR);
  console.log(`[voice-call] 当前项目: ${projectKey()}（${projectDir()}）`);
  console.log(`[voice-call] 语音引擎: ${loadConfig().provider} / 记忆范围: ${loadConfig().memoryScope}`);
});

server.listen(currentPort, '127.0.0.1');
