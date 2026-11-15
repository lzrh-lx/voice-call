/**
 * dsh-voice-call —— 宿主侧插件。
 *
 * 设计取自本仓库已有的 sense-now：**不要往会话里推消息**（`sessionController.prompt`
 * 会让模型自己唤醒自己），而是注册一个**阻塞式工具**，把语音里产生的请求作为
 * 「工具返回值」交给 agent —— 这样工作就发生在对话窗口里，看得见、可追踪。
 *
 * 数据流：
 *   悬浮球（client）──POST /task──> 本插件队列 ──> voice_call 工具返回 ──> agent 在对话里执行
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const name = 'dsh-voice-call';
export const inject = ['sessionController', 'tools'];

const PORT = Number(process.env.DSH_VOICE_CALL_PORT) || 8799;
const ENGINE_PORT = Number(process.env.DSH_VOICE_CALL_ENGINE_PORT) || 8800;
const HOST_STARTED_AT = Date.now();   // 多实例时用它挑最新的一个
// 语音引擎的会话令牌：只有本插件转发出去，浏览器端凭它连引擎
const ENGINE_TOKEN = crypto.randomBytes(16).toString('hex');
const ENGINE_DIR = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'engine');
const ENGINE_CWD = process.env.DSH_VOICE_CALL_PROJECT
  || path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace');

let engineProc = null;
let engineState = 'stopped';
let enginePort = 0;       // 引擎实际监听的端口（可能因占用而递增）

/** 启动内置语音引擎（就是已经跑通的 voice-call sidecar） */
function startEngine() {
  if (engineProc) return;
  const entry = path.join(ENGINE_DIR, 'server', 'index.mjs');
  if (!fs.existsSync(entry)) {
    engineState = 'missing: ' + entry;
    console.error('[voice-call] 找不到语音引擎:', entry);
    return;
  }
  engineState = 'starting';
  engineProc = spawn(process.execPath, [entry], {
    cwd: ENGINE_DIR,
    env: {
      ...process.env,
      VOICE_CALL_TOKEN: ENGINE_TOKEN,
      VOICE_CALL_PORT: String(ENGINE_PORT),
      VOICE_CALL_PROJECT_DIR: ENGINE_CWD,
      // 语音说「帮我干活」时，任务投到本插件的 /task
      VOICE_CALL_BRIDGE: `http://127.0.0.1:${PORT}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  engineProc.stdout.on('data', (d) => {
    const t = d.toString();
    process.stdout.write('[engine] ' + t);
    const m = t.match(/127\.0\.0\.1:(\d+)\/ball\.html/);
    if (m) {
      enginePort = Number(m[1]);
      engineState = 'ready';
      console.log(`[voice-call] 引擎实际端口: ${enginePort}`);
    }
  });
  engineProc.stderr.on('data', (d) => process.stderr.write('[engine] ' + d.toString()));
  engineProc.on('exit', (code) => {
    engineState = 'exited:' + code;
    engineProc = null;
    console.error('[voice-call] 引擎退出，code=', code);
  });
}
const OUT_DIR = path.join(os.homedir(), '.dsh', 'voice-call');
const OUT_FILE = path.join(OUT_DIR, 'probe.json');

// 语音侧的请求队列：工具阻塞等待，client 投递时立刻唤醒
const pending = [];
const waiters = [];

function writeProbe(data) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const prev = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : {};
    fs.writeFileSync(OUT_FILE, JSON.stringify({ ...prev, ...data, at: new Date().toISOString() }, null, 2));
  } catch { /* 诊断失败不影响主流程 */ }
}

function serviceOf(ctx, key) {
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch { /* 未声明 inject */ }
  try { return ctx?.[key] ?? null; } catch { return null; }
}

// 每个会话已朗读到的位置（afterSeq），避免重复朗读
const spokenSeq = new Map();
let rawOutputLogged = false;

/** 从会话记录里抠出 assistant 的文本（真实结构：records[].event.data.message.content[]） */
function textOfRecords(output) {
  const list = Array.isArray(output) ? output
    : (output?.records || output?.items || output?.messages || []);
  const items = [];   // [{seq, text}]
  let maxSeq = 0;
  const takeContent = (content, out, seq) => {
    if (!Array.isArray(content)) return;
    const t = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (t) out.push({ seq: typeof seq === 'number' ? seq : 0, text: t });
  };
  for (const r of list) {
    if (!r) continue;
    const ev = r.event || r;
    if (typeof ev.seq === 'number' && ev.seq > maxSeq) maxSeq = ev.seq;
    const msg = ev.data?.message || ev.message || r.message;
    if (msg && msg.role && msg.role !== 'assistant') continue;
    if (msg) takeContent(msg.content, items, ev.seq);
    else if (typeof ev.text === 'string' && ev.text.trim()) items.push({ seq: ev.seq || 0, text: ev.text.trim() });
  }
  items.sort((a, b) => a.seq - b.seq);
  return { items, maxSeq };
}

/** 把一条文本作为「用户消息」注入会话（等价于在输入框打字发送） */
async function injectPrompt(ctx, text, sessionId) {
  const sc = serviceOf(ctx, 'sessionController');
  if (!sc || typeof sc.prompt !== 'function') return { ok: false, reason: 'no prompt()' };
  const sid = sessionId || await currentSessionId(sc);
  if (!sid) return { ok: false, reason: 'no session' };
  const ac = new AbortController();
  try {
    await sc.prompt({
      requestId: `vc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }, ac.signal);
    return { ok: true, sessionId: sid };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e), sessionId: sid };
  }
}

/** 取当前项目里最近的会话 id（工具被调用时的活动会话就是最新那条） */
async function currentSessionId(sc) {
  try {
    const rows = await (sc.list ? sc.list({}) : sc['session/list']?.({}));
    const list = Array.isArray(rows) ? rows : (rows?.sessions || rows?.items || []);
    const sorted = [...list].sort((a, b) =>
      String(b.updatedAt || b.updated_at || '').localeCompare(String(a.updatedAt || a.updated_at || '')));
    return sorted[0]?.sessionId || sorted[0]?.id || null;
  } catch { return null; }
}

/** 读出 agent 自上次朗读以来的新回复（非阻塞，短超时） */
async function readNewAssistantText(ctx, sessionId) {
  const sc = serviceOf(ctx, 'sessionController');
  if (!sc || !sessionId || typeof sc.wait !== 'function') return null;
  try {
    const afterSeq = spokenSeq.get(sessionId);
    const res = await sc.wait({
      sessionId,
      timeoutMs: 60,
      maxMessages: 5,
      ...(afterSeq ? { afterSeq } : {})
    });
    if (!rawOutputLogged) {
      rawOutputLogged = true;
      writeProbe({ waitSample: JSON.stringify(res).slice(0, 1200) });
    }
    const { items, maxSeq } = textOfRecords(res?.output);
    if (maxSeq) spokenSeq.set(sessionId, maxSeq);
    else if (afterSeq === undefined) spokenSeq.set(sessionId, 0);
    return items.length ? items[items.length - 1].text : null;
  } catch (e) {
    writeProbe({ waitError: String(e?.message ?? e) });
    return null;
  }
}

let callActive = false;
let speakerRunning = false;
let callPersonaId = '';
let memoryInjected = false;

async function speakText(text) {
  if (!text || !enginePort) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${enginePort}/speak?token=${ENGINE_TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) console.error('[voice-call] 朗读失败:', d.reason || 'unknown');
    return !!d.ok;
  } catch (e) {
    console.error('[voice-call] 朗读请求失败:', e.message);
    return false;
  }
}

/**
 * 通话期间的后台朗读器：不依赖模型再调一次工具，
 * 只要 agent 在对话里写了新回复，就立刻念出来。
 */
async function runSpeaker(ctx) {
  if (speakerRunning) return;
  speakerRunning = true;
  const sc = serviceOf(ctx, 'sessionController');
  try {
    const sid = await currentSessionId(sc);
    if (!sid) return;
    // 基线：先把已有历史标记为「已念过」，避免一开始就朗读旧内容
    try {
      const base = await sc.wait({ sessionId: sid, timeoutMs: 1 }, new AbortController().signal);   // 不限条数，取真正的最大 seq
      if (!rawOutputLogged) { rawOutputLogged = true; writeProbe({ waitSample: JSON.stringify(base).slice(0, 1500) }); }
      const { maxSeq } = textOfRecords(base?.output);
      spokenSeq.set(sid, maxSeq || 0);
    } catch { spokenSeq.set(sid, 0); }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    console.log('[voice-call] 朗读器启动，会话', sid);
    while (callActive) {
      let res;
      try {
        res = await sc.wait({
          sessionId: sid,
          timeoutMs: 400,
          maxMessages: 10,
          afterSeq: spokenSeq.get(sid) || 0
        }, new AbortController().signal);
      } catch (e) {
        writeProbe({ waitError: String(e?.message ?? e) });
        await sleep(800);
        continue;
      }
      const { items, maxSeq } = textOfRecords(res?.output);
      if (maxSeq) spokenSeq.set(sid, maxSeq);
      if (items.length) {
        const text = items[items.length - 1].text;   // 只念最终那条，避免和对话显示不一致
        console.log('[voice-call] 朗读 agent 回复:', text.slice(0, 60));
        const spoke = await speakText(text);
        writeProbe({ lastSpoken: { at: new Date().toISOString(), text: text.slice(0, 300), spoke } });
      }
      // 关键：wait() 可能立即返回，必须让出时间片，否则会把事件循环打死
      await sleep(120);
    }
  } finally {
    speakerRunning = false;
  }
}

/** 语音侧送来一条请求：有人等着就直接给，没人等就排队 */
function pushTask(text, meta = {}) {
  const item = { text, at: new Date().toISOString(), ...meta };
  const w = waiters.shift();
  if (w) { w(item); return 'delivered'; }
  pending.push(item);
  return 'queued';
}

function takeTask() {
  return pending.shift() || null;
}

/** 通话结束：把还在等待的工具调用立刻唤醒，告诉模型不用再等了 */
function endCall() {
  pending.length = 0;
  const ws = waiters.splice(0, waiters.length);
  for (const w of ws) w({ ended: true, text: '' });
}

/** 等一条语音请求，最多等 seconds 秒；run.signal 被取消时立刻结束 */
function waitTask(seconds, signal) {
  const queued = takeTask();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve) => {
    let timer = null;
    const done = (v) => {
      clearTimeout(timer);
      const i = waiters.indexOf(done);
      if (i >= 0) waiters.splice(i, 1);
      resolve(v);
    };
    waiters.push(done);
    timer = setTimeout(() => done(null), Math.max(1, seconds) * 1000);
    try {
      signal?.addEventListener?.('abort', () => done(null), { once: true });
    } catch { /* 无 signal */ }
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

function json(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  });
  res.end(JSON.stringify(body));
}

/** 工具契约：parameters 是「属性名 → 值 schema」的映射，不是完整 JSON Schema */
function voiceCallToolSpec() {
  return {
    name: 'voice_call',
    description:
      '语音通话：把用户说的话带回来。\n\n'
      + '用法：\n'
      + '1. 调用 `voice_call()` —— 阻塞等待用户在电话里说话，返回值就是他说的内容。\n'
      + '2. **把回答直接写在回复正文里**（就像平时聊天一样）。插件会自动朗读你的正文。\n'
      + '3. 然后立刻再调用一次 `voice_call()` 继续听下一句。\n\n'
      + '注意：正文会被朗读，所以不要用 markdown 标题/列表/代码块，保持口语化、两三句话。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          meta: { type: 'json' }
        }
      },
      // 工具结果在对话里的呈现（必需）
      render(args, value) {
        return [{ type: 'text', text: String(value?.text ?? '') }];
      }
    },
    // 宿主的最长挂起上限要比等待秒数大，否则整条调用会被 abort
    timeoutMs: 900_000,
    isConcurrencySafe() {
      return false; // 同一时间只允许一个语音监听
    },
  };
}

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod?.defineTool) return mod.defineTool;
  } catch { /* 退回原样注册 */ }
  return (x) => x;
}

export function apply(ctx) {
  const diag = {
    startedAt: new Date().toISOString(),
    services: {
      sessionController: !!serviceOf(ctx, 'sessionController'),
      sessions: !!serviceOf(ctx, 'sessions'),
      tools: !!serviceOf(ctx, 'tools')
    }
  };
  writeProbe({ host: diag });
  console.log('[voice-call] 宿主插件已加载', JSON.stringify(diag.services));

  // ---- 启动语音引擎 ----
  startEngine();

  // ---- 本地接口：给悬浮球用 ----
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.url.startsWith('/call-endpoint')) {
      return json(res, 200, {
        ok: engineState === 'ready' && enginePort > 0,
        state: engineState,
        wsUrl: `ws://127.0.0.1:${enginePort}/ws?token=${ENGINE_TOKEN}`,
        pageUrl: `http://127.0.0.1:${enginePort}/ball.html?token=${ENGINE_TOKEN}&embed=1`,
        httpUrl: `http://127.0.0.1:${enginePort}/api/personas?token=${ENGINE_TOKEN}`,
        project: ENGINE_CWD
      });
    }
    if (req.url.startsWith('/diag')) {
      return json(res, 200, { services: diag.services, tool: toolState.value, pending: pending.length, waiters: waiters.length });
    }
    if (req.url.startsWith('/ping')) {
      return json(res, 200, { ok: true, pid: process.pid, startedAt: HOST_STARTED_AT, port: PORT });
    }
    // 调试：把一段文本作为用户消息注入会话（等价于在输入框打字发送）
    if (req.method === 'POST' && req.url.startsWith('/prompt')) {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      const out = await injectPrompt(ctx, text, body.sessionId);
      writeProbe({ promptTest: { at: new Date().toISOString(), text, out } });
      console.log('[voice-call] prompt 测试:', JSON.stringify(out).slice(0, 400));
      return json(res, 200, out);
    }
    if (req.method === 'POST' && req.url.startsWith('/task')) {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { ok: false, reason: 'empty text' });
      callActive = true;
      runSpeaker(ctx).catch(() => {});
      writeProbe({ lastTask: { at: new Date().toISOString(), text, how: 'injecting' } });
      console.log('[voice-call] 语音输入 →', text.slice(0, 60));
      // 先响应，注入在后台进行：prompt() 会等到被受理，不能阻塞 HTTP
      (async () => {
        if (!memoryInjected) {
          memoryInjected = true;
          let digest = '';
          try {
            const r = await fetch(`http://127.0.0.1:${enginePort}/memory-digest?token=${ENGINE_TOKEN}&persona=${encodeURIComponent(callPersonaId || '')}`);
            const d = await r.json();
            digest = String(d?.text || '').trim();
          } catch { /* 无记忆 */ }
          const note = [
            digest ? '【语音通话记忆】以下是你和这位用户此前交流积累的记忆，请自然运用，不要机械复述：\n' + digest : '',
            '（背景说明，不必回复这一条）本次通过语音通话进行，我说的话会以消息形式出现；'
              + '请不要使用「向用户提问 / 选项选择」组件，用普通文字问我；尽量避免需要点击确认的操作。'
          ].filter(Boolean).join('\n\n');
          await injectPrompt(ctx, note).catch(() => {});
        }
        return injectPrompt(ctx, text);
      })()
        .then((r) => {
          writeProbe({ lastTask: { at: new Date().toISOString(), text, how: r.ok ? 'prompted' : 'fallback', reason: r.reason } });
          if (!r.ok) {
            console.log('[voice-call] prompt 注入失败，退回工具队列:', r.reason);
            pushTask(text, body.meta);
          }
        })
        .catch((e) => console.error('[voice-call] 注入异常:', e.message));
      return json(res, 200, { ok: true, how: 'injecting' });
    }
    if (req.method === 'POST' && req.url.startsWith('/call-state')) {
      const body = await readBody(req);
      if (body.active === true) {
        callActive = true;
        runSpeaker(ctx).catch((e) => console.error('[voice-call] 朗读器异常:', e.message));
        // 接通时不注入任何东西：记忆和模式提示挪到「用户第一句话」时一起注入，
        // 否则 agent 会把注入当成用户发言、接通就回一句不相干的内容。
        callPersonaId = body.personaId || '';
        memoryInjected = false;
      }
      if (body.active === false) {
        callActive = false;
        endCall();
        console.log('[voice-call] 通话已结束');
        // 配对恢复：解除通话期间的限制，避免影响后续打字对话
        injectPrompt(ctx,
          '（语音通话已结束，恢复正常模式：可以照常使用提问/选项组件等各种交互方式。）'
        ).catch(() => {});
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url.startsWith('/client-report')) {
      const body = await readBody(req);
      writeProbe({ client: body });
      return json(res, 200, { ok: true });
    }
    json(res, 404, { ok: false });
  });
  server.on('error', (e) => console.error('[voice-call] HTTP 启动失败:', e.message));
  server.listen(PORT, '127.0.0.1', () => console.log(`[voice-call] 本地接口就绪: http://127.0.0.1:${PORT}`));

  const toolState = { value: 'pending' };

  // ---- 工具：阻塞等待语音请求 ----
  const disposers = [];
  (async () => {
    const defineTool = await loadDefineTool();
    const tool = {
      ...voiceCallToolSpec(),
      async execute(args = {}, run = {}) {
        const seconds = 600;  // 固定 10 分钟，避免模型传短值导致刚接通就超时

        const item = await waitTask(seconds, run?.signal);
        if (!item) {
          return { text: `（语音来电：${seconds} 秒内没有等到用户说话。若通话仍在进行，请立即再调用一次 voice_call 继续听；若用户已挂断则会收到结束通知）`, meta: { status: 'timeout' } };
        }
        if (item.ended) {
          return { text: '（语音通话已结束：用户挂断了，不需要再等待）', meta: { status: 'ended' } };
        }
        return { text: `〔语音来电〕用户说：${item.text}`, meta: { status: 'speech', at: item.at } };
      }
    };
    try {
      toolState.value = 'disabled (prompt mode)';
      writeProbe({ tool: 'disabled (prompt mode)' });
    } catch (e) {
      console.error('[voice-call] 工具注册失败:', e?.message ?? e);
      toolState.value = 'failed: ' + String(e?.message ?? e);
      writeProbe({ tool: 'failed', error: String(e?.message ?? e) });
    }
  })();

  ctx.effect(() => () => {
    try { engineProc?.kill(); } catch { /* 已退出 */ }
    try { server.close(); } catch { /* 已关闭 */ }
    for (const d of disposers.reverse()) { try { d?.(); } catch { /* 忽略 */ } }
  });
}
