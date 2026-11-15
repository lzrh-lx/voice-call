import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 已安装技能的位置：~/.agents/skills 是两个宿主共用的目录
const SKILL_ROOTS = [
  path.join(os.homedir(), '.agents', 'skills'),
  path.join(os.homedir(), '.claude', 'skills')
];

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

export function listSkills() {
  const out = [];
  for (const root of SKILL_ROOTS) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const dir = path.join(root, name);
      // 技能目录常是符号链接（如 ego-browser → 安装目录），必须用 stat 跟随判断
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
      const file = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        out.push({ name: meta.name || name, dir, description: meta.description || '', body });
      } catch { /* 跳过损坏的技能 */ }
    }
  }
  return out;
}

/**
 * 生成注入到实时语音模型 instructions 里的技能说明块。
 * 只输出「有哪些技能 + 关键用法」，总量受 maxInjectChars 限制，
 * 避免把实时语音模型的上下文撑爆（音频通话上下文很小）。
 */
export function skillInstructions(cfg) {
  if (!cfg.skills?.enabled) return '';
  const all = listSkills().filter(s => s.name !== 'voice-call'); // 语音通话自身不注入，避免自我指涉
  if (!all.length) return '';
  const active = cfg.skills.active || ['*'];
  const picked = active.includes('*') ? all : all.filter(s => active.includes(s.name));
  if (!picked.length) return '';

  const cap = cfg.skills.maxInjectChars || 2500;
  let used = 0;
  const parts = [];
  parts.push('【可用技能】你可以在通话中调用本机已安装的技能来真正干活（比如浏览器操作）。'
    + '每个技能说明提供了命令用法；需要执行时调用 run_command 工具，一次只跑一条命令，命令要具体。'
    + '执行较慢时先用一句话告诉用户你在做什么，再调用工具。');

  for (const s of picked) {
    const header = `\n### 技能：${s.name}\n简介：${s.description}`.slice(0, 600);
    if (used + header.length > cap) break;
    parts.push(header);
    used += header.length;
    // 只截取 SKILL.md 最前面的核心用法，避免超长
    const room = Math.min(cap - used, 900);
    if (room > 120) {
      const body = s.body.replace(/\s+/g, ' ').trim().slice(0, room);
      parts.push('用法摘要：' + body);
      used += body.length;
    }
  }
  return parts.join('\n');
}
