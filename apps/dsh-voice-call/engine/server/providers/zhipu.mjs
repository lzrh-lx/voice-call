// 智谱 GLM-Realtime 适配器（OpenAI Realtime 风格协议 + 智谱扩展字段）
import { voiceFor } from '../personas.mjs';

export const zhipuAdapter = {
  name: 'zhipu',

  apiKey(cfg) { return cfg.apiKey; },

  endpoint(cfg) {
    return {
      url: 'wss://open.bigmodel.cn/api/paas/v4/realtime',
      headers: { Authorization: `Bearer ${cfg.apiKey}` }
    };
  },

  sessionUpdate(cfg, persona, instructions, tools = []) {
    return {
      type: 'session.update',
      session: {
        model: cfg.model,
        modalities: ['audio', 'text'],
        instructions,
        voice: voiceFor(persona, 'zhipu'),
        input_audio_format: 'pcm16',   // 16kHz 16bit 单声道 PCM
        output_audio_format: 'pcm',    // 24kHz 16bit 单声道 PCM
        input_audio_noise_reduction: { type: 'near_field' },
        turn_detection: {
          type: 'server_vad',
          create_response: true,       // 静音判定后自动生成回复
          interrupt_response: true,    // 用户插话自动打断模型输出
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          threshold: 0.5
        },
        tools,
        temperature: 0.7,
        max_response_output_tokens: 'inf',
        beta_fields: {
          chat_mode: 'audio',
          tts_source: 'e2e',
          greeting_config: {
            enable: true,
            content: String(persona.greeting || '喂，我在呢。').slice(0, 1024)
          }
        }
      }
    };
  },

  // 服务端 VAD 全托管打断，无需客户端动作
  onSpeechStarted() {}
};
