# Remote Tools injection

The Host plugin can expose its `remote_*` tools to the local Harness session. These tools let a session discover trusted Remote Hosts and workspaces, then perform explicitly requested operations such as reading sessions, sending messages, waiting, uploading, or downloading files.

Injection is **enabled by default**. Turn off **Inject Remote Tools** in the detailed Remote settings when a session should not receive these tools. The setting is stored with the Host profile and takes effect after restarting the Host. Disabling it removes the tools from newly started sessions; it does not revoke existing Remote authorization or change the encrypted transport.

The tools are bounded by the same account, device trust, workspace authority, permission, and operation receipt checks as the native Remote UI. Tool descriptions treat Host and workspace names as untrusted data, and mutation tools require user authorization and an operation ID.

中文说明：Host 插件可以把 `remote_*` 工具注入本地 Harness 会话，用于发现受信任的 Remote Host/工作区，以及在用户明确请求后读取会话、发送消息、等待、上传或下载文件。该开关**默认开启**，在详细 Remote 设置中关闭「注入 Remote Tools」即可停用，重启 Host 后生效。关闭只影响新启动会话中的工具注入，不会撤销已有授权或改变加密连接。
