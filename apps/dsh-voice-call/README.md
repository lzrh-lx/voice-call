# dsh-voice-call（DeepSeek Harness 插件）

主推形态：语音 = 语音输入法。悬浮球渲染在 DSH 界面内（`shell.overlay` 槽位），说话即发消息，agent 回复自动朗读。

安装与配置见仓库根 README。

## 文件

```
dsh.plugin.json          DSH 插件清单（entry.inject: sessionController）
cordis.patch.yml         插件装载 patch（insert 一行）
package.json             dsh.bundle/dsh.client 声明 + file: 依赖入口
src/index.js             宿主侧：
                           · 本地桥接服务 127.0.0.1:8799（/task /prompt /call-state /call-endpoint /ping /diag）
                           · prompt 注入（sessionController.prompt + AbortSignal）
                           · 后台朗读器（sessionController.wait 轮询 → /speak）
                           · 记忆摘要注入（首句时随问题一起注入）
                           · 通话模式成对提示（接通限制选项组件 / 挂断恢复）
                           · 启动内置语音引擎（子进程，端口从 stdout 解析）
lib/client.js            浏览器侧（React，无构建依赖）：
                           · 悬浮球 + 可拖动面板（只显示状态）
                           · 麦克风采集（48k→16k 重采样，播放期间不上传——回声硬隔离）
                           · 播放（1.2s 预卷 + 200ms 无缝续排，DeepSeek PCM 24kHz 直入）
                           · 本地电平打断（RMS×4 帧）+ cancel_speak
                           · 多实例桥接发现（扫端口取最新 startedAt）
engine/                  语音引擎（voice-call-browser 的 server/ 复制品 + 定制）：
                           · realtime 只听写会话（ASR + VAD，不回答）
                           · DeepSeek TTS 流式（seq 隔离，可中断）
                           · /memory-digest、/speak、CORS
```

## 数据流

```
client(麦克风) --ws--> engine(ASR) --转写--> host /task
host --prompt--> DSH 会话（用户消息）
agent 回复 --> host 朗读器(wait 轮询) --> engine /speak
engine --DeepSeek TTS pcm--> client 播放
```

## 开发注意

- **改源码后必须复制到 `~/.dsh/profiles/desktop/node_modules/dsh-voice-call/` 并重启 DSH**（运行时读副本）
- engine/node_modules 在仓库中不存在，安装后 `ln -s ../../voice-call-browser/node_modules engine/node_modules` 或直接 `npm install ws`
- DSH 工具 DSL：`parameters` 是「属性名→schema」映射而非完整 JSON Schema；`output.schema` 需显式 `additionalProperties`；`render()` 必填
