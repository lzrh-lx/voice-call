# ZCode 内嵌面板探针（不可行结论存档）

> 时间：2026-11-13 · 结论：**ZCode 第三方插件暂无法内嵌自定义 UI 面板**

## 背景

voice-call 曾尝试把通话悬浮球做进 ZCode 应用内（类似官方 documents/pdf 插件的侧栏面板）。

## 已验证的事实

- ZCode 官方插件（documents/pdf）通过 `plugin.json` 的 `ui.surfaces` + MCP resource `ui://<server>/panel.html`（mimeType `text/html;profile=mcp-app`）声明内嵌面板
- 面板资源 `_meta` 支持 `ui.permissions = { microphone: {} }`（宿主白名单含 microphone）与 `zcode/csp.connectDomains`（覆盖 fetch/WebSocket）
- 第三方插件按此格式声明后：宿主**确实会调用 `resources/read` 拉取面板 HTML**（本探针的 `mcp.log` 有记录），但**内容不进入渲染管线**——面板白屏、`ui/initialize` 握手超时

## 排查过程

1. 手写 postMessage JSON-RPC 客户端 → 握手超时
2. 换官方 `@modelcontextprotocol/ext-apps` SDK（官方面板同款）→ 仍超时
3. 排除 CSP（宿主 CSP 允许 `script-src 'unsafe-inline'`）、排除脚本错误（HTML 在独立浏览器中完全正常）、更换 resource URI 绕过缓存、加 `<img>` 信标 → 信标从未到达，说明 HTML 根本没被渲染
4. 反编译 app.asar 发现：宿主把面板内容走 **content bundle**（manifest + files + entry + sha256 缓存）管线，该约定未公开，第三方资源在 `bundle_entry_missing` / `bundle_resource_missing` 处被丢弃

## 结论

content bundle 是 ZCode 未公开的内部机制，官方插件随应用内置打包。等官方文档或插件模板发布后再重试；此前 voice-call 的 ZCode 形态保留浏览器悬浮球方案（`apps/voice-call-browser`）。

## 探针文件

- `mcp/server.mjs` — 注册面板资源 + 记录宿主请求 + 探针结果落盘
- `ui/panel.html` — 诊断面板（安全上下文/麦克风/WS/AudioWorklet/PiP 检测）
- `ui/src/main.js` — ext-apps SDK 版面板脚本（需 esbuild 打包）
