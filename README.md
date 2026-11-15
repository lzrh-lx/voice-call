# voice-call · 和 agent 打电话

给 AI 编码助手（DeepSeek Harness）装一个「电话」：桌面右下角一颗悬浮球，点开拨号，**说话就是发消息**——你的话以普通消息出现在对话窗口，agent 像平时聊天一样回复，回复自动用语音念给你听。

> 形态参考豆包的语音电话，但大脑是你的 agent：它认识你的项目、能用装好的 skill、能真的干活（开网页、跑命令、改文件），而你全程只用嘴。

## 架构

```
你说话（麦克风常开，说完自动发送）
   ↓ ASR 引擎（qwen-omni realtime，只听不答）
一条「你」的消息 → sessionController.prompt 注入会话（= 打字发送）
   ↓
agent 正常回复（对话窗口完整可见，可用 skill / 工具）
   ↓ 后台朗读器轮询新回复（~0.5s）
DeepSeek TTS 流式合成 → 悬浮球播放（可打断）
```

**关键设计：agent 是唯一大脑。** 语音引擎不做任何回答，只负责「听」和「念」。因此：

- 对话窗口里的记录和语音内容完全一致
- agent 拥有会话上下文、记忆、全部能力
- 回答质量取决于你给 agent 配的模型，而不是语音模型

## 仓库结构

```
apps/
  dsh-voice-call/          DeepSeek Harness 插件（主推形态）
    src/index.js             宿主侧：注入消息、朗读器、本地桥接服务
    lib/client.js            浏览器侧：悬浮球 UI、采集/播放/打断
    engine/                  语音引擎（ASR+TTS sidecar，复用浏览器版的 server/）
  voice-call-browser/      浏览器版（独立形态 / 降级方案）
    SKILL.md                 跨宿主 skill（ZCode 与 DSH 的 ~/.agents/skills 均可扫描）
    server/                  Node sidecar：realtime 代理、工具、记忆、人设
    web/                     悬浮球通话页面
docs/
  zcode-panel-probe/       ZCode 内嵌面板可行性探针（结论：暂不可行，见 README）
```

## 安装（DeepSeek Harness 版）

```bash
# 1) 把插件链接进 DSH profile
cd ~/.dsh/profiles/desktop
node -e "
const fs=require('fs');
const d=JSON.parse(fs.readFileSync('package.json','utf8'));
d.dependencies['dsh-voice-call']='file:/path/to/repo/apps/dsh-voice-call';
if(!d.dsh.profile.bundles.includes('dsh-voice-call')) d.dsh.profile.bundles.push('dsh-voice-call');
fs.writeFileSync('package.json', JSON.stringify(d,null,2));
"
# 2) 用 DSH 自带 pnpm 安装
/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node \
  /Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs install
# 3) 重启 DeepSeek Harness
```

安装后：对话里说「**打个电话**」→ 右下角出现悬浮球 → 点开选人设 → 允许麦克风。

## 配置

引擎读取 `~/.voice-call/config.json`（首次运行自动生成模板）：

```jsonc
{
  "provider": "qwen",            // ASR 引擎：qwen | zhipu
  "qwenApiKey": "sk-...",        // 阿里百炼 Key（ASR 用）
  "qwenModel": "qwen3.8-omni-flash-realtime",
  "ttsProvider": "deepseek",     // TTS 引擎：deepseek | qwen
  "deepseekApiKey": "sk-...",    // DeepSeek 官方 Key（TTS 用）
  "deepseekTtsVoice": "stella",  // stella 女声 / tide 男声
  "memoryModel": "qwen-flash"    // 挂断后记忆抽取
}
```

- **ASR**：目前用阿里百炼 `qwen3.8-omni-flash-realtime`（流式 + 服务端 VAD，~0.014 元/分钟）。DeepSeek ASR 无流式/VAD，暂不可替换
- **TTS**：DeepSeek `/v1/tools/tts`（流式 PCM 24kHz，$0.225/万字符限时五折），或 qwen3-tts-flash 兜底
- **记忆**：按项目目录隔离（`~/.voice-call/memory/<项目键>/`），另有跨项目共享的用户画像 `_global/profile.json`；每通电话接通时自动注入，挂断后自动抽取

## 亮点实现（踩坑清单）

| 问题 | 解法 |
|---|---|
| `wait()` 立即返回 → 空转占满事件循环、DSH 假死 | 轮询循环强制 `sleep(500)` 让出时间片 |
| 语音消息排队卡住 | agent 用「提问/选项」组件会挂起会话 → 通话期间成对注入模式提示，挂断恢复 |
| 扬声器回声被当成用户说话 | 播放期间不上传麦克风音频（硬隔离）+ 本地电平判定打断 |
| 流式 PCM 分块"嘶"声 | 1.2s 预卷缓冲 + 200ms 无缝续排 + 奇数字节跨包对齐 |
| 两条 TTS 流字节交错 → 噪声 | 每段朗读带序号，新流开始即中止旧流 |
| 跨源 iframe 拿不到麦克风 | UI 直接渲染在宿主页面（shell.overlay），不走 iframe |
| 朗读内容和对话不一致 | 只读 `sessionController.wait()` 返回的最后一条 assistant 记录 |

## 浏览器版（可选）

适合没有 DSH 桌面端的场景（任意能跑 Node 的宿主，如 ZCode）：

```bash
cd apps/voice-call-browser
npm install
node scripts/install.mjs   # 安装到 ~/.agents/skills/voice-call-browser/
```

对 agent 说「用浏览器打电话」即触发。首次需在 `~/.voice-call/config.json` 填 Key。

## 已知限制

- 每轮延迟 = agent 生成 + TTS 首包（约 2-5 秒），非流式对话（「agent 当大脑」的固有代价）
- 长回答的朗读约 1.2 秒预卷后出声
- 交互式选项组件在通话期间被主动禁用（语音无法点选），挂断自动恢复
- ZCode 内嵌面板不可行：ZCode 用未公开的 content bundle 机制渲染第三方插件 UI（探针与结论见 `docs/zcode-panel-probe/`）

## License

MIT
