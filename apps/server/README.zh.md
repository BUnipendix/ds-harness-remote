# 自部署 Server

[English](README.md) · **中文**

单账号 Remote 中继，环境变量配置账号密码，Web 提供首页、登录和设备状态页。Server 不包含在 Host 插件 bundle 中，需要单独部署。

## 自部署页面

首页地址是 `/`，点击“开始使用”进入登录页；登录成功后进入 `/app/remote` 设备列表。Host 和客户端都填写同一个 Server 地址，并使用相同的账号密码登录。设备凭据由 Server 保存，Web 登录会话使用 HttpOnly Cookie。

## Docker 部署

```bash
cd apps/server
cp .env.example .env
# 编辑 .env，设置账号、密码和访问地址
docker compose up -d --build
```

打开 <http://localhost:8080>。设备凭据保存在 `server-data` 卷；停止使用 `docker compose down`。

若旧镜像启动时无法解析 `@dsh-remote/protocol`，更新源码后执行 `docker compose build --no-cache server && docker compose up -d server`。镜像显式包含 protocol 编译产物，并在构建阶段校验 Server 的模块加载；重建会保留数据卷。

发布镜像由 GitHub Tag 工作流构建。生产环境应使用 HTTPS 反向代理，不要直接把 Node 监听端口暴露到公网。

### 页面白屏或静态资源返回 403

`DSH_SERVER_PUBLIC_URL` 必须与浏览器实际访问的 origin 一致，包括 `http` / `https`、域名和非默认端口；不要填写容器内部地址或页面路径。例如通过 `https://remote.example.com` 访问时，在 `.env` 设置：

```dotenv
DSH_SERVER_PUBLIC_URL=https://remote.example.com
```

修改后执行 `docker compose up -d --force-recreate server`；仅 `docker compose restart` 不会更新环境变量。使用预构建镜像时可加 `--no-build`。保留现有数据卷，不要执行 `down -v`。

如果 JS/CSS 返回 403，且响应 JSON 中为 `AUTH_INVALID`，优先核对上述配置与请求的 `Origin`。Server 在静态资源处理前执行 origin 校验；因此首页可能打开，JS/CSS 却被拒绝，浏览器随后报告 MIME 为 `application/json` 并白屏。不要通过修改 MIME 或删除 origin 校验来绕过。若响应来自反向代理，则检查代理访问规则；代理应保留浏览器原始 `Origin`。

源码 Docker 构建报 protocol 入口无法解析时，也检查文件权限（`ls -ld packages/protocol packages/protocol/package.json`）。镜像会规范化发布文件的读取/目录遍历权限，并在最终 `node` 用户下校验模块加载。

## 本地启动

需要 Node.js 22、pnpm 9.15.4。在仓库根目录执行：

```bash
pnpm install
pnpm --filter @dsh-remote/protocol build
pnpm --filter @dsh-remote/server build
cp apps/server/.env.example apps/server/.env
```

编辑 `apps/server/.env`，设置账号和至少 12 字符的密码，然后启动：

```bash
cd apps/server
node --env-file=.env dist/main.js
```

打开 <http://localhost:8080>。Host 和客户端填写同一 Server 地址，使用同一账号密码登录。建议账号使用邮箱格式，以兼容现有客户端。

| 环境变量 | 用途 / 默认值 |
| --- | --- |
| `DSH_SERVER_ACCOUNT` | 必填，登录账号 |
| `DSH_SERVER_PASSWORD` | 必填，至少 12 字符 |
| `DSH_SERVER_PUBLIC_URL` | 浏览器访问地址，默认 `http://localhost:8080` |
| `DSH_SERVER_HOST` | 监听/端口映射地址，默认 `127.0.0.1`；局域网设为 `0.0.0.0` |
| `DSH_SERVER_PORT` | 默认 `8080` |
| `DSH_SERVER_DATA_FILE` | 默认 `data/state.json`，相对启动目录 |

公网使用 HTTPS 反向代理，并将 `DSH_SERVER_PUBLIC_URL` 设为实际域名；代理需支持 `/ws/v1/connect` 的 WebSocket Upgrade，空闲超时大于 75 秒。

## 功能

- 支持设备注册、凭据刷新、设备发现、Control 与端到端加密 Relay。
- 单进程运行；持久化保存 `data` 目录。重启后设备凭据保留，Web 需重新登录；修改密码后设备需重新授权。

验证：`pnpm --filter @dsh-remote/server test`。真实跨机与长期连接仍待回归。UI 复用来源见 [web/UPSTREAM.md](web/UPSTREAM.md)。

## 发布 Tag 检查

发布 Tag 必须与根 `package.json` 和 `packages/plugin/package.json` 的版本一致，例如 `v0.4.15`。Tag 工作流会执行 workspace check、测试、构建、插件 npm 打包、Browser 扩展打包和 SHA256 校验；Server Docker 镜像也从同一个 Tag 构建。

本地可先运行：

```bash
pnpm --filter './packages/**' -r build
pnpm -r check
pnpm -r test
NODE_ENV=production pnpm --workspace-concurrency=1 -r build
node scripts/verify-dsh-plugin.mjs
pnpm --dir packages/plugin pack --pack-destination /tmp/dsh-release-assets
```
