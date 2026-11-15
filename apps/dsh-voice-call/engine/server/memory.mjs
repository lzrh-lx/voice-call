import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, GLOBAL_MEMORY_DIR, loadConfig, projectKey } from './config.mjs';

// 记忆分两层：
//   项目层 ~/.voice-call/memory/<项目键>/<人设>.json  —— 只在本项目生效
//   全局层 ~/.voice-call/memory/_global/profile.json —— 跨项目共享的用户画像
const scopeDir = (cfg) => cfg.memoryScope === 'global'
  ? path.join(DATA_DIR, 'memory', '_global')
  : path.join(DATA_DIR, 'memory', projectKey());

const memFile = (cfg, personaId) => path.join(scopeDir(cfg), `${personaId}.json`);
const EMPTY = () => ({ profile: '', summary: '', memories: [] });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function loadGlobalProfile() {
  return readJson(path.join(GLOBAL_MEMORY_DIR, 'profile.json'), { profile: '' });
}

export function loadMemory(personaId, cfg = loadConfig()) {
  return readJson(memFile(cfg, personaId), EMPTY());
}

export function saveMemory(personaId, mem, cfg = loadConfig()) {
  writeJson(memFile(cfg, personaId), mem);
}

// 通话开始时注入 instructions 的记忆块（全局画像 + 当前项目记忆）
export function memoryBlock(personaId, cfg = loadConfig()) {
  const lines = [];
  const g = loadGlobalProfile();
  if (g.profile) lines.push(`【用户画像（跨项目通用）】${g.profile}`);

  const m = readJson(memFile(cfg, personaId), EMPTY());
  if (m.profile) lines.push(`【本项目中的用户】${m.profile}`);
  if (m.summary) lines.push(`【近况摘要】${m.summary}`);
  const recent = (m.memories || []).slice(-10);
  if (recent.length) {
    lines.push('【本项目记忆要点】\n' + recent.map(x => `- (${x.date}) ${x.text}`).join('\n'));
  }
  if (!lines.length) return '';
  lines.push('以上是当前这个项目的记忆；聊到其他项目的事情时不要张冠李戴，不确定就问用户。');
  return lines.join('\n');
}

export function buildInstructions(persona, cfg = loadConfig()) {
  const mb = memoryBlock(persona.id, cfg);
  return [
    persona.instructions || '你是一个友好的语音通话助手。',
    '通用通话规范：你正在和用户打电话。回复必须像真人说话一样口语化，每次回复尽量不超过两三句话；绝对不要使用 markdown、列表、编号或表情符号；语气自然流畅，可以适当使用语气词。',
    mb ? '以下是关于用户的长期记忆，请在对话中自然地运用，不要机械复述：\n' + mb : ''
  ].filter(Boolean).join('\n\n');
}

// 记忆抽取的文本模型端点：智谱 / 百炼 OpenAI 兼容接口
function llmEndpoint(cfg) {
  if (cfg.provider === 'qwen' && !cfg.apiKey) {
    return {
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      key: cfg.qwenApiKey,
      model: cfg.qwenMemoryModel || 'qwen-flash'
    };
  }
  return {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    key: cfg.apiKey,
    model: cfg.memoryModel || 'glm-5.3-flash'
  };
}

// 通话结束后：把整通转写交给文本模型，抽取长期记忆（人物事实 → 全局画像，项目信息 → 项目记忆）
export async function extractMemory(personaId, transcriptText, cfg = loadConfig()) {
  if (!transcriptText || transcriptText.trim().length < 10) return null;
  const ep = llmEndpoint(cfg);
  if (!ep.key) return null;
  const prev = readJson(memFile(cfg, personaId), EMPTY());
  const prevGlobal = loadGlobalProfile();
  const scope = cfg.memoryScope === 'global' ? '_global' : projectKey();

  const sys = '你是记忆管理器。根据一通电话的对话记录、已有项目记忆和已有全局画像，只输出一个 JSON 对象（不要任何多余文本），字段：'
    + '{"global_profile": "跨项目通用的人物画像（姓名/称呼、职业身份、长期偏好、沟通习惯），简短段落，没有新信息就原样保留", '
    + '"profile": "在本项目语境下的用户画像，只写与本项目相关的角色/关注点，不要重复 global_profile 里的人物事实，没有新信息则原样保留", '
    + '"summary": "本次通话后的项目近况摘要，1-3句", '
    + '"new_memories": [{"text": "属于本项目的、值得长期记住的要点"}]}。'
    + '区分两类信息：人物本身的事实（叫什么、做什么工作、喜欢什么）放 global_profile；'
    + '与具体项目/任务绑定的信息（某项目的进度、决定、待办、技术选型）放 new_memories。'
    + '只提取明确、值得长期记住的信息，日常寒暄不要记。new_memories 可以为空数组。';
  const user = `当前项目：${scope}\n\n已有全局画像：\n${JSON.stringify(prevGlobal)}\n\n已有项目记忆：\n${JSON.stringify(prev)}\n\n通话记录：\n${transcriptText}`;

  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
      body: JSON.stringify({
        model: ep.model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.2
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content || '';
    text = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const obj = JSON.parse(text);

    const added = (Array.isArray(obj.new_memories) ? obj.new_memories : [])
      .map(x => ({ date: new Date().toISOString().slice(0, 10), text: String(x.text || '') }))
      .filter(x => x.text);

    const merged = {
      profile: obj.profile || prev.profile || '',
      summary: obj.summary || prev.summary || '',
      memories: [...(prev.memories || []), ...added].slice(-100)
    };
    writeJson(memFile(cfg, personaId), merged);

    // 全局画像单独落盘，跨项目共享
    if (obj.global_profile && obj.global_profile !== prevGlobal.profile) {
      writeJson(path.join(GLOBAL_MEMORY_DIR, 'profile.json'), {
        profile: obj.global_profile,
        updatedAt: new Date().toISOString()
      });
    }

    console.log(`[voice-call] 记忆已更新：项目 ${scope} / 人设 ${personaId}（新增 ${added.length} 条）`);
    return merged;
  } catch (e) {
    console.error('[voice-call] 记忆抽取失败:', e.message, '（转写已存档）');
    return null;
  }
}
