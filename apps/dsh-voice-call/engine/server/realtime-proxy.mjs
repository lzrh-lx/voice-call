import { WebSocket } from 'ws';
import { loadConfig, projectKey } from './config.mjs';
import { buildInstructions } from './memory.mjs';
import { skillInstructions } from './skills.mjs';
import { buildTools, executeTool } from './tools.mjs';
import { zhipuAdapter } from './providers/zhipu.mjs';
import { qwenAdapter } from './providers/qwen.mjs';

const ADAPTERS = { zhipu: zhipuAdapter, qwen: qwenAdapter };

/**
 * 一通电话 = 一个 RealtimeProxy（厂商无关）。
 * 浏览器 WS ↔ 本代理 ↔ 厂商 Realtime WS 双向转发，
 * 协议差异由 providers/ 下的适配器抹平。
 */
export class RealtimeProxy {
  constructor(persona, onEvent) {
    this.persona = persona;
    this.onEvent = onEvent; // (event) => void，推给浏览器
    this.ws = null;
    this.closed = false;
    this.adapter = null;
    this.activeResponse = false;   // response.created → response.done 之间为 true
    this.toolDebounce = null;
    this.transcript = { user: [], assistant: [] };
    this.startedAt = Date.now();
    this.speakAbort = null;    // 当前朗读的中断句柄
    this.speakSeq = 0;         // 朗读序号：被中断后丢弃旧流
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  start() {
    const cfg = loadConfig();
    this.adapter = ADAPTERS[cfg.provider] || zhipuAdapter;
    const key = this.adapter.apiKey(cfg);
    if (!key) {
      this.onEvent({
        type: 'error',
        message: `未配置 ${this.adapter.name === 'qwen' ? '阿里百炼 DASHSCOPE' : '智谱'} API Key：请填写 ~/.voice-call/config.json 的 ${this.adapter.name === 'qwen' ? 'qwenApiKey' : 'apiKey'} 字段`
      });
      return;
    }
    // 本引擎只负责听：ASR + VAD。回答由 agent 产出，再由 speak() 用 TTS 念出来。
    // 浏览器 WebSocket 无法携带鉴权头，因此由本服务端代理连接并持有 Key
    const { url, headers } = this.adapter.endpoint(cfg);
    const ws = new WebSocket(url, { headers });
    this.ws = ws;
    ws.on('open', () => this.send(this.listenOnlySession(cfg)));
    ws.on('message', (raw) => {
      try { this.handleModelEvent(JSON.parse(raw.toString())); } catch { /* 忽略坏帧 */ }
    });
    ws.on('error', (e) => {
      this.onEvent({ type: 'error', message: 'Realtime 连接失败: ' + e.message });
    });
    ws.on('close', () => {
      if (!this.closed) this.onEvent({ type: 'model.closed' });
    });
  }

  /** 只听写模式：不产生任何自动回复，只吐用户转写 */
  listenOnlySession(cfg) {
    return {
      type: 'session.update',
      session: {
        model: cfg.qwenModel || 'qwen3.8-omni-flash-realtime',
        modalities: ['text'],
        instructions: '你只负责听写，不要回答任何问题。',
        input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
        turn_detection: {
          type: 'server_vad',
          create_response: false,      // 关键：不自动生成回复
          interrupt_response: false,
          threshold: 0.5,
          prefix_padding_ms: 500,
          silence_duration_ms: 700
        },
        audio: {
          input: {
            format: {
              type: 'pcm', sample_rate: 16000, sample_format: 's16le',
              channels: 1, packing: 'interleaved', channel_layout: 'mono'
            }
          },
          output: { voice: 'Tina', format: { type: 'pcm', sample_rate: 24000 } }
        }
      }
    };
  }

  /** 用 TTS 把 agent 的文字念出来 */
  async speak(text) {
    const body = String(text || '').trim();
    if (!body) return { ok: false, reason: 'empty' };
    const cfg = loadConfig();
    this.transcript.assistant.push(body);
    this.lastSpokenText = body;   // 回声去重用
    this.onEvent({ type: 'transcript.assistant.done', text: body });

    if (cfg.ttsProvider === 'deepseek' && cfg.deepseekApiKey) {
      return this.speakDeepseek(body, cfg);
    }
    return this.speakQwen(body, cfg);
  }

  /** DeepSeek TTS：一次请求，音频随合成流式返回（raw 16-bit mono PCM 24kHz） */
  /** 用户打断：停止当前朗读并丢弃后续音频 */
  cancelSpeak() {
    this.speakSeq += 1;
    try { this.speakAbort?.abort(); } catch { /* 已结束 */ }
    this.speakAbort = null;
    this.onEvent({ type: 'audio.end', seq: this.speakSeq });
    return { ok: true };
  }

  async speakDeepseek(body, cfg) {
    const voiceId = this.persona?.voices?.deepseek || cfg.deepseekTtsVoice || 'stella';
    const seq = ++this.speakSeq;
    const ac = new AbortController();
    // 新朗读开始前，显式中止上一段（防止两条流的字节交错 → 客户端 PCM 错位成噪声）
    try { this.speakAbort?.abort(); } catch { /* 已结束 */ }
    this.speakAbort = ac;
    this.onEvent({ type: 'speak.begin', seq });
    try {
      const res = await fetch('https://api.deepseek.com/v1/tools/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.deepseekApiKey}` },
        body: JSON.stringify({ text: body, voice_id: voiceId, format: 'pcm' }),
        signal: ac.signal
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        return { ok: false, reason: `deepseek tts ${res.status} ${detail.slice(0, 120)}` };
      }
      // 边收边推：浏览器用现成的 24kHz 播放队列无缝拼接
      const reader = res.body.getReader();
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (seq !== this.speakSeq) break;   // 已被打断，丢弃剩余
        if (value && value.length) {
          bytes += value.length;
          this.onEvent({ type: 'audio.delta', seq, audio: Buffer.from(value).toString('base64') });
        }
      }
      if (seq === this.speakSeq) this.onEvent({ type: 'audio.end', seq });
      else return { ok: false, reason: 'cancelled' };
      return { ok: true, bytes, provider: 'deepseek', voice: voiceId };
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: e.message };
    } finally {
      if (this.speakAbort === ac) this.speakAbort = null;
    }
  }

  /** 阿里 qwen3-tts-flash：返回 WAV 链接，下载后整段交给浏览器解码 */
  async speakQwen(body, cfg) {
    if (!cfg.qwenApiKey) return { ok: false, reason: 'no qwen key' };
    const voice = this.persona?.voices?.tts || 'Cherry';
    try {
      const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.qwenApiKey}` },
        body: JSON.stringify({ model: 'qwen3-tts-flash', input: { text: body, voice } })
      });
      const data = await res.json();
      const url = data?.output?.audio?.url;
      if (!url) return { ok: false, reason: data?.message || 'tts failed' };
      const audio = Buffer.from(await (await fetch(url)).arrayBuffer());
      this.onEvent({ type: 'audio.file', mime: 'audio/wav', audio: audio.toString('base64') });
      return { ok: true, bytes: audio.length, provider: 'qwen', voice };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  appendAudio(base64Pcm) {
    this.send({ type: 'input_audio_buffer.append', audio: base64Pcm });
  }

  handleModelEvent(ev) {
    switch (ev.type) {
      case 'session.updated':
        this.adapter.onSessionUpdated?.(this);   // qwen：触发开场白响应
        this.onEvent({ type: 'call.ready' });
        break;
      case 'response.created':
        this.activeResponse = true;
        break;
      case 'response.done':
      case 'response.cancelled':
        this.activeResponse = false;
        break;
      // 用户开始说话：通知浏览器停声，适配器按需补发 response.cancel
      case 'input_audio_buffer.speech_started':
        this.adapter.onSpeechStarted?.(this);
        this.onEvent({ type: 'speech.started' });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (ev.transcript) {
          this.transcript.user.push(ev.transcript);
          this.onEvent({ type: 'transcript.user', text: ev.transcript });
          this.onUserSpeech?.(ev.transcript, this);
        }
        break;
      case 'response.audio.delta':
        if (ev.delta) this.onEvent({ type: 'audio.delta', audio: ev.delta });
        break;
      case 'response.audio_transcript.delta':
        if (ev.delta) this.onEvent({ type: 'transcript.assistant.delta', delta: ev.delta });
        break;
      case 'response.audio_transcript.done':
        if (ev.transcript) {
          this.transcript.assistant.push(ev.transcript);
          this.onEvent({ type: 'transcript.assistant.done', text: ev.transcript });
        }
        break;
      // 只听写模式不会产生 response / function_call，以下分支保留仅为容错

      case 'error':
        this.onEvent({ type: 'error', message: ev.error?.message || JSON.stringify(ev.error || ev) });
        break;
      default:
        break; // 其余事件对悬浮球无用，直接丢弃
    }
  }

  // 执行工具 → 回填 function_call_output → 防抖触发一次继续推理
  async runTool(ev) {
    const name = ev.name;
    let args = {};
    try { args = JSON.parse(ev.arguments || '{}'); } catch { /* 参数可能不完整 */ }
    // 悬浮球据此显示「正在调用…」，run_command 用 purpose 更像人话
    this.onEvent({ type: 'tool.call', name, purpose: args.purpose || args.q || args.query || '' });
    const result = await executeTool(name, ev.arguments);
    this.onEvent({ type: 'tool.result', name, result });
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // OpenAI 系协议（qwen）要求回带 call_id，智谱不要求；带上无害
    const item = { type: 'function_call_output', object: 'realtime.item', output: JSON.stringify(result) };
    if (ev.call_id) item.call_id = ev.call_id;
    this.send({ type: 'conversation.item.create', item });
    // 模型可能并行发起多个调用：都回填后再统一触发一次推理
    clearTimeout(this.toolDebounce);
    this.toolDebounce = setTimeout(() => this.send({ type: 'response.create' }), 400);
  }

  buildTranscriptText() {
    const t = this.transcript;
    const n = Math.max(t.user.length, t.assistant.length);
    const lines = [];
    for (let i = 0; i < n; i++) {
      if (t.user[i]) lines.push(`用户: ${t.user[i]}`);
      if (t.assistant[i]) lines.push(`${this.persona.name}: ${t.assistant[i]}`);
    }
    return lines.join('\n');
  }

  hangup() {
    this.closed = true;
    clearTimeout(this.toolDebounce);
    try { this.ws?.close(); } catch { /* 已关闭 */ }
  }
}
