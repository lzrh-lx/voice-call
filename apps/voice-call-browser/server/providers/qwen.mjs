// 阿里百炼 Qwen-Omni-Realtime 适配器（OpenAI Realtime 风格协议）
// 差异点：端点带 WorkspaceId 与 model 查询参数、嵌套式 audio 配置、
// 无 greeting_config（用 instructions + 首个 response.create 触发开场白）、
// 打断需客户端在 speech_started 时补发 response.cancel
import { voiceFor } from '../personas.mjs';

export const qwenAdapter = {
  name: 'qwen',

  apiKey(cfg) { return cfg.qwenApiKey; },

  endpoint(cfg) {
    const model = encodeURIComponent(cfg.qwenModel || 'qwen3.8-omni-flash-realtime');
    // 优先走工作空间专属域名；未配置 WorkspaceId 时回退 DashScope 通用端点
    const host = cfg.qwenWorkspaceId
      ? `${cfg.qwenWorkspaceId}.${cfg.qwenRegion}.maas.aliyuncs.com`
      : 'dashscope.aliyuncs.com';
    return {
      url: `wss://${host}/api-ws/v1/realtime?model=${model}`,
      headers: { Authorization: `Bearer ${cfg.qwenApiKey}` }
    };
  },

  sessionUpdate(cfg, persona, instructions, tools = []) {
    // 开场白写进指令，接通后由 onSessionUpdated 触发首个 response 实现开口说话
    const withGreeting = instructions
      + `\n\n【开场白】电话刚接通时你的第一句话是："${persona.greeting || '喂，我在呢。'}"——用自己自然的语气说出来，不要逐字背诵。`;
    return {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: withGreeting,
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 500,
          silence_duration_ms: 800
        },
        audio: {
          input: {
            format: { type: 'pcm', sample_rate: 16000, sample_format: 's16le', channels: 1, packing: 'interleaved', channel_layout: 'mono' }
          },
          output: {
            voice: voiceFor(persona, 'qwen'),
            format: { type: 'pcm', sample_rate: 24000 }
          }
        },
        input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
        tools,
        temperature: 0.7
      }
    };
  },

  // VAD 停止后自动创建回复；但取消进行中的响应需要客户端补刀
  onSpeechStarted(proxy) {
    if (proxy.activeResponse) {
      proxy.send({ type: 'response.cancel' });
    }
  },

  // session.updated 后触发首个响应 → 模型说出开场白。
  // 注意：Qwen 不接受「无输入、无历史」的空 response.create，必须随请求带 instructions。
  onSessionUpdated(proxy) {
    proxy.send({
      type: 'response.create',
      response: { instructions: '电话刚刚接通，现在说出你的第一句问候语，自然口语，一句话即可。' }
    });
  }
};
