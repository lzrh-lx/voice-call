// 把源码同步安装到 ~/.agents/skills/voice-call/（ZCode 与 DSH 都自动扫描该目录）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const DEST = path.join(os.homedir(), '.agents', 'skills', 'voice-call');

const ITEMS = ['SKILL.md', 'README.md', 'server', 'web', 'scripts', 'package.json', 'package-lock.json', 'node_modules'];

fs.mkdirSync(DEST, { recursive: true });
let copied = 0;
for (const name of ITEMS) {
  const from = path.join(SRC, name);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(DEST, name), { recursive: true });
  copied++;
}
console.log(`[voice-call] 已同步 ${copied} 项到 ${DEST}`);
console.log('[voice-call] ZCode：新会话生效；DSH：重启后自动扫描。');
console.log('[voice-call] 之后对 agent 说「给我的 agent 打个电话」即可。');
