# voice-call-browser（浏览器版悬浮球）

独立形态：不依赖 DSH 桌面端，任何能执行 Node 命令的 agent 宿主（ZCode、DSH、Claude Code 等）都可用。

## 与 DSH 插件版的差异

| | DSH 插件版（主推） | 浏览器版 |
|---|---|---|
| 界面 | 宿主内浮层，绑定 agent 生命周期 | 浏览器标签页，agent 启动 sidecar |
| 对话注入 | prompt 直接进会话 | 会话由 realtime 模型承接（人设记忆内置） |
| 回答者 | 你的 agent | realtime 语音模型（人设） |
| 记忆 | 引擎侧文件，接通注入 | 同左 |

浏览器版的「回答」由语音模型（小暖/阿泽人设）完成，需要动手的任务通过 `ask_assistant` 工具转交宿主 agent。

## 安装

```bash
cd apps/voice-call-browser
npm install
node scripts/install.mjs     # 同步到 ~/.agents/skills/voice-call-browser/
```

## 使用

对 agent 说「**用浏览器打电话**」（明确说浏览器，避免和 DSH 插件版抢触发）。

首次使用需配置 `~/.voice-call/config.json`（见仓库根 README）。

## 文件

- `SKILL.md` — 跨宿主 skill 定义（触发词已收窄为浏览器场景）
- `server/` — Node sidecar：HTTP+WS 服务、realtime 代理（qwen/zhipu 适配器）、工具执行、记忆
- `web/` — 悬浮球通话页面（AudioWorklet 采集、24kHz 播放、打断、字幕、PiP 置顶）
