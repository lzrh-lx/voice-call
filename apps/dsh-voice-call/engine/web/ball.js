/* voice-call 悬浮球：拨号、通话、打断、字幕、PiP 置顶 */

const $ = (s) => document.querySelector(s);
const ball = $('#ball'), icon = $('#icon'), wave = $('#wave');
const panel = $('#panel'), picker = $('#picker'), toastEl = $('#toast');
const phaseText = $('#phaseText'), dot = $('#dot'), timerEl = $('#timer');
const liveCaption = $('#liveCaption'), transcriptEl = $('#transcript');
const btnMute = $('#btnMute'), btnText = $('#btnText'), btnHangup = $('#btnHangup'), btnPip = $('#btnPip');

const TOKEN = new URLSearchParams(location.search).get('token') || '';
const EMBED = new URLSearchParams(location.search).get('embed') === '1';

// 被宿主内嵌时，把「有没有展开面板」告诉宿主，宿主据此缩放 iframe
function notifyHost(open) {
  if (!EMBED) return;
  try { window.parent.postMessage({ source: 'voice-call', panelOpen: !!open }, '*'); } catch { /* 忽略 */ }
}
if (EMBED) {
  const panelEl = document.getElementById('panel');
  const pickerEl = document.getElementById('picker');
  const sync = () => notifyHost(!panelEl.classList.contains('hidden') || !pickerEl.classList.contains('hidden'));
  new MutationObserver(sync).observe(panelEl, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(sync).observe(pickerEl, { attributes: true, attributeFilter: ['class'] });
  notifyHost(false);
}
const PHASE_TEXT = { idle: '待机', connecting: '连接中…', incall: '通话中', ended: '已结束' };

let ws = null;
let phase = 'idle';          // idle | connecting | incall | ended
let inCallSession = false;   // 已发出 start_call、尚未挂断
let personas = [];
let currentPersona = null;
let mic = null;              // { ctx, node, analyser }
let play = null;             // { ctx, gain, analyser, next, sources }
let muted = false;
let startedAt = 0, timerId = 0;
let assistantCaption = '';

function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

function setPhase(p) {
  phase = p;
  ball.classList.remove('idle', 'connecting', 'incall', 'ended');
  ball.classList.add(p);
  phaseText.textContent = PHASE_TEXT[p] || p;
  dot.className = 'dot' + (p === 'connecting' ? ' connecting' : p === 'ended' ? ' ended' : '');
  panel.classList.toggle('hidden', p === 'idle');
  if (p === 'idle') {
    icon.textContent = '📞';
    icon.style.display = '';
    inCallSession = false;
  } else if (p === 'connecting') {
    icon.textContent = '⏳';
    icon.style.display = '';
  } else if (p === 'incall') {
    icon.style.display = 'none';
  }
}

// ---------------- WebSocket ----------------
function connectWs() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handleServer(m);
  };
  ws.onclose = () => {
    if (phase === 'incall' || phase === 'connecting') {
      setPhase('ended');
      ball.classList.add('dead');
      toast('连接断开：agent 已退出或服务已停止', 5000);
      setTimeout(() => stopCallUi(true), 1800);
    }
  };
}

function handleServer(m) {
  switch (m.type) {
    case 'call.ready':
      setPhase('incall');
      startTimer();
      break;
    case 'audio.delta':
      enqueuePlayback(m.audio);
      break;
    case 'speech.started':          // 用户插话：服务端已自动取消模型输出
      flushPlayback();
      ball.classList.add('interrupted');
      setTimeout(() => ball.classList.remove('interrupted'), 500);
      break;
    case 'transcript.assistant.delta':
      assistantCaption += m.delta;
      liveCaption.innerHTML = `<b>${currentPersona?.name || '对方'}：</b>${assistantCaption}`;
      break;
    case 'transcript.assistant.done':
      assistantCaption = '';
      addTranscript('ai', m.text);
      break;
    case 'transcript.user':
      addTranscript('me', m.text);
      break;
    case 'tool.call': {
      const label = m.purpose ? m.purpose : m.name;
      toast(`🔧 正在处理：${label}`, 6000);
      break;
    }
    case 'error':
      toast('⚠️ ' + m.message, 4200);
      if (phase === 'connecting') stopCallUi();
      break;
    case 'model.closed':
      toast('通话已断开');
      stopCallUi();
      break;
    case 'call.ended':
      break; // state.ended 已处理
    case 'state':
      if (m.phase === 'ended') stopCallUi();
      break;
  }
}

// ---------------- 播放（24kHz PCM 流式队列） ----------------
function ensurePlayCtx() {
  if (play) return;
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  const gain = ctx.createGain();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  gain.connect(analyser);
  analyser.connect(ctx.destination);
  play = { ctx, gain, analyser, next: 0, sources: new Set() };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function enqueuePlayback(b64) {
  if (!play) return;
  const bytes = b64ToBytes(b64);
  const n = bytes.length >> 1;
  if (!n) return;
  const buf = play.ctx.createBuffer(1, n, 24000);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const v = (bytes[2 * i] | (bytes[2 * i + 1] << 8)) << 16 >> 16;
    ch[i] = v / 32768;
  }
  const src = play.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(play.gain);
  const at = Math.max(play.ctx.currentTime + 0.03, play.next);
  src.start(at);
  play.next = at + buf.duration;
  play.sources.add(src);
  src.onended = () => play.sources.delete(src);
}

function flushPlayback() {
  if (!play) return;
  play.sources.forEach((s) => { try { s.stop(); } catch { /* 已停止 */ } });
  play.sources.clear();
  play.next = 0;
}

// ---------------- 采集（48kHz → 16kHz Int16，100ms/帧） ----------------
function bytesToB64(int16) {
  const u8 = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(s);
}

async function initMic() {
  if (mic) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  await ctx.audioWorklet.addModule(`worklet.js?token=${encodeURIComponent(TOKEN)}`);
  const node = new AudioWorkletNode(ctx, 'pcm-resampler');
  node.port.onmessage = (e) => {
    if (muted || !inCallSession || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'audio.append', audio: bytesToB64(e.data) }));
  };
  const srcNode = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  srcNode.connect(analyser);
  srcNode.connect(node);
  mic = { ctx, node, analyser };
}

// ---------------- 通话控制 ----------------
async function startCall(persona) {
  currentPersona = persona;
  setPhase('connecting');
  transcriptEl.innerHTML = '';
  liveCaption.innerHTML = '';
  try {
    await initMic();
    ensurePlayCtx();
    await play.ctx.resume();
    await mic.ctx.resume();
  } catch (e) {
    toast('无法访问麦克风：' + (e.message || e), 5000);
    stopCallUi();
    return;
  }
  inCallSession = true;
  startedAt = Date.now();
  ws.send(JSON.stringify({ type: 'control', action: 'start_call', personaId: persona.id }));
}

function hangup() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'control', action: 'hangup' }));
  }
  stopCallUi();
}

function stopCallUi(keepDead) {
  const secs = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  clearInterval(timerId);
  timerEl.textContent = '';
  flushPlayback();
  inCallSession = false;
  muted = false;
  btnMute.classList.remove('on');
  btnMute.textContent = '静音';
  mic?.node.port.postMessage({ type: 'mute', on: false });
  setPhase('idle');
  if (!keepDead) ball.classList.remove('dead');
  if (secs > 2) toast(`通话结束，用时 ${Math.floor(secs / 60)}分${secs % 60}秒`);
  startedAt = 0;
}

function startTimer() {
  clearInterval(timerId);
  timerId = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function addTranscript(kind, text) {
  if (!text) return;
  const div = document.createElement('div');
  div.className = 'msg ' + kind;
  const who = kind === 'me' ? '我' : (currentPersona?.name || '对方');
  div.innerHTML = `<div class="who">${who}</div>${escapeHtml(text)}`;
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- 拖拽 + 点击 ----------------
const drag = { active: false, moved: false, dx: 0, dy: 0, sx: 0, sy: 0 };
ball.addEventListener('pointerdown', (e) => {
  drag.active = true; drag.moved = false;
  const r = ball.getBoundingClientRect();
  drag.dx = e.clientX - r.left; drag.dy = e.clientY - r.top;
  drag.sx = e.clientX; drag.sy = e.clientY;
  ball.setPointerCapture(e.pointerId);
});
ball.addEventListener('pointermove', (e) => {
  if (!drag.active) return;
  if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 5) drag.moved = true;
  if (drag.moved) positionBall(e.clientX - drag.dx, e.clientY - drag.dy);
});
ball.addEventListener('pointerup', () => {
  const wasDrag = drag.moved;
  drag.active = false; drag.moved = false;
  if (!wasDrag) onBallTap();
});

function positionBall(x, y) {
  const w = innerWidth - ball.offsetWidth, h = innerHeight - ball.offsetHeight;
  ball.style.left = Math.max(0, Math.min(w, x)) + 'px';
  ball.style.top = Math.max(0, Math.min(h, y)) + 'px';
  ball.style.right = 'auto';
  ball.style.bottom = 'auto';
  layoutPanel();
}

function layoutPanel() {
  if (panel.classList.contains('hidden')) return;
  const r = ball.getBoundingClientRect();
  panel.style.left = Math.max(8, Math.min(innerWidth - 272, r.left + r.width / 2 - 132)) + 'px';
  panel.style.top = Math.max(8, r.top - panel.offsetHeight - 12) + 'px';
}
addEventListener('resize', () => { layoutPanel(); positionPicker(); });

// ---------------- 人设选择 ----------------
async function onBallTap() {
  if (phase === 'idle' || phase === 'ended') {
    if (ball.classList.contains('dead')) { toast('服务未连接：请在 agent 对话里重新发起通话', 4000); return; }
    await showPicker();
  } else {
    panel.classList.toggle('hidden');
    layoutPanel();
  }
}

async function showPicker() {
  picker.classList.remove('hidden');
  picker.innerHTML = '<div class="empty">加载中…</div>';
  positionPicker();
  if (!personas.length) {
    try {
      const res = await fetch(`/api/personas?token=${encodeURIComponent(TOKEN)}`);
      personas = await res.json();
    } catch { personas = []; }
  }
  picker.innerHTML = '';
  if (!personas.length) {
    picker.innerHTML = '<div class="empty">没有人设：请检查 ~/.voice-call/personas.json</div>';
    return;
  }
  personas.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'persona';
    d.innerHTML = `<div class="avatar">${escapeHtml(p.name[0] || '?')}</div>
      <div><div class="pname">${escapeHtml(p.name)}</div>
      <div class="pdesc">${escapeHtml(p.desc || '')}</div></div>`;
    d.onclick = () => { picker.classList.add('hidden'); startCall(p); };
    picker.appendChild(d);
  });
  positionPicker();
}

function positionPicker() {
  if (picker.classList.contains('hidden')) return;
  const r = ball.getBoundingClientRect();
  picker.style.left = Math.max(8, Math.min(innerWidth - 248, r.left + r.width / 2 - 120)) + 'px';
  picker.style.top = Math.max(8, r.top - picker.offsetHeight - 14) + 'px';
}

document.addEventListener('pointerdown', (e) => {
  if (!picker.classList.contains('hidden') && !picker.contains(e.target) && !ball.contains(e.target)) {
    picker.classList.add('hidden');
  }
}, true);

// ---------------- 面板按钮 ----------------
btnHangup.onclick = hangup;
btnText.onclick = () => {
  transcriptEl.classList.toggle('hidden');
  btnText.classList.toggle('on', !transcriptEl.classList.contains('hidden'));
  layoutPanel();
};
btnMute.onclick = () => {
  muted = !muted;
  mic?.node.port.postMessage({ type: 'mute', on: muted });
  ball.classList.toggle('muted', muted);
  btnMute.classList.toggle('on', muted);
  btnMute.textContent = muted ? '已静音' : '静音';
};

// ---------------- PiP 置顶（Chrome/Edge 增强） ----------------
if ('documentPictureInPicture' in window) {
  btnPip.classList.remove('hidden');
  btnPip.onclick = async () => {
    if (documentPictureInPicture.window) {
      documentPictureInPicture.window.close();
      return;
    }
    const pipWin = await documentPictureInPicture.requestWindow({ width: 250, height: 280 });
    [...document.styleSheets].forEach((ss) => {
      try {
        const st = pipWin.document.createElement('style');
        st.textContent = [...ss.cssRules].map((r) => r.cssText).join('\n');
        pipWin.document.head.append(st);
      } catch { /* 跨文档样式读取失败则跳过 */ }
    });
    pipWin.document.body.style.cssText = 'margin:0;background:#0b0f1a;font-family:system-ui,sans-serif';
    const moved = [ball, panel, picker, toastEl];
    moved.forEach((el) => pipWin.document.body.append(el));
    pipWin.addEventListener('pagehide', () => {
      moved.forEach((el) => document.body.append(el));
      ball.style.left = ''; ball.style.top = '';
      ball.style.right = '28px'; ball.style.bottom = '28px';
      btnPip.textContent = '置顶';
    });
    btnPip.textContent = '退出置顶';
  };
}

// ---------------- 波形 ----------------
const wctx = wave.getContext('2d');
function drawWave() {
  requestAnimationFrame(drawWave);
  wctx.clearRect(0, 0, 72, 72);
  if (phase !== 'incall') return;
  let level = 0;
  for (const an of [mic?.analyser, play?.analyser]) {
    if (!an) continue;
    const arr = new Uint8Array(an.fftSize);
    an.getByteTimeDomainData(arr);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) { const v = (arr[i] - 128) / 128; sum += v * v; }
    level = Math.max(level, Math.sqrt(sum / arr.length));
  }
  const cx = 36, cy = 36;
  const bars = 18;
  for (let i = 0; i < bars; i++) {
    const ang = (i / bars) * Math.PI * 2 + performance.now() / 2400;
    const len = 4 + level * 16 * (0.55 + 0.45 * Math.sin(performance.now() / 130 + i * 1.7));
    wctx.strokeStyle = `rgba(255,255,255,${0.25 + level})`;
    wctx.lineWidth = 2;
    wctx.lineCap = 'round';
    wctx.beginPath();
    wctx.moveTo(cx + Math.cos(ang) * 13, cy + Math.sin(ang) * 13);
    wctx.lineTo(cx + Math.cos(ang) * (13 + len), cy + Math.sin(ang) * (13 + len));
    wctx.stroke();
  }
}
drawWave();

// ---------------- 启动 ----------------
connectWs();
setPhase('idle');
