/**
 * dsh-voice-call —— 浏览器端通话界面。
 *
 * 直接渲染在 shell.overlay 浮层里（不走 iframe）：跨源 iframe 拿不到麦克风权限，
 * 而在宿主页面内 getUserMedia 是可用且已验证的。
 *
 * 链路：
 *   悬浮球 → 语音引擎（qwen realtime，ws://127.0.0.1:8800）
 *   语音里说「帮我干活」→ 引擎 ask_assistant → 宿主 /task → voice_call 工具返回
 *   → agent 在当前对话窗口执行，用户看得见
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-call',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    // 可能同时存在多个宿主实例（多开 DSH），扫描一段端口挑「最新启动」的那个
    const BRIDGE_PORTS = [8799, 8800, 8801, 8802, 8803, 8804, 8805, 8806, 8807, 8808];

    async function discoverBridge() {
      const found = await Promise.all(BRIDGE_PORTS.map(async (port) => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 400);
          const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: ctrl.signal });
          clearTimeout(timer);
          const d = await res.json();
          return d && d.ok ? { port, startedAt: d.startedAt || 0 } : null;
        } catch { return null; }
      }));
      const alive = found.filter(Boolean).sort((a, b) => b.startedAt - a.startedAt);
      return alive.length ? `http://127.0.0.1:${alive[0].port}` : null;
    }

    const css = `
      .vc-ball{position:fixed;right:24px;bottom:24px;z-index:2147483000;width:64px;height:64px;border-radius:50%;
        border:0;cursor:pointer;display:grid;place-items:center;font-size:24px;color:#fff;
        background:linear-gradient(135deg,#6366f1,#a855f7 55%,#ec4899);
        box-shadow:0 6px 24px rgba(99,102,241,.45),inset 0 1px 0 rgba(255,255,255,.25);
        transition:transform .15s ease,box-shadow .3s ease,filter .3s ease;font-family:system-ui,sans-serif}
      .vc-ball:hover{transform:scale(1.06)}
      .vc-ball.incall{animation:vc-glow 2.4s ease-in-out infinite}
      .vc-ball.muted{filter:grayscale(.6) brightness(.85)}
      .vc-ball.dead{background:linear-gradient(135deg,#374151,#4b5563)}
      @keyframes vc-glow{0%,100%{box-shadow:0 6px 24px rgba(99,102,241,.45)}50%{box-shadow:0 6px 36px rgba(168,85,247,.8)}}

      .vc-panel{position:fixed;right:24px;bottom:100px;z-index:2147483000;width:340px;border-radius:16px;
        background:rgba(17,24,39,.97);color:#e5e7eb;border:1px solid rgba(255,255,255,.1);
        box-shadow:0 16px 48px rgba(0,0,0,.55);padding:12px;backdrop-filter:blur(12px);
        font:13px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif}
      .vc-head{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;margin-bottom:8px;
        cursor:move;user-select:none}
      .vc-head .grip{color:#6b7280;font-size:11px;letter-spacing:1px}
      .vc-dot{width:8px;height:8px;border-radius:50%;background:#6b7280}
      .vc-dot.on{background:#22c55e;box-shadow:0 0 8px #22c55e}
      .vc-dot.wait{background:#f59e0b;box-shadow:0 0 8px #f59e0b}
      .vc-timer{margin-left:auto;font-variant-numeric:tabular-nums;color:#9ca3af;font-size:12px}
      .vc-cap{min-height:34px;max-height:60px;overflow:hidden;font-size:12.5px;color:#d1d5db;margin-bottom:6px}
      .vc-cap b{color:#fff}
      .vc-btns{display:flex;gap:6px;margin-top:8px}
      .vc-btn{flex:1;padding:8px 4px;border-radius:9px;border:1px solid rgba(255,255,255,.14);
        background:rgba(255,255,255,.07);color:#e5e7eb;font-size:12px;cursor:pointer}
      .vc-btn:hover{background:rgba(255,255,255,.14)}
      .vc-btn.on{background:rgba(245,158,11,.22);border-color:rgba(245,158,11,.45)}
      .vc-btn.danger{background:rgba(239,68,68,.2);border-color:rgba(239,68,68,.45)}
      .vc-personas{display:flex;flex-direction:column;gap:4px;margin-top:4px}
      .vc-persona{display:flex;gap:10px;align-items:center;padding:8px;border-radius:10px;cursor:pointer}
      .vc-persona:hover{background:rgba(99,102,241,.18)}
      .vc-avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;flex:none;
        color:#fff;background:linear-gradient(135deg,#6366f1,#ec4899);font-size:14px}
      .vc-pname{font-size:13px;font-weight:600}
      .vc-pdesc{font-size:11px;color:#9ca3af}
      .vc-err{color:#f87171;font-size:12px;margin-top:6px;word-break:break-word}
      .vc-log{margin-top:8px;max-height:64px;overflow:auto;font-family:ui-monospace,Menlo,monospace;
        font-size:10px;color:#9ca3af;white-space:pre-wrap}
      .vc-conv{margin:6px 0;max-height:190px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;
        border-top:1px solid rgba(255,255,255,.08);border-bottom:1px solid rgba(255,255,255,.08);padding:8px 0}
      .vc-msg{font-size:12.5px;line-height:1.45}
      .vc-msg .who{font-size:10.5px;opacity:.55;margin-bottom:1px}
      .vc-msg.you{color:#9ca3af}
      .vc-msg.ai{color:#f3f4f6}
      .vc-state{display:flex;align-items:center;gap:6px;font-size:12px;color:#d1d5db;margin:8px 0 4px}
      .vc-state .pulse{width:7px;height:7px;border-radius:50%;background:#4ade80;animation:vc-pulse 1.2s infinite}
      .vc-state.think .pulse{background:#fbbf24;animation:vc-blink 1s infinite}
      .vc-state.speak .pulse{background:#818cf8;animation:vc-pulse .8s infinite}
      @keyframes vc-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
      @keyframes vc-blink{0%,100%{opacity:1}50%{opacity:.25}}
    `;

    function useStyleOnce() {
      useEffect(() => {
        if (document.getElementById('vc-style')) return;
        const el = document.createElement('style');
        el.id = 'vc-style';
        el.textContent = css;
        document.head.appendChild(el);
      }, []);
    }

    const b64FromInt16 = (i16) => {
      const u8 = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
      let s = '';
      const CH = 0x8000;
      for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
      return btoa(s);
    };

    const b64ToBytes = (b64) => {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u;
    };

    function CallBall() {
      useStyleOnce();

      const [endpoint, setEndpoint] = useState(null);
      const [phase, setPhase] = useState('idle');      // idle | connecting | incall
      const [personas, setPersonas] = useState([]);
      const [persona, setPersona] = useState(null);
      const [open, setOpen] = useState(false);
      const [err, setErr] = useState(null);
      const [caption, setCaption] = useState('');
      const [logLines, setLogLines] = useState([]);
      const [muted, setMuted] = useState(false);
      const [elapsed, setElapsed] = useState(0);
      const [showText, setShowText] = useState(false);
      const [transcript, setTranscript] = useState([]);
      const [status, setStatus] = useState('idle');   // idle | listening | thinking | speaking
      const [pos, setPos] = useState(null);           // 面板拖拽位置 {left, top}
      const dragRef = useRef(null);
      const [thinkMs, setThinkMs] = useState(0);
      const thinkStartRef = useRef(0);

      const wsRef = useRef(null);
      const micRef = useRef(null);
      const playRef = useRef(null);
      const pcmTailRef = useRef(null);   // 上一包剩下的奇数字节
      const pcmBufRef = useRef([]);      // 攒到 200ms 再调度，减少碎片
      const pcmBufLenRef = useRef(0);
      const bargeRef = useRef(0);        // 连续有声帧计数（打断判定）
      const speakSeqRef = useRef(0);     // 当前朗读序号（旧流数据直接丢弃）
      const speakStartedRef = useRef(false);  // 本段是否已开播（先攒 1.2s 缓冲）
      const flushRef = useRef(null);     // 供采集回调调用最新的 flush

      // 把攒够的 PCM 一次性排进播放队列
      const flushPcm = useCallback((all) => {
        const play = playRef.current;
        const parts = pcmBufRef.current;
        const total = pcmBufLenRef.current;
        if (!play || !total) { pcmBufRef.current = []; pcmBufLenRef.current = 0; return; }
        const merged = new Uint8Array(total);
        let off = 0;
        for (const p of parts) { merged.set(p, off); off += p.length; }
        pcmBufRef.current = [];
        pcmBufLenRef.current = 0;
        const n = merged.length >> 1;
        if (!n) return;
        const buf = play.ctx.createBuffer(1, n, 24000);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) {
          const v = ((merged[2 * i] | (merged[2 * i + 1] << 8)) << 16) >> 16;
          ch[i] = v / 32768;
        }
        const src = play.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(play.gain);
        const at = Math.max(play.ctx.currentTime + 0.03, play.next);
        src.start(at);
        if (!play.startedAt || play.sources.size === 0) play.startedAt = Date.now();
        play.next = at + buf.duration;
        play.sources.add(src);
        src.onended = () => play.sources.delete(src);
        // 整段放完 → 回到「在听」
        setTimeout(() => setStatus((cur) => (cur === 'speaking' ? 'listening' : cur)), Math.ceil(buf.duration * 1000) + 120);
        void all;
      }, []);
      const startedRef = useRef(0);
      const captionRef = useRef('');
      const mutedRef = useRef(false);
      const aliveRef = useRef(true);
      const bridgeRef = useRef(null);

      const log = useCallback((m) => setLogLines((p) => [...p.slice(-5), m]), []);

      useEffect(() => () => { aliveRef.current = false; }, []);

      // 取引擎地址（宿主启动引擎需要 1-2 秒）
      useEffect(() => {
        let timer = null;
        let n = 0;
        const ask = async () => {
          if (!aliveRef.current) return;
          try {
            if (!bridgeRef.current) bridgeRef.current = await discoverBridge();
            if (!bridgeRef.current) throw new Error('no bridge');
            const res = await fetch(bridgeRef.current + '/call-endpoint');
            const data = await res.json();
            if (!aliveRef.current) return;
            if (data.ok && data.state === 'ready') { setEndpoint(data); return; }
            if (!data.ok) setErr(data.state || '引擎不可用');
            timer = setTimeout(ask, 1200);
          } catch {
            setErr('宿主接口未连接');
            if (++n < 40) timer = setTimeout(ask, 1500);
          }
        };
        ask();
        return () => clearTimeout(timer);
      }, []);

      useEffect(() => {
        if (phase !== 'incall') return;
        const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedRef.current) / 1000)), 500);
        return () => clearInterval(id);
      }, [phase]);

      useEffect(() => { mutedRef.current = muted; }, [muted]);

      // 「思考中」计时，让用户知道 agent 在想事情（不是没听到）
      useEffect(() => {
        if (status !== 'thinking') return;
        const id = setInterval(() => setThinkMs(Date.now() - thinkStartRef.current), 200);
        return () => clearInterval(id);
      }, [status]);

      const stopAudio = useCallback(() => {
        const mic = micRef.current;
        if (mic) {
          try { mic.proc.disconnect(); } catch { /* 忽略 */ }
          try { mic.stream.getTracks().forEach((t) => t.stop()); } catch { /* 忽略 */ }
          try { mic.ctx.close(); } catch { /* 忽略 */ }
          micRef.current = null;
        }
        const play = playRef.current;
        if (play) {
          play.sources.forEach((s) => { try { s.stop(); } catch { /* 忽略 */ } });
          play.sources.clear();
          try { play.ctx.close(); } catch { /* 忽略 */ }
          playRef.current = null;
        }
      }, []);

      const hangup = useCallback(() => {
        try { wsRef.current?.send(JSON.stringify({ type: 'control', action: 'hangup' })); } catch { /* 忽略 */ }
        try { wsRef.current?.close(); } catch { /* 忽略 */ }
        wsRef.current = null;
        stopAudio();
        setPhase('idle');
        setStatus('idle');
        setCaption('');
        captionRef.current = '';
        setMuted(false);
      }, [stopAudio]);

      const ensurePlay = useCallback(() => {
        if (playRef.current) return playRef.current;
        const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        const gain = ctx.createGain();
        gain.connect(ctx.destination);
        playRef.current = { ctx, gain, next: 0, sources: new Set(), startedAt: 0 };
        return playRef.current;
      }, []);

      const enqueue = useCallback((b64) => {
        let bytes = b64ToBytes(b64);
        // 跨包拼接 + 奇数尾部留到下一包，避免半采样错位产生爆音
        if (pcmTailRef.current) {
          const merged = new Uint8Array(pcmTailRef.current.length + bytes.length);
          merged.set(pcmTailRef.current);
          merged.set(bytes, pcmTailRef.current.length);
          bytes = merged;
          pcmTailRef.current = null;
        }
        if (bytes.length % 2) {
          pcmTailRef.current = bytes.slice(-1);
          bytes = bytes.slice(0, bytes.length - 1);
        }
        if (!bytes.length) return;
        pcmBufRef.current.push(bytes);
        pcmBufLenRef.current += bytes.length;
        // 先攒 1.2 秒缓冲再开播（约 57600 字节）：长回答不用等整段合成完；
        // TTS 是 ~3 倍实时速度，开播后缓冲只会越积越多，不会有调度空档（嘶声）
        const PREROLL = 24000 * 2 * 1.2;
        if (!speakStartedRef.current && pcmBufLenRef.current >= PREROLL) {
          speakStartedRef.current = true;
          flushPcm(false);
        } else if (speakStartedRef.current && pcmBufLenRef.current >= 9600) {
          flushPcm(false);   // 已开播：每攒 200ms 续排一次，紧接上一段结尾
        }
      }, [flushPcm]);

      // TTS 返回的是整段 WAV：解码后排队播放
      const playWav = useCallback(async (b64) => {
        const play = ensurePlay();
        try {
          const bytes = b64ToBytes(b64);
          const buf = await play.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          const src = play.ctx.createBufferSource();
          src.buffer = buf;
          src.connect(play.gain);
          const at = Math.max(play.ctx.currentTime + 0.02, play.next);
          src.start(at);
          play.next = at + buf.duration;
          play.sources.add(src);
          src.onended = () => play.sources.delete(src);
        } catch (e) {
          log('播放失败: ' + e.message);
        }
      }, [ensurePlay, log]);

      const flush = useCallback(() => {
        const play = playRef.current;
        if (!play) return;
        play.sources.forEach((s) => { try { s.stop(); } catch { /* 忽略 */ } });
        play.sources.clear();
        play.next = 0;
        play.startedAt = 0;
        speakStartedRef.current = false;
        pcmTailRef.current = null;
        pcmBufRef.current = [];
        pcmBufLenRef.current = 0;
      }, []);

      // 采集回调里要用最新的 flush
      useEffect(() => { flushRef.current = flush; }, [flush]);

      // 采麦：48k → 16k，1600 样本（100ms）一帧
      const startMic = useCallback(async () => {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        const src = ctx.createMediaStreamSource(stream);
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        const ratio = ctx.sampleRate / 16000;
        let acc = 0;
        let pos = 0;
        const buf = [];
        proc.onaudioprocess = (e) => {
          if (mutedRef.current) return;
          const ch = e.inputBuffer.getChannelData(0);
          // 对方正在说话时，不把麦克风音频送给引擎（否则扬声器回声会被当成用户发言），
          // 但本地仍然采样电平用于「打断」判定。
          const playingNow = !!(playRef.current && playRef.current.sources.size > 0);

          // 打断检测：对方还在说话时，用户一开口就停声。
          // 注意：扬声器的声音会被麦克风收回去，阈值太低会「自己把自己打断」，
          // 表现就是一句话说到一半突然停。所以要求更响、更持续，且播放刚开始时不算。
          const play = playRef.current;
          const speaking = play && play.sources.size > 0;
          if (speaking) {
            const sinceStart = play.startedAt ? Date.now() - play.startedAt : 9999;
            let sum = 0;
            for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
            const rms = Math.sqrt(sum / ch.length);
            if (sinceStart > 500 && rms > 0.06) {
              bargeRef.current += 1;
              if (bargeRef.current >= 4) {          // 连续 4 帧（约 340ms）才算真打断
                bargeRef.current = 0;
                flushRef.current?.();
                try { wsRef.current?.send(JSON.stringify({ type: 'control', action: 'cancel_speak' })); } catch { /* 忽略 */ }
                setStatus('listening');
                log('（你打断了，停止播放）');
              }
            } else {
              bargeRef.current = 0;
            }
          }
          for (let i = 0; i < ch.length; i++) {
            acc += ch[i];
            if (++pos >= ratio) {
              buf.push(acc / pos);
              acc = 0;
              pos = 0;
            }
          }
          while (buf.length >= 1600) {
            const frame = buf.splice(0, 1600);
            // 播放期间丢弃采集帧：既避免回声，也省带宽
            if (playingNow) continue;
            const out = new Int16Array(1600);
            for (let i = 0; i < 1600; i++) {
              const v = Math.max(-1, Math.min(1, frame[i]));
              out[i] = v < 0 ? v * 32768 : v * 32767;
            }
            const ws = wsRef.current;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'audio.append', audio: b64FromInt16(out) }));
            }
          }
        };
        src.connect(proc);
        // 必须接到 destination 才会持续触发 onaudioprocess，但直接接会把麦克风外放
        // 造成反馈/撕裂声，所以串一个 0 增益的汇
        const sink = ctx.createGain();
        sink.gain.value = 0;
        proc.connect(sink);
        sink.connect(ctx.destination);
        micRef.current = { ctx, proc, stream };
      }, []);

      const startCall = useCallback(async (p) => {
        if (!endpoint) { setErr('引擎尚未就绪'); return; }
        setErr(null);
        setPersona(p);
        setOpen(true);
        setPhase('connecting');
        setTranscript([]);
        setCaption('');
        captionRef.current = '';
        setElapsed(0);

        try {
          ensurePlay();
          await playRef.current.ctx.resume();
          await startMic();
        } catch (e) {
          setErr('麦克风不可用：' + (e.message || e.name));
          setPhase('idle');
          stopAudio();
          return;
        }

        const ws = new WebSocket(endpoint.wsUrl);
        wsRef.current = ws;
        ws.onopen = () => {
          startedRef.current = Date.now();
          ws.send(JSON.stringify({ type: 'control', action: 'start_call', personaId: p.id }));
        };
        ws.onmessage = (ev) => {
          let m;
          try { m = JSON.parse(ev.data); } catch { return; }
          switch (m.type) {
            case 'call.ready': setPhase('incall'); setStatus('listening'); break;
            case 'speak.begin': {
              // 新朗读开始：清掉旧缓冲，杜绝两条流字节交错（会变噪声）
              speakSeqRef.current = m.seq;
              speakStartedRef.current = false;
              pcmBufRef.current = [];
              pcmBufLenRef.current = 0;
              pcmTailRef.current = null;
              setStatus('speaking');
              break;
            }
            case 'audio.delta': if (m.seq === speakSeqRef.current) enqueue(m.audio); break;   // 旧流丢弃
            case 'audio.file': playWav(m.audio); break;   // agent 的回答（TTS，整段 WAV）
            case 'audio.end': if (m.seq === speakSeqRef.current) flushPcm(true); break;   // 收尾：把余量播完
            case 'speech.started': flush(); setStatus('listening'); break;
            case 'transcript.assistant.delta':
              captionRef.current += m.delta;
              setCaption(captionRef.current);
              break;
            case 'transcript.assistant.done':
              setTranscript((t) => [...t, { who: p.name, text: m.text }]);
              setStatus('speaking');
              captionRef.current = '';
              setCaption('');
              break;
            case 'transcript.user':
              setTranscript((t) => [...t, { who: '我', text: m.text }]);
              // 这句话已经交给 agent，进入思考阶段（用户能看到"在思考"而不是干等）
              thinkStartRef.current = Date.now();
              setThinkMs(0);
              setStatus('thinking');
              break;
            case 'tool.call': log('🔧 ' + (m.purpose || m.name)); break;
            case 'error': setErr(m.message); break;
            case 'model.closed': log('通话已断开'); hangup(); break;
            case 'state': if (m.phase === 'ended') hangup(); break;
            default: break;
          }
        };
        ws.onclose = () => {
          if (wsRef.current === ws) {
            stopAudio();
            setPhase('idle');
            setCaption('');
          }
        };
      }, [endpoint, ensurePlay, enqueue, playWav, flush, flushPcm, hangup, log, startMic, stopAudio]);

      const loadPersonas = useCallback(async () => {
        if (!endpoint || personas.length) return;
        try {
          const res = await fetch(endpoint.httpUrl);
          setPersonas(await res.json());
        } catch { setErr('人设加载失败'); }
      }, [endpoint, personas.length]);

      useEffect(() => { if (open && phase === 'idle') loadPersonas(); }, [open, phase, loadPersonas]);

      const onHeadDown = (e) => {
        const r = e.currentTarget.parentElement.getBoundingClientRect();
        dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
      };
      const onHeadMove = (e) => {
        const d = dragRef.current;
        if (!d) return;
        const left = Math.min(Math.max(0, e.clientX - d.dx), window.innerWidth - d.w);
        const top = Math.min(Math.max(0, e.clientY - d.dy), window.innerHeight - d.h);
        setPos({ left, top });
      };
      const onHeadUp = () => { dragRef.current = null; };

      const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
      const dotCls = phase === 'incall' ? 'vc-dot on' : phase === 'connecting' ? 'vc-dot wait' : 'vc-dot';

      return h(React.Fragment, null,
        h('button', {
          className: 'vc-ball' + (phase === 'incall' ? ' incall' : '') + (muted ? ' muted' : '') + (endpoint ? '' : ' dead'),
          title: 'voice-call',
          onClick: () => setOpen((v) => !v)
        }, phase === 'incall' ? '🎙' : '📞'),

        open && h('div', {
          className: 'vc-panel',
          style: pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } : null
        },
          h('div', {
            className: 'vc-head',
            onPointerDown: onHeadDown,
            onPointerMove: onHeadMove,
            onPointerUp: onHeadUp,
            onPointerCancel: onHeadUp
          },
            h('span', { className: 'grip' }, '⠿'),
            h('span', { className: dotCls }),
            phase === 'idle' ? '选择人设拨号' : phase === 'connecting' ? '接通中…' : (persona?.name || '通话中'),
            phase !== 'idle' && h('span', { className: 'vc-timer' }, mmss)
          ),

          err && h('div', { className: 'vc-err' }, err),

          phase === 'idle' && h('div', { className: 'vc-personas' },
            personas.length === 0 && h('div', { className: 'vc-pdesc' }, endpoint ? '加载中…' : '引擎启动中…'),
            personas.map((p) => h('div', { key: p.id, className: 'vc-persona', onClick: () => startCall(p) },
              h('div', { className: 'vc-avatar' }, (p.name || '?')[0]),
              h('div', null,
                h('div', { className: 'vc-pname' }, p.name),
                h('div', { className: 'vc-pdesc' }, p.desc || '')
              )
            ))
          ),

          // 只保留状态：内容都在对话窗口里看
          phase !== 'idle' && h('div', { className: 'vc-state' + (status === 'thinking' ? ' think' : status === 'speaking' ? ' speak' : '') },
            h('span', { className: 'pulse' }),
            status === 'thinking'
              ? `思考中 ${(thinkMs / 1000).toFixed(1)}s…`
              : status === 'speaking'
                ? '正在说…（开口可打断）'
                : '在听，请说…'
          ),

          phase !== 'idle' && h('div', { className: 'vc-btns' },
            h('button', { className: 'vc-btn' + (muted ? ' on' : ''), onClick: () => setMuted((v) => !v) },
              muted ? '已静音' : '静音'),
            h('button', { className: 'vc-btn danger', onClick: hangup }, '挂断')
          )
        )
      );
    }

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-voice-call-ball',
        label: () => 'voice-call'
      }, CallBall));
    }

    exports.name = 'dsh-voice-call';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  }
});
