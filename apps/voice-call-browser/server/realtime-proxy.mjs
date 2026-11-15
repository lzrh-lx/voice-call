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
    // instructions = 人设 + 记忆（项目/全局） + 技能说明；tools 随 skills.enabled 动态增减
    const extra = skillInstructions(cfg);
    const instructions = [buildInstructions(this.persona, cfg), extra].filter(Boolean).join('\n\n');
    const tools = buildTools(cfg, { skillsEnabled: !!extra });
    // 浏览器 WebSocket 无法携带鉴权头，因此由本服务端代理连接并持有 Key
    const { url, headers } = this.adapter.endpoint(cfg);
    const ws = new WebSocket(url, { headers });
    this.ws = ws;
    ws.on('open', () => this.send(this.adapter.sessionUpdate(cfg, this.persona, instructions, tools)));
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
      case 'response.function_call_arguments.done':
        this.runTool(ev).catch(() => {});
        break;
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
