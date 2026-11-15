import { App } from '@modelcontextprotocol/ext-apps';

// 端口由服务端在返回 HTML 时替换
const PORT = '__PORT__';

const bootEl = document.getElementById('boot');
const boot = (m, ok = true) => {
  if (!bootEl) return;
  bootEl.textContent = m;
  bootEl.style.color = ok ? '#4ade80' : '#f87171';
};
boot('SDK bundle 已加载，准备握手…');

const rowsEl = document.getElementById('rows');
const logEl = document.getElementById('log');
const runBtn = document.getElementById('run');
const results = {};

function row(key, label) {
  const d = document.createElement('div');
  d.className = 'row';
  d.innerHTML = `<div class="k">${label}</div><div class="v" id="v-${key}">—</div>`;
  rowsEl.appendChild(d);
  return (text, cls) => {
    const el = document.getElementById('v-' + key);
    el.textContent = text;
    el.className = 'v mono ' + (cls || '');
  };
}

const set = {
  secure: row('secure', '安全上下文'),
  media: row('media', 'mediaDevices'),
  mic: row('mic', '麦克风'),
  http: row('http', '本地 HTTP'),
  ws: row('ws', '本地 WebSocket'),
  worklet: row('worklet', 'AudioWorklet'),
  pip: row('pip', 'PiP 浮窗'),
  host: row('host', '宿主信息')
};
const log = (m) => { logEl.textContent += m + '\n'; logEl.scrollTop = 1e9; };

// 用官方 SDK：它内部处理与宿主的沙箱代理握手
const app = new App(
  { name: 'voice-call-probe', version: '0.0.1' },
  { availableDisplayModes: ['inline', 'pip'] },
  { autoResize: false }
);

async function check() {
  results.secureContext = window.isSecureContext;
  results.origin = location.origin;
  results.href = location.href.slice(0, 100);
  set.secure(window.isSecureContext ? '是' : '否', window.isSecureContext ? 'ok' : 'bad');

  results.hasMediaDevices = !!navigator.mediaDevices?.getUserMedia;
  set.media(results.hasMediaDevices ? '✓ 可用' : '✗ 不存在', results.hasMediaDevices ? 'ok' : 'bad');

  // 1) 麦克风
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    results.mic = { ok: true, label: track?.label || '', settings: track?.getSettings?.() || {} };
    set.mic('✓ 已授权：' + (track?.label || '(无标签)'), 'ok');
    stream.getTracks().forEach(t => t.stop());
  } catch (e) {
    results.mic = { ok: false, name: e.name, message: e.message };
    set.mic('✗ ' + e.name + ': ' + e.message, 'bad');
  }

  // 2) 本地 HTTP
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/ping`);
    const body = await res.json();
    results.http = { ok: res.ok, body };
    set.http('✓ ' + JSON.stringify(body), 'ok');
  } catch (e) {
    results.http = { ok: false, message: e.message };
    set.http('✗ ' + e.message, 'bad');
  }

  // 3) 本地 WebSocket
  results.ws = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const t = setTimeout(() => finish({ ok: false, message: 'connect timeout' }), 5000);
      ws.onopen = () => ws.send('ping');
      ws.onmessage = (m) => { clearTimeout(t); finish({ ok: m.data === 'pong', echo: String(m.data) }); try { ws.close(); } catch { /* 忽略 */ } };
      ws.onerror = () => { clearTimeout(t); finish({ ok: false, message: 'error event' }); };
    } catch (e) { finish({ ok: false, message: e.message }); }
  });
  set.ws(results.ws.ok ? '✓ 连通，回显 ' + JSON.stringify(results.ws.echo) : '✗ ' + (results.ws.message || '无回显'), results.ws.ok ? 'ok' : 'bad');

  // 4) AudioWorklet：依次试 ui:// 资源、blob:、data:
  const code = 'class P extends AudioWorkletProcessor{process(){return true}}registerProcessor("probe-proc",P);';
  const attempts = {};
  async function tryWorklet(kind, url) {
    try {
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'probe-proc');
      attempts[kind] = { ok: !!node };
      ctx.close();
      return true;
    } catch (e) {
      attempts[kind] = { ok: false, message: e.name + ': ' + e.message };
      return false;
    }
  }
  await tryWorklet('ui', 'ui://voice-call-probe/assets/worklet.js');
  if (!attempts.ui.ok) await tryWorklet('blob', URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  if (!attempts.ui.ok && !attempts.blob?.ok) await tryWorklet('data', 'data:text/javascript,' + encodeURIComponent(code));
  results.worklet = attempts;
  const firstOk = Object.entries(attempts).find(([, v]) => v.ok);
  set.worklet(firstOk ? '✓ 可用（' + firstOk[0] + '）' : '✗ 三种方式都失败', firstOk ? 'ok' : 'bad');

  // 5) PiP 浮窗
  try {
    const r = await app.requestDisplayMode({ mode: 'pip' });
    results.pip = { ok: r.mode === 'pip', mode: r.mode };
    set.pip(r.mode === 'pip' ? '✓ 已切到浮窗' : '△ 宿主返回 ' + r.mode, r.mode === 'pip' ? 'ok' : 'warn');
    setTimeout(() => { app.requestDisplayMode({ mode: 'inline' }).catch(() => {}); }, 4000);
  } catch (e) {
    results.pip = { ok: false, message: e.message };
    set.pip('✗ ' + e.message, 'bad');
  }

  results.hostCapabilities = app.getHostCapabilities() || null;
  results.hostContext = {
    displayMode: app.getHostContext()?.displayMode,
    availableDisplayModes: app.getHostContext()?.availableDisplayModes
  };
}

(async () => {
  runBtn.disabled = true;
  runBtn.textContent = '握手…';
  try {
    boot('正在 ui/initialize…');
    await app.connect();
    const caps = app.getHostCapabilities() || {};
    const modes = (caps.availableDisplayModes || []).join('/') || '未声明';
    set.host(`已握手 · 显示模式: ${modes}`, 'ok');
    boot('✓ 握手成功');
    log('✓ ui/initialize 成功');
    runBtn.disabled = false;
    runBtn.textContent = '开始检测';
  } catch (e) {
    runBtn.textContent = '握手失败';
    boot('✗ 握手失败: ' + e.message, false);
    log('✗ 握手失败: ' + e.message);
    set.host('✗ ' + e.message, 'bad');
    return;
  }

  runBtn.onclick = async () => {
    runBtn.disabled = true;
    runBtn.textContent = '检测中…';
    try {
      await check();
      log('检测完成，正在回传…');
      await app.callServerTool({ name: 'report', arguments: { results } });
      runBtn.textContent = '已上报 ✓';
      log('结果已写入 .voice-call/probe.json');
    } catch (e) {
      runBtn.disabled = false;
      runBtn.textContent = '重试';
      log('出错: ' + e.message);
    }
  };
})();
