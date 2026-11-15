import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// 运行时数据目录：与插件源码分离，任意工作目录下拨打都一致
export const DATA_DIR = path.join(os.homedir(), '.voice-call');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const GLOBAL_MEMORY_DIR = path.join(DATA_DIR, 'memory', '_global');

const DEFAULTS = {
  provider: 'zhipu',              // 实时语音引擎：zhipu | qwen
  apiKey: '',                     // 智谱 Key（实时引擎=zhipu 时必填；也用于搜索/记忆）
  model: 'glm-realtime',
  memoryModel: 'glm-5.3-flash',
  searchEngine: 'search_std',
  port: 8710,
  qwenApiKey: '',                 // 阿里百炼 DASHSCOPE Key（provider=qwen 时必填）
  qwenWorkspaceId: '',            // 百炼工作空间 ID（留空走 DashScope 通用端点）
  qwenRegion: 'cn-beijing',       // cn-beijing | ap-southeast-1
  qwenModel: 'qwen3.8-omni-flash-realtime',
  qwenMemoryModel: 'qwen-flash',  // 记忆抽取用（百炼 OpenAI 兼容接口）
  // 记忆按项目隔离；不同项目互不串味，另有一份跨项目共享的用户画像
  memoryScope: 'project',         // project | global
  // 通话中调用本地 skill：注入 SKILL.md 说明 + 白名单命令执行
  skills: {
    enabled: true,
    active: ['*'],                // '*' 注入所有已安装技能的说明；也可写 ["ego-browser"]
    allowedCommands: ['ego-browser', 'python3', 'node'], // 允许执行的可执行文件名
    maxInjectChars: 2500,         // 技能说明注入总字数上限（实时语音模型上下文很小）
    timeoutMs: 30000,
    maxOutputChars: 4000
  }
};

export function ensureDataDir() {
  fs.mkdirSync(path.join(DATA_DIR, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'transcripts'), { recursive: true });
  fs.mkdirSync(GLOBAL_MEMORY_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2));
    return;
  }
  // 迁移：给旧配置文件补上新增字段（保留用户已填的值）
  try {
    const cur = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const merged = { ...DEFAULTS, ...cur, skills: { ...DEFAULTS.skills, ...(cur.skills || {}) } };
    if (JSON.stringify(merged) !== JSON.stringify(cur)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
    }
  } catch { /* 损坏则由 loadConfig 重建默认值 */ }
}

// 当前项目 = agent 启动服务时的工作目录（skill 会传入该环境变量）
export function projectDir() {
  return process.env.VOICE_CALL_PROJECT_DIR || process.cwd();
}

// 项目键：目录名 + 路径短哈希，既好认又不撞名
export function projectKey() {
  const dir = projectDir();
  const base = path.basename(dir).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'root';
  const hash = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

export function loadConfig() {
  ensureDataDir();
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* 使用默认值 */ }
  const cfg = { ...DEFAULTS, ...file };
  const envProvider = process.env.VOICE_CALL_PROVIDER;
  const provider = envProvider === 'qwen' || envProvider === 'zhipu'
    ? envProvider
    : (['zhipu', 'qwen'].includes(cfg.provider) ? cfg.provider : 'zhipu');
  return {
    provider,
    // API Key 优先取环境变量，其次取配置文件；绝不下发到浏览器端
    apiKey: process.env.ZHIPUAI_API_KEY || cfg.apiKey || '',
    model: cfg.model,
    memoryModel: cfg.memoryModel,
    searchEngine: cfg.searchEngine,
    port: Number(process.env.VOICE_CALL_PORT || cfg.port || 8710),
    qwenApiKey: process.env.DASHSCOPE_API_KEY || cfg.qwenApiKey || '',
    qwenWorkspaceId: cfg.qwenWorkspaceId || '',
    qwenRegion: cfg.qwenRegion === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing',
    qwenModel: cfg.qwenModel || 'qwen3.8-omni-flash-realtime',
    qwenMemoryModel: cfg.qwenMemoryModel || 'qwen-flash',
    memoryScope: cfg.memoryScope === 'global' ? 'global' : 'project',
    skills: {
      enabled: cfg.skills?.enabled !== false,
      active: Array.isArray(cfg.skills?.active) && cfg.skills.active.length ? cfg.skills.active : ['*'],
      allowedCommands: Array.isArray(cfg.skills?.allowedCommands) ? cfg.skills.allowedCommands : DEFAULTS.skills.allowedCommands,
      maxInjectChars: Number(cfg.skills?.maxInjectChars) || DEFAULTS.skills.maxInjectChars,
      timeoutMs: Number(cfg.skills?.timeoutMs) || DEFAULTS.skills.timeoutMs,
      maxOutputChars: Number(cfg.skills?.maxOutputChars) || DEFAULTS.skills.maxOutputChars
    }
  };
}
