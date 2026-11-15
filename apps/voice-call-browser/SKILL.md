---
name: voice-call
description: 与你的 agent 打语音电话（豆包式悬浮球通话，实时语音、可打断、带记忆和工具）。当用户说「打电话」「语音通话」「给我的 agent 打个电话」「电话里聊」等，或希望用说话的方式和 agent 交流时使用。
---

# voice-call：给用户打一通语音电话

本技能会启动一个本地语音通话服务，并在浏览器里弹出「悬浮球」。用户在悬浮球上选人设、点拨号，即可与 agent 实时语音通话（GLM-Realtime 端到端，支持打断）。挂断后 agent 自动整理记忆，下次通话能记住聊过的内容。

**本文件所在目录即「技能目录」**，下述 `<skill_dir>` 指它。`server/`、`web/`、`node_modules/` 都在技能目录内。

## 执行步骤

1. **检查 API Key 与引擎配置**（已配置则跳到第 2 步）：

   ```bash
   cat ~/.voice-call/config.json 2>/dev/null
   ```

   支持两个语音引擎（`provider` 字段二选一）：

   - `"zhipu"`（默认）：需要 `apiKey`（智谱 Key，https://open.bigmodel.cn/usercenter/apikeys ）
   - `"qwen"`：需要 `qwenApiKey`（百炼 DASHSCOPE Key，https://bailian.console.aliyun.com/?apiKey=1#/api-key ）+ `qwenWorkspaceId`（百炼控制台左上角工作空间 ID）；通话约 0.014 元/分钟，最省

   若对应 Key 为空且环境变量（`ZHIPUAI_API_KEY` / `DASHSCOPE_API_KEY`）也未设置：请用户提供 Key，然后写入（示例为 qwen 引擎）：

   ```bash
   mkdir -p ~/.voice-call
   # 把 <Key>、<工作空间ID> 替换后再执行
   cat > ~/.voice-call/config.json <<'EOF'
   {
     "provider": "qwen",
     "qwenApiKey": "<Key>",
     "qwenWorkspaceId": "<工作空间ID>",
     "qwenRegion": "cn-beijing",
     "qwenModel": "qwen3.8-omni-flash-realtime",
     "port": 8710
   }
   EOF
   ```

   用智谱则把 `provider` 改回 `"zhipu"` 并填 `apiKey`。切换引擎不需要改其他任何文件。

2. **后台启动通话服务**（令牌自动生成，悬浮球只能凭服务输出的带令牌链接打开）：

   ```bash
   VOICE_CALL_PROJECT_DIR="$(pwd)" node "<skill_dir>/server/index.mjs"
   ```

   以**后台任务**方式运行，**必须在用户当前项目目录下启动**——`VOICE_CALL_PROJECT_DIR` 决定这通电话用哪一套项目记忆（不传则取进程工作目录，效果相同，但显式传入更稳妥）。

   等它输出，第二行即：

   `[voice-call] 悬浮球已就绪: http://127.0.0.1:<端口>/ball.html?token=<令牌>`

   记下这个完整 URL（同时会打印「当前项目」和「语音引擎」）。若 8710 被占用，服务会自动换端口，以输出为准。

3. **打开悬浮球**（把 URL 替换为上一步拿到的实际地址）：

   ```bash
   open "http://127.0.0.1:<端口>/ball.html?token=<令牌>"      # macOS
   # Linux 用 xdg-open "<url>"
   ```

4. **告知用户**：悬浮球已出现在浏览器右下角，点球选人设（如"小暖"）即可拨号；通话中点球展开面板（静音/字幕/挂断），Chrome 还可点"置顶"让球浮在所有应用之上；说话时对方会停——直接说就行。首次拨打浏览器和系统会各弹一次麦克风授权，请允许。

## 注意事项

- 服务随本次 agent 会话结束自动退出，悬浮球会变灰提示"请通过 agent 重新打开"——这是设计使然（悬浮球绑定 agent 存活）。
- 直接访问 `127.0.0.1:<端口>` 不带令牌只会看到引导页，无法打开悬浮球。
- **记忆按项目隔离**：每个项目一套记忆（按工作区路径区分），另有一份跨项目共享的用户画像（姓名/职业/偏好）。切项目交谈不会串味。
- **通话中可调用本机已安装的 skill**：启动时会把 `~/.agents/skills/*/SKILL.md` 的说明注入人设，模型据说明调用 `run_command` 执行白名单命令（默认 `ego-browser`、`python3`、`node`），在用户项目目录下运行。要增减白名单或关闭该能力，改 `config.json` 的 `skills` 字段。
- 通话费用：智谱 glm-realtime 约 0.18 元/分钟；阿里 qwen3.8-omni-flash-realtime 约 0.014 元/分钟。由用户自己的 API Key 支付。
- 数据目录 `~/.voice-call/`：`personas.json` 人设（可自行增删）、`memory/` 记忆、`transcripts/` 转写存档。
- 排错：没声音 → 检查麦克风授权；提示"未配置 API Key" → 回到第 1 步；端口不通 → 用服务实际输出的端口。
