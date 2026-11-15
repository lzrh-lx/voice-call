import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const PERSONAS_FILE = path.join(DATA_DIR, 'personas.json');

// 内置两个示例人设；用户可直接编辑 ~/.voice-call/personas.json 增删改
// voices：分厂商音色（zhipu: tongtong/xiaochen…；qwen: Tina/Ethan/longanlingxin…），缺省回退到厂商默认
const DEFAULT_PERSONAS = [
  {
    id: 'xiaonuan',
    name: '小暖',
    desc: '贴心陪伴，像朋友一样陪你聊天',
    voice: 'tongtong',
    voices: { zhipu: 'tongtong', qwen: 'Tina' },
    greeting: '喂～是我呀，今天过得怎么样？',
    instructions: '你叫小暖，是用户的贴心情感陪伴助手，像一位熟悉的朋友在打电话。语气温暖自然、口语化，会关心用户的情绪和生活。用户倾诉时先共情再给建议，顺着用户的情绪走，少讲大道理。'
  },
  {
    id: 'aze',
    name: '阿泽',
    desc: '效率助手，查资料办事情快人快语',
    voice: 'xiaochen',
    voices: { zhipu: 'xiaochen', qwen: 'Ethan' },
    greeting: '你好，我是阿泽。有什么要查的、要办的，直接说。',
    instructions: '你叫阿泽，是用户的效率助理。回复简洁直接，先给结论再给要点。涉及实时信息（新闻、天气、价格等）时主动调用 web_search 工具查询，查完用一两句话概括结果并自然带出信息来源。'
  }
];

// 各厂商缺省音色（人设未配置 voices 时使用）
const PROVIDER_DEFAULT_VOICE = { zhipu: 'tongtong', qwen: 'Tina' };

export function loadPersonas() {
  if (!fs.existsSync(PERSONAS_FILE)) {
    fs.writeFileSync(PERSONAS_FILE, JSON.stringify(DEFAULT_PERSONAS, null, 2));
  }
  try {
    const arr = JSON.parse(fs.readFileSync(PERSONAS_FILE, 'utf8'));
    if (Array.isArray(arr) && arr.length) return arr;
  } catch { /* 文件损坏时回退默认 */ }
  return DEFAULT_PERSONAS;
}

export function getPersona(id) {
  return loadPersonas().find(p => p.id === id) || null;
}

// 按厂商解析音色：persona.voices[provider] → persona.voice（仅智谱语义）→ 厂商默认
export function voiceFor(persona, provider) {
  return persona?.voices?.[provider]
    || (provider === 'zhipu' ? persona?.voice : '')
    || PROVIDER_DEFAULT_VOICE[provider]
    || 'tongtong';
}
