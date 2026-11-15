import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, projectDir } from './config.mjs';

const execAsync = promisify(exec);

// ---- 工具实现 ----

async function getCurrentTime() {
  const now = new Date();
  const local = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Shanghai'
  }).format(now);
  return { datetime: now.toISOString(), local };
}

// 搜索：有智谱 Key 用智谱搜索 API；否则有百炼 Key 走 qwen 联网问答（enable_search）
async function webSearch(args) {
  const cfg = loadConfig();
  const q = String(args.q || args.query || '').trim();
  if (!q) return { error: '缺少搜索词' };
  if (!cfg.apiKey && !cfg.qwenApiKey) return { error: '未配置任何 API Key，无法搜索' };

  if (cfg.apiKey) {
    try {
      const res = await fetch('https://open.bigmodel.cn/api/paas/v4/web_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ search_engine: cfg.searchEngine, search_query: q, count: 5 })
      });
      if (!res.ok) return { error: `搜索失败 HTTP ${res.status}` };
      const data = await res.json();
      const list = data.search_result || data.data || [];
      const results = list.slice(0, 5).map(r => ({
        title: r.title || '',
        link: r.link || r.url || '',
        snippet: String(r.content || r.snippet || '').slice(0, 300)
      }));
      return { query: q, results };
    } catch (e) {
      return { error: `搜索异常: ${e.message}` };
    }
  }

  try {
    const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.qwenApiKey}` },
      body: JSON.stringify({
        model: cfg.qwenMemoryModel || 'qwen-flash',
        messages: [
          { role: 'system', content: '你是搜索助手。根据联网搜索结果用中文简要回答，并附上 1-3 条来源链接。' },
          { role: 'user', content: q }
        ],
        enable_search: true
      })
    });
    if (!res.ok) return { error: `搜索失败 HTTP ${res.status}` };
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content || '';
    return { query: q, answer: String(answer).slice(0, 600) };
  } catch (e) {
    return { error: `搜索异常: ${e.message}` };
  }
}

// 只拦截真正能造成命令串联/重定向/替换的 shell 元字符。
// 注意不要把 () {} [] 也拦掉——那会让 node -e "console.log(1)" 这类正常命令失效；
// 单独出现的括号在参数里无害，而 $( 和反引号已由 $ 和 ` 拦下。
const FORBIDDEN = /[;&|<>`$\n\r]/;

async function runCommand(args, cfg) {
  const command = String(args.command || '').trim();
  if (!command) return { error: '缺少 command' };
  if (FORBIDDEN.test(command)) {
    return { error: '命令包含不允许的字符（; & | < > ` $ ( ) 等），请只给一条简单命令' };
  }
  const bin = command.split(/\s+/)[0];
  const allow = cfg.skills?.allowedCommands || [];
  if (!allow.includes(bin)) {
    return { error: `「${bin}」不在允许列表内。当前允许：${allow.join(', ')}` };
  }
  const timeout = cfg.skills?.timeoutMs || 30000;
  const maxOut = cfg.skills?.maxOutputChars || 4000;
  try {
    // 在用户当前项目目录下执行，技能产出的文件会落在项目里
    const { stdout, stderr } = await execAsync(command, {
      cwd: projectDir(),
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env }
    });
    const out = (stdout || '').trim();
    const err = (stderr || '').trim();
    return {
      ok: true,
      output: out.slice(0, maxOut) || '（无输出）',
      ...(err ? { stderr: err.slice(0, 800) } : {})
    };
  } catch (e) {
    if (e.killed) return { error: `命令超时（${timeout / 1000} 秒）` };
    return {
      error: String(e.message || e).slice(0, 300),
      stdout: String(e.stdout || '').slice(0, 1500),
      stderr: String(e.stderr || '').slice(0, 1500)
    };
  }
}

// ---- 下发给 Realtime 的工具定义（两厂商共用，OpenAI 系 Json Schema） ----

const TIME_TOOL = {
  type: 'function',
  name: 'get_current_time',
  description: '获取当前的日期和时间。当用户询问现在几点、今天日期、星期几等时间信息时调用。',
  parameters: { type: 'object', properties: {}, required: [] }
};

const SEARCH_TOOL = {
  type: 'function',
  name: 'web_search',
  description: '联网搜索工具。当用户询问实时信息、新闻、天气、价格等需要最新外部信息的内容时调用。',
  parameters: {
    type: 'object',
    properties: { q: { type: 'string', description: '搜索关键词' } },
    required: ['q']
  }
};

const RUN_COMMAND_TOOL = {
  type: 'function',
  name: 'run_command',
  description: '在本机当前项目目录下执行一条命令，用于调用已安装的技能（如浏览器自动化工具 ego-browser）。'
    + '一次只能执行一条命令，不能串联管道或重定向。执行前先用一句话告诉用户你要做什么。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '完整命令，例如：ego-browser --help' },
      purpose: { type: 'string', description: '一句话说明这条命令要做什么（会说给用户听）' }
    },
    required: ['command']
  }
};

export function buildTools(cfg, { skillsEnabled = false } = {}) {
  const tools = [TIME_TOOL, SEARCH_TOOL];
  if (skillsEnabled) tools.push(RUN_COMMAND_TOOL);
  return tools;
}

export async function executeTool(name, argsJson) {
  let args = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { /* 参数解析失败按空参处理 */ }
  const cfg = loadConfig();
  try {
    if (name === 'get_current_time') return await getCurrentTime(args);
    if (name === 'web_search') return await webSearch(args);
    if (name === 'run_command') return await runCommand(args, cfg);
    return { error: `未知工具 ${name}` };
  } catch (e) {
    return { error: e.message };
  }
}
