# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Conversation image restoration (Issue #159, 2026-10-25)

Android 已移除 rc.2 ApiProxy 客户端；Harness 仅接入 Typert Remote，旧 Host 不再降级。
Harness 历史图片保留 attachmentId 与所属 sessionId，按需通过官方 session/attachment 读取，复用 Typert 有界 transfer。AI 纯图片回复与工具结果
图片不再丢弃，Markdown 工作区图片复用授权 workspaceFiles 预览，不读取手机同名路径。
图片只在组件内存中保存，8 MiB 与现有像素/尺寸限制保持生效；导航、断线或连接替换后拒绝
迟到结果，支持全屏查看与重试。HTTP(S)/协议相对外部图片仍仅显示描述，不自动联网；
CodeX/Claude 不因此获得新的文件读取权限。PNG 发送报错尚无复现，不宣称本次已修复。
本次原生真机与真实跨设备图片显示验收仍待完成。

验证：Android check、36 文件 / 209 tests、production Hermes export 与 git diff --check
通过；保留 Metro 的 @noble/hashes/crypto.js exports fallback 警告。未构建或发布新 APK。
