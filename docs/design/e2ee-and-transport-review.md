# 端到端加密可行性与传输选型审查

日期：2026-10-22
范围：`packages/crypto`、`packages/plugin`、`packages/webrtc`、`apps/server`、`apps/browser`、`apps/android`、`apps/vscode` 及 `docs/protocol.md`。
结论优先级：先给判定，再给证据与改造路径。

---

## 0. 结论摘要

| 问题 | 判定 | 说明 |
| --- | --- | --- |
| 现在的协议层是不是真 E2EE | **是，但仅对"诚实但好奇"的 Server 成立** | 业务帧只在 Noise IK 之后发送；Server 只转发密文，代码层面无明文路径。 |
| 能不能改造成"Server 无论如何都看不到对话" | **能** | 缺口不在密码学，而在**身份分发**与**Web 客户端托管**。两处都可改造，代价不同。 |
| 让 Server 看不到，最大的阻塞是什么 | **F1 身份分发是 TOFU**（P0） | Server 是公钥的唯一来源，恶意/被强制 Server 可静默 MITM，且没有任何机制能让任一端发现。 |
| 第二个阻塞 | **F2 Remote Web 与 Server 同源**（P0，结构性） | Web 侧的 JS 由 Server 下发，密钥在 Server 可控的页面里生成；这是分发问题，不是密码问题。 |
| 打洞/代理该怎么选 | **WebRTC + TURN 为主干，WSS Relay 兜底，代理支持补齐** | 现有 WebRTC 选路是对的；自部署 Server 目前是 relay-only，缺 signaling 与 TURN。代理支持（企业 HTTP 代理）完全缺失。 |

一句话：**协议不用改，改的是"你怎么知道对面那把公钥是真的"和"谁来给你发前端代码"。**

---

## 1. 审查方法与证据优先级

按"运行时行为 → 抓包 → 实际下发资源 → 进程配置 → 持久化状态 → 源码"的顺序取证。本次为纯静态审查（无可运行的双机环境），因此结论以源码为准，并对每个结论标注可复现的代码位置。

关键判定标准：**Server 能否在某一时刻获得能解出业务明文的密钥，或能否让某一端认为"这就是对端"。** 只要后者成立，前者就跟着成立。

---

## 2. 核验：协议层 E2EE 当前成立到什么程度

### 2.1 密码原语与握手

`packages/crypto/src/noise.ts`：

- 固定套件 `Noise_IK_25519_ChaChaPoly_SHA256`（`NOISE_IK_PROTOCOL`，L11），并在 L48–50 校验 provider 返回的套件名，不静默降级。
- 包装的是维护中的 `@lukeburns/clatterjs`，不是自研状态机（L39–47）。
- 握手完成后、以及每次 `readHandshake` 后都执行 `verifyRemoteStatic()`（L74、L109、L113–119），远端 static key 与本端期望值恒定时间比对，不符即 `PEER_IDENTITY_MISMATCH` 并 `destroy()`。
- prologue 绑定 `DSH-REMOTE\0v=1\0connection=…\0host=…\0client=…`（L138–145），能防握手跨连接/跨设备重放。
- 顺序错误（`assertHandshake`，L121–127）、已完成后再读写（L123）都 fail closed。

评价：实现是合格的。IK 握手包含 ephemeral–ephemeral DH，因此**传输密钥具备连接级前向保密**；长期密钥只是身份密钥，不直接用于加密业务数据。

### 2.2 业务数据是否真的只在 Noise 之内

Host 侧 `packages/plugin/src/server-connection.ts` 的全部 `sendControl` 目标是：`hello`、`pong`、`connect.accepted`/`rejected`、`secure.handshake`、`signal.*`、`transport.selected`、`relay`（L232/323/386–438/497/674/680/773/787）。没有任何一帧携带业务字段。

自部署 Server 侧 `apps/server/src/gateway.ts` 的 `handle()` 对 `relay` 只做两件事（L157–162）：校验 `link.stage === 'ready'`、校验外层 counter 单调，然后原样转发给对端。没有 `JSON.parse`、没有解密、没有落库。`secure.handshake` 同理（L152–156），只做 stage 推进并转发。

`apps/server/src/store.ts` 落盘 schema 只有 `{ descriptor, revoked, lastSeenAt }` 与 token 摘要（L14、`Only token digests and public identities reach disk`）。`descriptor` 的字段集合由 `hostDeviceDescriptorSchema` / `clientDeviceDescriptorSchema` 固定为 `deviceId/name/role/platform/identityKey/clientVersion(/harnessVersion)`（`packages/protocol/src/index.ts` L839–857），不含任何业务字段。

**结论：对诚实但好奇的 Server，当前实现确实是 E2EE。** 之前审查得到的"服务器可以看到所有对话"如果指的是"协议被破解/明文上传"，那是不成立的；但换成更强的威胁模型，它就成立，见第 3 节。

### 2.3 一个容易被忽略的实现事实

Noise 握手帧走的是 **Control 通道**（`sendHandshake` → `secure.handshake`，`packages/webrtc/src/adaptive-transport.ts` L208–215），而不是数据通道。这本身不是漏洞（密文不透明），但它意味着：

- **Server 完整参与了握手的每一跳**，具备做替换的物理位置；
- 握手与最终选中的数据路径解耦，Server 无法用"我没碰数据面"来证明清白。

---

## 3. 三个缺口

按严重度排序。F1、F2 是"能不能真正做到 E2EE"的问题；F3 是"做到之后还剩多少泄露"的问题。

### F1（P0）身份分发是 TOFU，Server 可静默 MITM

**证据链：**

1. Client 从 Server 拿 Host 公钥并**首次即信任**：
   `packages/plugin/src/client-connection.ts` L245–268 `authorizeHostPeer()`：
   ```ts
   const descriptor = await this.context.server.deviceFor(serverDevice.deviceId)
   assertAuthorizedHost(serverDevice, descriptor)
   const existing = this.context.identities.trustedPeer(descriptor.deviceId)
   if (existing !== undefined && existing.publicKey !== descriptor.identityKey) throw ...
   ...
   return this.context.identities.trustPeer({ publicKey: descriptor.identityKey, ... })
   ```
   只在**已存在**且**不一致**时才拒绝。首次连接无任何校验。

2. Host 侧完全对称：`packages/plugin/src/server-connection.ts` L400–420，从 `connect.incoming` 携带的 `clientIdentityKey`（由 `gateway.ts` L128 从 `store` 里的 descriptor 填充）固定 Client 公钥，同样是首见即信任。

3. `packages/plugin/src/identity-store.ts` L136–146 `trustPeer()` 直接写入 `trusted-peers.json`，没有 `verified` 概念；L185–188 的 `fingerprint()` 存在，但只用于日志与本地一致性校验。

4. 文档层面已经承认这个模型：`docs/plugin-integration.md` L419 明确写 Client 通过 `GET /api/v1/devices/{hostDeviceId}` 获取并固定 Host 的 `identityKey`，Server "只路由密文"。

5. 唯一的"人工核验"在 VS Code：`apps/vscode/src/extension.ts` L277–278 弹出 `Trust “<name>”? Verify its identity fingerprint: <fp>`。但**这个 fingerprint 本身就来自 Server**，用户没有任何可与之对比的第二来源（Host 端没有把自身 fingerprint 以可比对形式暴露给用户），所以它实际只起到"变更检测"作用，起不到"身份认证"作用。

**攻击过程（恶意或受强制 Server，5 步）：**

```text
1. Client 请求 Host descriptor
   -> Server 返回 {deviceId: H, identityKey: PK_server_1}   (替换)

2. Client 用 PK_server_1 做 Noise IK initiator
   -> Server 作为 responder 完成握手（它知道 PK_server_1 对应的私钥）
   -> Client 认为"已与 H 建立 E2EE"

3. Server 作为 initiator，用真实 Host 公钥 PK_H 与 Host 握手
   -> Host 收到 connect.incoming，clientIdentityKey 也被 Server 换成 PK_server_2
   -> Host 首见即信任，握手成功

4. 两条 Noise 通道都以"完全可信"状态运行

5. Server 在中间解密 -> 记录 -> 重新加密转发
   任一端都不会告警：pin 的正是 Server 给的假密钥，且此后永远一致
```

**为什么现有防线全都失效：**

| 现有机制 | 对 MITM 的作用 |
| --- | --- |
| identity pinning | 无效。pin 的是攻击者密钥，之后一直一致，永不触发 mismatch。 |
| prologue 绑定 connectionId/deviceId | 无效。connectionId 由 Server 生成。 |
| 账号 membership | 无效。攻击者就是账号服务本身。 |
| fingerprint 展示 | 无效。无带外对比对象。 |
| Noise 握手校验 | 无效。密码学上完全正确，错的是输入。 |

**判定：可改造。** 这是本审查里唯一"改完就能真正宣称 E2EE"的项。方案见第 4 节。

### F2（P0，结构性）Remote Web 与 Server 同源

**证据：**

- `docs/server.md` L17–20：`Server、Remote Web 和 Admin 是一个站点：一个 REMOTE_PUBLIC_URL、一个进程/API 入口`。
- `apps/browser/src/background.ts` L7 与 L262/273：扩展只"打开**同源** Remote Web"，自身不承载 Remote Client runtime（`docs/README.md` L10、`docs/server.md` L346–349）。
- 本仓库不实现 Remote Web（`apps/web`、`apps/server-web` 被 AGENTS.md 明确列为禁用目录）。

**后果：** Web 会话里，Noise 私钥是在**Server 下发的 JS 里**生成和使用的。Server 只需替换一次静态资源，或在构建时植入一行 `fetch('/collect', {body: plaintext})`，即可拿到全部明文，**连 MITM 都不需要**。此处 E2EE 在密码学上无误，在分发上不成立。

**判定：可改造，但不能在"同源托管"这个前提下改造。** 必须改动分发方式，见第 5 节。这是一个**产品/部署决策**，不是代码缺陷。

### F3（P1）元数据、padding 与密钥生命周期

| 项 | 现状 | 后果 |
| --- | --- | --- |
| 长期连接 rekey | 未实现（`docs/TODO.md` L218） | 单连接密钥长期有效；无 post-compromise 恢复。 |
| 帧长度隐藏 | 无 padding。Relay 帧是 `base64url(Noise密文)`，长度 ≈ `(明文 + 16B Poly1305 tag) × 4/3` | Server 可精确估算每次 Prompt/回复/工具输出的字节数，并对消息类型做指纹分类。 |
| 消息计数 | Relay 外层 counter 单调递增且明文 | 可精确统计消息条数 = 对话轮次与工具调用次数。 |
| 心跳 | 固定 25s（`gateway.ts` L36；`adaptive-transport.ts`） | 在线/离线时间可精确到 25s 粒度。 |
| 连接生命周期 | 无最大时长 | 长连接可被长期流量分析。 |

**判定：可改造，成本中等，收益是把"内容不可读"提升到"连交互形态都难以推断"。** 见第 6 节。

---

## 4. F1 改造方案：让 MITM 不可能，而不是不可能被发现

三个选项，按侵入度排序。

### 方案 A：带外指纹比对（最小改动，1–2 天）

Host 端在本地 UI/CLI 暴露自身 fingerprint（`identity-store.ts` L185 已有实现），Client 首次连接时要求用户比对后确认；`trustPeer` 增加 `verifiedBy: 'user' | 'server'` 与 `verifiedAt`。

- 优点：不动协议、不动 Server。
- 缺点：每个新 Client 都要人工比对；UX 差；极易被用户跳过；仍是"人肉防线"。
- 结论：**应做，但只能作为过渡与兜底**，不能作为唯一方案。

### 方案 B：结构化配对，密钥不经 Server 传递（推荐）

把"Host 公钥"从 Server 的 REST 响应里剥离，改为**带外通道**送达 Client。

配对载体（任选，可并存）：

```text
dshpair://v1?h=<hostDeviceId>&k=<identityKey>&n=<nonce>&e=<expiresAt>&s=<hmac>
（不能压缩成短码：32 字节公钥无法用几字符承载，而"短码到公钥"的映射若经 Server 解析，就违反了 I2）
或 QR（Android 已有 qrcode-generator + react-native-svg，直接复用）
```

协议改动（`docs/protocol.md` §8 新增小节）：

1. Host 调 `POST /api/v1/pairings` 生成一次性配对记录，Server 只保存 `hash(secret)` 与 TTL，**不保存也不参与校验 `identityKey`**。
2. Client 通过二维码拿到 `identityKey`，**直接用它做 Noise IK 的 `rs`**，不再从 descriptor 取。
3. Host 侧对称：Client 的公钥由 Client 在配对 payload 里自带并由 Host 本地记录；或反向配对（Client 出码、Host 扫）。
4. 握手成功后，双方把对端标记 `verifiedBy: 'pairing'`；此后 pin 生效，密钥变更即拒绝（已有逻辑）。
5. Server 的 `connect.incoming.clientIdentityKey` 降级为**提示字段**：与本地 verified pin 不一致时拒连，一致时才使用。

关键性质：**Server 参与了配对码的传输也没关系**，因为它无法在不知道 `secret` 的情况下把 Client 的 `rs` 换掉——`rs` 直接来自带外 payload。这比"签名 descriptor"强，因为签名密钥本身也得先可信。

### 方案 C：Key transparency 日志（规模化，2–4 周）

Server 维护 append-only Merkle 日志，记录 `(deviceId, identityKey, epoch)` 的承诺；Client 首次连接时校验包含证明 + 一致性证明。类似 Signal 的 KT / CONIKS。

- 优点：无需每次人工配对，可检测 Server 的全局替换与分裂视图。
- 缺点：需要 Server 侧新基础设施、审计者角色、gossip 机制；跨仓库改动。
- 结论：**B 落地后再评估**。B 解决单用户场景，C 解决"多设备 + 长期"场景。

### 推荐组合

```text
现在：B（Host 出码，Client 扫码/输码）→ 覆盖 Desktop/Android/VS Code 首次接入
同时：A（任何 server-sourced pin 一律标注 unverified，UI 显式区分）
以后：C（当设备数 > 3 或需要免人工时）
```

工程细节：

- `TrustedPeer` 增加必填 `verification: 'pairing' | 'user' | 'unverified'`；`trustPeer` 拒绝在 `verification === 'unverified'` 且已有 `pairing` 记录时降级。
- Desktop Remote Header 的加密状态文案必须区分：`E2EE（未验证主机）` vs `E2EE（已验证主机）`。**这是本次改造的验收点之一**——现在一律显示"已加密"，属于过度承诺。
- 新增 `packages/plugin/tests/e2ee-mitm.test.ts`：内置一个恶意 Server（复用 `apps/server` 的 gateway，改为在 descriptor 里返回攻击者公钥），断言改造前握手成功且业务可被解密、改造后连接被拒。**这个测试是这次改造的核心交付物**——没有它，改造无法被证明有效。

---

## 5. F2 改造方案：把 Web 前端从 Server 的信任域里拿出来

前提：只要 JS 由 Server 下发，Web 就没有 E2EE。三选一。

| 方案 | 做法 | 有效性 | 成本 |
| --- | --- | --- | --- |
| 5.1 扩展即客户端 | Remote Web runtime 打进 Chrome/Edge 扩展，`chrome-extension://` origin 加载，不走 Server 静态资源 | **强**。扩展由商店签名，Server 无法替换 | 中高（要把 `apps/web` 的 runtime 搬进 MV3，CSP 与体积约束） |
| 5.2 静态站独立 origin | 前端部署到 Pages/对象存储/独立域，Server 只提供 API + Relay；跨域用 Bearer 替代 cookie | **强**（前提是前端产物有独立发布与可验证的构建） | 中（CORS、cookie→Bearer、部署链路） |
| 5.3 Server 下发 + SRI + 可重现构建 | 保留同源，但每版产物有签名清单，扩展/用户校验 | **弱**。校验器也在同一 origin，只能防第三方篡改，防不了 Server 自己 | 低 |

推荐：**5.2 为主体，5.1 作为"高安全模式"**。5.3 只能算缓解，不能算修复。

配套注意：

- cookie 方案（`dsh_session=…; SameSite=Strict`，`apps/server/src/server.ts` L63）在跨 origin 后会失效，需切到 Bearer + CORS 白名单，并保留 CSRF 防护。
- 若短期不动，必须在 `docs/end-to-end-encryption.md` 与产品 UI 里明确写：**Web 端的 E2EE 信任锚是 Server**。当前文档（§5 表格）给人的印象是 Server 一律读不到内容，这在 Web 路径上不准确。

---

## 6. F3 加固方案

1. **Rekey**：`NoiseIkSession` 增加 `rekey()`，在已认证通道上跑一次新的 IK（用当前 ephemeral 派生的 key 做认证，或直接复用 `connectionId` 换新 prologue），阈值建议 2^20 条消息 / 1 小时，以先到者为准。禁止原地复用 nonce 空间。
2. **Padding**：Relay 载荷统一补齐到 `{256, 1024, 4096}` 桶，桶内随机长度，真实长度放在 Noise 明文头里。这样 Server 只能看到"某个桶"，看不到精确字节数。
3. **Counter 混淆**：外层 counter 改为 `counter = seq * k + noise`（Server 只校验单调，不要求 +1），或者干脆只做速率限制不暴露精确条数。
4. **心跳抖动**：25s 固定 → 20–35s 随机；空闲时降频。
5. **连接最长生命周期**：例如 12 小时强制重建连接，配合 rekey。

收益评估：这几项不改变"Server 能不能读"，但把 Server 从"能画出完整对话时序图"降到"只知道大致活跃时段"。对"服务器可以看到所有对话"这个诉求，属于补充而非核心。

---

## 7. 打洞与代理：选型

### 7.1 现状盘点

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| WebRTC ICE / STUN | `packages/webrtc/src/rtc-adapter.ts`、`adaptive-transport.ts` | 已实现，支持 host/srflx/relay candidate 分类与诊断 |
| LAN/P2P/TURN/Relay 自适应选路 | `adaptive-transport.ts` L343–404 | 已实现，按 capability 协商 |
| TURN 短期凭证 | `packages/plugin/src/server-api.ts` L378–384 → `GET /api/v1/turn/credentials` | 客户端已实现，依赖 Server 提供 |
| Host 侧 RTC 后端 | werift（`native-rtc-helper.ts`） | 已实现 |
| 自部署 Server 的 WebRTC | `apps/server/src/gateway.ts` L88 `webrtcEnabled: false`；L151 `signal.*` 直接 `return`；L123 强制 `relay` | **仅 Relay** |
| 自部署 Server 的 TURN 凭证端点 | `apps/server/src/server.ts` 路由表 | **不存在** |
| 企业 HTTP/SOCKS 代理 | `adaptive-transport.ts` L126 `new WebSocket(this.url)` | **不支持**（无 agent / ProxyAgent） |

### 7.2 打洞机制选型

| 机制 | 覆盖率 | 延迟 | 浏览器可用 | 结论 |
| --- | --- | --- | --- | --- |
| WebRTC ICE（直连） | 中等（对称 NAT 失败） | 最低 | 是 | **主干** |
| TURN（UDP/TCP/TLS） | 高 | 中 | 是 | **首选兜底** |
| WSS Relay | 最高（只要能上 443） | 高 | 是 | **最终兜底** |
| Tailscale/NetBird 类 overlay | 高 | 低–中 | 否（需装客户端） | **零代码可选项**，文档推荐给用户 |
| 自研 UDP 打洞 | — | — | 否 | **不推荐**：WebRTC 已覆盖，重造需自行处理对称 NAT、保活、MTU、拥塞控制 |

结论：**保持 WebRTC 作为唯一打洞机制，把 TURN 补齐，Relay 永远保留。** 不要引入第二套打洞协议——现有 `packages/webrtc` 的抽象已经足够，新增协议会让 Noise 之上的状态机分裂成两条路径，收益远小于维护成本。

### 7.3 具体配置建议

**ICE 侧（`rtc-adapter.ts` / `webrtc` 配置）：**

```ts
new RTCPeerConnection({
  iceServers,                      // STUN x2 + TURN(udp) + TURN(tcp) + TURN(tls:443)
  iceTransportPolicy: 'all',       // 不要预设 'relay'，让 ICE 自己探
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
  iceCandidatePoolSize: 2,         // 预收集，缩短首连
})
```

- 同时下发 IPv4 与 IPv6 STUN，`candidate` 家族不要过滤（当前 `summarizeAddress` 只做分类，不拦截，这点是对的）。
- 保留现有 `onDiagnostic` 的 candidate 过滤日志，但**不要**因为 VPN/overlay 地址就丢弃 candidate —— `summarizeIpv6Scope` 把 `fd7a:115c:a1e0::/48` 标为 `cgnat` 只是分类，判定为 P2P 而非 LAN，行为正确。

**TURN 侧（部署建议）：**

```conf
# coturn：只中继密文，Noise 在其上
listening-port=3478          # UDP + TCP
tls-listening-port=5349      # TURNS；要落到 443 需独立 IP 或在前置 haproxy/nginx 做 SNI 分流
use-auth-secret
static-auth-secret=<TURN_SECRET>
realm=dsh.example.com
no-multicast-peers
# 短期凭证：Server 用 HMAC(secret, "expiry:deviceId") 生成 username/credential
```

- 凭证 TTL 建议 600s，与 `connectionId` 绑定。
- `turns:443` 与 HTTPS 443 共存需要独立 IP 或 TLS 分流（SNI），部署文档必须写明，否则会踩坑。

**自部署 Server 需要补的两块：**

1. `GET /api/v1/turn/credentials?connection_id=…`：校验 device token + link 归属，返回 HMAC 短期凭证。**不要**返回长期静态凭证。
2. `signal.*` 转发：当前 `gateway.ts` L151 直接丢弃。补齐时必须在 link 已 `accepted` 且 stage 校验通过后才转发，且转发内容仍是 SDP/ICE 明文——这没问题，但要在 `docs/end-to-end-encryption.md` §5 的"Server 可以看到"表格里补上"ICE candidate / SDP"这一行（现在只写了"WebRTC signaling、ICE/TURN 协调数据"，可以更明确）。

**代理侧：**

- Node/Desktop 的 `ws` 连接需支持 `agent`：读 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`，用 `undici` 的 `ProxyAgent` 或 `https-proxy-agent`。
- REST 请求（`server-api.ts`）同样要支持代理。
- **代理下 WebRTC 必然失败**（UDP 被拦），应在检测到代理配置时直接走 Relay，跳过 ICE 尝试，避免 15s 握手超时（`handshakeTimeoutMs ?? 15_000`）。
- 这项目前是硬伤：企业环境下 `new WebSocket(url)` 会直接连不通，而文档却承诺"能上 WSS 就能用 Relay"。

**移动端：** Android 的 FGS + WAKE_LOCK 已被厂商冻结（小米日志 `frozen uid`），这与打洞无关，但会影响"长连接维持"，需要与 rekey/心跳抖动一起评估。

### 7.4 场景 → 路径决策表

| 场景 | 首次尝试 | 兜底 | 备注 |
| --- | --- | --- | --- |
| 同局域网 | ICE host candidate | TURN → Relay | 现有 LAN 判定已区分 overlay 地址 |
| 家用 NAT（锥形） | ICE srflx | TURN → Relay | |
| 对称 NAT / CGNAT | TURN udp | TURN tcp → TURN tls:443 → Relay | |
| 企业只放 443 | TURN tls:443 | Relay | 需代理支持 |
| 强制代理（TLS inspection） | Relay（跳过 ICE） | — | 依赖 §7.3 代理改造 |
| 老版本/受限 Server | Relay | — | `webrtcEnabled: false` 时已有降级 |

---

## 8. 路线图

| 阶段 | 内容 | 依赖 | 估算 |
| --- | --- | --- | --- |
| P0-1 | MITM 回归测试（恶意 Server fixture），先让现状失败 | 无 | 1 天 |
| P0-2 | 配对流程（Host 出码 → Client pin），`verification` 字段与 UI 区分 | P0-1 | 4–6 天 |
| P0-3 | 文档与 UI 的诚实化：Web 端信任锚、未验证主机标识 | 无 | 1 天 |
| P1-1 | 自部署 Server 补 signaling 转发 + TURN 凭证 + coturn 部署文档 | 无 | 3–4 天 |
| P1-2 | Node/Desktop 代理支持（ws agent + REST + 代理下强制 Relay） | 无 | 2–3 天 |
| P2-1 | Relay padding + counter 混淆 + 心跳抖动 | P0-2 | 3–5 天 |
| P2-2 | Rekey + 连接最大生命周期 | P0-2 | 3–5 天 |
| P3 | Remote Web 静态站独立 origin（或扩展化） | 独立 Server 仓库 | 1–2 周 |
| P4 | Key transparency（可选） | P0-2 | 2–4 周 |

排序理由：P0-1 必须先做，否则后面所有改动都无法证明有效；P0-2 是唯一能把"声称 E2EE"变成"可宣称 E2EE"的动作；P1 与 P0 可并行（不同包）。P3 依赖另一个仓库，属于跨仓库协调项。

---

## 9. 验收方式

改造是否有效，不靠代码审查结论，靠这三个可执行断言：

1. **MITM 测试**：恶意 Server 替换 descriptor 公钥 → 改造后 Client 必须拒绝连接（或在配对缺失时标记 `unverified` 并阻塞业务）。改造前应能成功解密——先写这个失败用例。
2. **分发测试**：在 Server 静态资源中植入记录明文的脚本 → 若走 5.2/5.1，业务不应受任何影响（因为前端不来自该 origin）。
3. **流量分析测试**：录制 Relay 帧序列，改造后应无法从长度/counter 推断消息类型与轮次。

---

## 10. 一句话回答"能不能改造"

**能，而且不需要动密码学。** 现有 Noise IK 实现、帧封装、fail-closed 状态机都是合格的；真正要改的是两件工程与产品决策：

1. 把"对端公钥从哪来"从 Server 手里拿走（配对码 → 带外传递）；
2. 把"前端代码从哪来"从 Server 手里拿走（独立 origin 或扩展）。

打洞方面，**别换机制，补 TURN 和代理**。WebRTC + TURN + WSS Relay 三级阶梯已经是这类产品的最优解；真正的短板是自部署 Server 目前只会 Relay，以及企业代理场景完全没接。

---

## 11. 不建服务器的改造路径（兼容推荐 / 托管 Server）

前提变更：**不维护自己的 Server**，继续用推荐/托管的 Server（例如 `dsh.r2049.cn` 这类），Server 端代码完全不动。
本节的结论是：**除了 Remote Web 这一条必须"绕开"而不是"改造"，其余目标都能在客户端（Plugin + 各 Client）内完成，且不需要 Server 配合。**

### 11.1 服务器依赖度盘点

| 目标 | 是否必须改 Server | 能否只改客户端 |
| --- | --- | --- |
| F1 身份带外验证，消除 MITM | 否 | **能，零协议改动**（只用现有帧） |
| F2 Remote Web 前端可信 | 不需要改，**需要不用** | 能（用本地客户端，或扩展承载 runtime） |
| 打洞：Server 有 signaling + TURN | 否 | 已经能用，无需改动 |
| 打洞：Server 只有 Relay | 改 Server 最省事；不改则需要**带内信令** | 能（工作量约 1 周） |
| 企业代理 | 否 | 能 |
| 自带 STUN/TURN | 否 | 能（本地配置覆盖） |

### 11.2 身份配对：完全客户端，零线协议改动

Host 侧生成配对载荷（**不经过 Server**）：

```text
dshpair://v1?h=<hostDeviceId>&k=<identityKey>&n=<nonce>&e=<expiresAt>
```

- 渲染：`packages/plugin` 已依赖 `qrcode`（`packages/plugin/package.json:82`），dsh-TUI 已有二维码渲染能力（`tui-command.ts:455-489`），新增 `/remote pair` 直接复用，无需新依赖。
- 使用：Client 用它作为 `NoiseIkSession` 的 `remotePublicKey`；Server 在 descriptor 里下发的 `identityKey` 降级为 **hint**——与 OOB 值不一致时直接 `PEER_IDENTITY_MISMATCH`（该错误码与拒绝路径已存在）。
- 身份天然按 Server 隔离：`serverStorageDirectory(root, serverUrl, role)` 以 origin 哈希分目录，同一台机器连不同 Server 是不同身份，配对码不会串。

Host 认证 Client（另一方向，同样零 Server 改动）：

- 现在 `connect.incoming` 到达后立即 `trustPeer`（`server-connection.ts:400-420`）。改为：未 pin 的 Client 一律先 `connect.rejected`，并在 Host UI / dsh-TUI 进入"待授权设备"列表，显示 Client fingerprint；用户确认后才写入 pin，Client 重试即可。
- 效果：恶意 Server 塞进来的假 Client 会触发一次人类可见的授权请求；用户没批准就进不来。
- 可选加强：连接建立后两端各显示一个由两把 static key 派生的**确认码**（60 bit base32），用户比对/输入一次即完成双向认证（ZRTP / Signal safety number 的做法），同样不需要 Server 参与。

改动面：`identity-store.ts`（加 `verification`）、`client-connection.ts`、`server-connection.ts`、Desktop 设置页、`/remote pair` 与 `/remote trust`、Android 扫码。`protocol.md` 只需加一节描述配对载荷格式（属于本地契约，不进线协议帧）。

### 11.2.1 保证成立的不变量（缺一条则 MITM 能力回来）

上面的方案**只有在下面三条同时成立时**才意味着"Server 无法中间人"。任何一条被放松，漏洞就原样复现，所以这三条必须写成代码约束 + 测试，而不是文档承诺。

| # | 不变量 | 反例（一旦违反） |
| --- | --- | --- |
| I1 | **无回退**：没有 OOB pin 的设备一律不得建立业务通道。禁止"首次从 descriptor 自动信任"，也禁止"跳过配对继续"。 | 保留现有 `authorizeHostPeer()` 的首次自动 `trustPeer`（`client-connection.ts:245-268`），MITM 直接回来。 |
| I2 | **配对秘密不过服务器**：`nonce` 与二维码只由 Host 本地生成并本地展示，绝不通过 REST、Web 控制台或通知下发。 | 若做"网页上生成配对码"这种便利功能，Server 就拿到了秘密，可以自己算出一致的 pin。 |
| I3 | **pin 与密钥变更检测**：pin 按 `serverOrigin + deviceId` 隔离（已有 `serverStorageDirectory`），对端 static key 与 pin 不一致时无条件拒绝，且不得被"重新配对"以外的路径覆盖。 | 允许静默覆盖 pin，或把 pin 存到可由 Server 影响的位置。 |

**密码学原因**：Noise IK 中 initiator 的 `rs` 来自 pin，responder 的 `ss` 需要 initiator 的真实静态私钥。Server 既没有 Host 私钥也没有 Client 私钥，无法同时对着两端各完成一次握手——一旦两端 pin 的都是真实公钥，中间人就接不上任何一条腿。

### 11.2.2 剩下的两件事：不是 MITM，但危害等同

必须把措辞分开，否则会过度承诺。

| 剩余能力 | 性质 | 危害 | 抵挡手段 |
| --- | --- | --- | --- |
| **注入假 Client**（Server 伪造一个 client 身份连 Host） | 授权绕过，不是 MITM | 若被放行，该"设备"拿到完整 allowlist 权限 | Host 侧人工审批 **且审批值必须是可验证的安全码**；只弹"允许吗？"挡不住 |
| **诱导未验证路径**（用户图省事跳过配对） | 社会工程 | 等价于 I1 失效 | 未验证状态必须显式标注，敏感操作可禁；不得默认放行 |

因此，Host 侧的单方向认证必须用 **确认码（SAS）**——两端从各自看到的对端 static key 派生同一个 60 bit 码，用户比对或输入一次——而不是"显示一个 fingerprint 让用户点确定"——后者里的 fingerprint 仍来自 Server，用户没有比对对象，只是把授权包装成了认证。

结论性表述应当是：

> 配对完成后，Server **无法解密或篡改该设备对的会话内容**；它仍然可以拒绝服务、观察元数据，并尝试**注入新设备**——后者由两端安全码比对抵挡，而不是由密码学自动抵挡。

### 11.3 托管 Server 下的 Remote Web：只能绕开

同源下发的 JS 由 Server 控制，这一点在客户端无法修复。可选：

1. **用本地客户端**（Desktop / Android / VS Code）：这些是本地安装的代码，密钥在本地进程里，Server 全程只见密文。**零开发成本，选它。**
2. 浏览器扩展承载 Remote runtime（扩展由商店签名，Server 无法替换）。开发量大，但不需要 Server 配合。
3. 本地静态 bundle 直连托管 Server：受 Origin 校验与 CORS 限制（`apps/server/src/gateway.ts:24` 就校验 `Origin`），托管 Server 行为未知，不作为主路径。

结论：**不建服务器 = 不用 Remote Web。** 这不影响 Desktop/Android 的完整功能。

### 11.4 打洞：分两种情况

**(a) Server 支持 signaling + TURN（文档描述的完整 Server）**

无需改动。现有阶梯已经完整：

```text
direct(仅STUN, 12s) -> turn(含TURN) -> relay
```
`client-connection.ts:121`（attempt 列表）、`client-runtime-contract.ts:47`（12s）、`adaptive-transport.ts:416-422`（ICE 配置获取失败时静默降级为仅 STUN 直连）。

唯一可补的是**本地 ICE 覆盖**：托管 Server 若不下发 TURN，允许用户在 Remote 设置里填自己的 STUN/TURN（含凭证），与 Server 返回值合并。纯客户端，配置项 + 合并函数即可。

**(b) Server 只有 Relay（例如 `apps/server`）**

硬事实：**没有 SDP/ICE 交换就无法打洞**，补 TURN 也没用，因为 `signal.*` 根本不被转发（`apps/server/src/gateway.ts:151`）。

不改 Server 的唯一办法是**带内信令**：先经 Relay 建立 Noise 通道（现有流程不变），再把 signaling 放进已经在跑的 Noise 明文里交换：

```text
Noise(明文) {
  dsh.transport.offer  { sdp }
  dsh.transport.answer { sdp }
  dsh.transport.ice    { candidate }
}
-> DataChannel 建立 -> 切换数据面 -> Relay 退化为保底
```

- 可行性：两端都是本仓库代码，任何"只会转发密文"的 Server 都能承载；SDP 几 KB，远低于 relay 帧上限与 512 帧/秒限速。
- 需要：capability 协商（Host 不支持就维持 Relay）、迁移失败 fail closed（不重放 mutation，与 `network.md` §5 一致）、切换期间的收发缓冲。
- 工作量：Client 3–4 天、Host 3–4 天、状态机测试 2 天。

### 11.5 代理：纯客户端

- Node/Desktop：`ws` 连接加 `agent`（`https-proxy-agent` / `undici ProxyAgent`），REST 同样读 `HTTPS_PROXY`/`NO_PROXY`。
- 检测到代理时**直接跳过 direct/turn**，否则每次都要等 12–15s 超时才降级（`adaptive-transport.ts:126` 当前是裸 `new WebSocket(url)`）。
- 代理 + TLS inspection 下 WSS Relay 仍可工作，这是"能上 HTTPS 就能用"的兜底。

### 11.6 兼容矩阵

| Server 能力 | 身份 OOB | Remote Web | P2P 打洞 | 企业代理 |
| --- | --- | --- | --- | --- |
| 完整 Server（signaling + TURN） | 客户端可实现 | 需绕开 | 零改动可用 | 需客户端补 |
| 完整 Server（signaling，无 TURN） | 客户端可实现 | 需绕开 | STUN 直连可通，否则 Relay；可加本地 TURN | 需客户端补 |
| 仅 Relay（`apps/server`） | 客户端可实现 | 需绕开 | 需带内信令 | Relay 可用 |

### 11.7 结论

- **"Server 读不到对话"可以在不建服务器的前提下达成**，唯一硬代价是**放弃 Remote Web**，改用 Desktop/Android/VS Code。
- 准确的说法是：**配对完成后 Server 无法解密或篡改该设备对的会话**（前提是 11.2.1 的三条不变量全部成立）。它仍能拒绝服务、观察元数据、尝试注入新设备；注入由 SAS 安全码比对抵挡，属于人的判断而非密码学保证。
- 打洞在托管 Server 上基本零改动；只有在纯 Relay Server 上才需要带内信令，而那仍然是客户端改造。
- 因此推荐顺序调整为：**P0 配对 + SAS（纯客户端）→ P1 本地 ICE 覆盖 + 代理（纯客户端）→ 视 Server 能力决定是否需要带内信令 → Remote Web 不作为可用路径。**
- 不变量 I1/I2/I3 必须各有一条回归测试；尤其 I1，它是"改造后退化成改造前"的唯一入口。

---

## 12. 评估：在现有协议上再叠一层加密（QR 传证书）

提案：在现有 Noise 通道之上再建一个"类 TLS"的加密层，证书经二维码传递，使 Server 即使完成 MITM 也读不到内容。

### 12.1 判定

**成立的判断**：二维码传证书 = 带外信任锚，这是唯一能让 MITM 失效的机制。方向完全正确。

**不成立的部分**：**额外一层本身不提供保护**。让 MITM 失效的是"信任锚来自带外"，不是"多包一层"。把带外锚用在现有 Noise 通道上（§11.2 配对），安全性质与"再加一层"完全相同，而代码量少一个数量级。

换言之：

```text
带外锚 + 现有 Noise      = Server 无法 MITM   （1 周）
带外锚 + 第二层 Noise    = Server 无法 MITM   （3 周，多一层实现风险）
无带外锚 + 第二层 Noise  = Server 仍然可以 MITM（因为第二层的密钥也从 Server 来）
```

第三行是最容易掉进去的陷阱：如果内层证书是从 Server 取的，那只是把同一个问题搬到了内层。

### 12.2 第二层真正能买到什么（只有这四条）

如果目标只是"Server 看不到对话"，这四条都不需要。但如果你在意下面任一项，内层就有价值：

| 收益 | 说明 | 现有方案能否替代 |
| --- | --- | --- |
| **密码敏捷性 / 抗量子** | 外层套件被 `fixtures/crypto/v1/noise-ik.json` 冻结为 `Noise_IK_25519_ChaChaPoly_SHA256`，改它要升 v2 且破坏兼容基线。内层可以独立换成 X25519+ML-KEM 混合，不动外层。 | 需要协议 v2，代价更大 |
| **身份跨 Server 稳定** | 现有身份按 `serverOrigin` 隔离（`serverStorageDirectory`），换 Server 要重新配对。内层可用一把"个人根证书"跨 Server 稳定。 | 不能 |
| **纵深防御** | 外层未来若因实现回归或降级路径被打开，内层仍然挡住内容。 | 不能（这本质是冗余控制） |
| **消息批处理与统一长度** | 内层可以把多条业务消息合并成一个定长外帧，顺带缓解 §F3 的流量分析。 | 可以用 padding 单独做，但不如内层自然 |

### 12.3 五个必须处理的陷阱

| # | 陷阱 | 后果 | 处理 |
| --- | --- | --- | --- |
| T1 | **降级**：内层可选，MITM 直接剥掉内层协商 | 内层形同不存在 | 内层必须强制；协商本身要在已被证书锚定的通道里进行，剥掉即连接失败，不允许回落 |
| T2 | **重放/重排**：外层被 MITM 后，"两端各自和攻击者握手"，攻击者可以重发、重排、丢弃内层记录 | 内层若依赖外层提供顺序，就会被重放攻击 | 内层必须自带独立序列号 + AEAD，窗口去重；**不得假设外层提供认证顺序** |
| T3 | **两套身份并存**：外层 pin 说 Host A，内层证书说 Host B | 授权判定混乱 | 明文规定：内层是信任锚，外层降级为传输保护；两者不一致即 fail closed。**且内层必须在任何业务消息之前完成**——外层的 allowlist 放行发生在 `connect.accepted`，若内层握手失败仍已授权，就是授权泄漏 |
| T4 | **分片嵌套**：内层记录要装进外层 Noise 单消息（65,535B），超 48 KiB 还要外层 DSHF 分片（上限 4 MiB） | 大消息路径变复杂 | 内层记录上限 ≤ 1 MiB，不做自己的分片；由外层负责 |
| T5 | **不是流，是消息** | "类 TLS"是错误类比：这里没有可靠字节流，只有离散消息 | 不要实现 TLS record/handshake；直接再用一次 Noise（IK 或 XX） |

### 12.4 如果要建，建议这么建

```text
二维码（带外，几十字节）:
  dshca://v1?d=<deviceId>&c=<commitment>&e=<expiresAt>
  commitment = trunc128( SHA256("dsh-inner-cert/v1" || certBytes) )

certBytes（可经外层通道传输，不可信）:
  { v:1, deviceId, alg:"X25519+MLKEM768/ChaChaPoly/SHA256", publicKey, serverOrigin? }

Client 收到 certBytes 后先校验 commitment 与二维码一致，再用 publicKey 做内层握手。
```

关键点：**二维码只放承诺值，不放整张证书**。这样 QR 保持可扫，而证书可以任意大（PQ 公钥 1KB+ 也没问题），安全上等价——攻击者无法找到同哈希的第二份证书。

内层握手：直接用同一套 Noise 库做 IK/XX 混合套件（不要写 TLS），prologue 绑定 `connectionId || hostDeviceId || clientDeviceId || H(certHost) || H(certClient)`，随后内层承载的才是 `rpc.*` / `event` 业务信封。

外层保留原样：`secure.handshake` 走 Control 转发，`relay` 承载内层密文。**Server 代码零改动**，与 §11 的兼容性结论一致。

### 12.5 成本对比

| 方案 | 工作量 | 得到什么 | 遗留 |
| --- | --- | --- | --- |
| A. 外层 OOB 配对（§11.2） | 4–6 天 | Server 无法 MITM | 换 Server 需重配；无 PQ |
| B. 内层 + QR 承诺 | 2–3 周（两端 + 测试） | 同上 + PQ + 跨 Server 身份 + 纵深 | 多一层实现风险；需严守 T1–T5 |
| B 但无二维码 | — | **什么都不多**（密钥仍来自 Server） | — |

### 12.6 结论

- **只想要"Server 看不到对话"：做 A，不要做 B。** B 的这个收益完全由 A 提供。
- **想要抗量子、跨 Server 稳定身份、或对外层实现不放心：做 B，并且 A 也要做**（A 是 B 的降级兜底）。B 不替代 A。
- **无论 A 还是 B，都必须先满足 §11.2.1 的三条不变量**，否则内层会跟着外层一起被绕过。
- 不要把 B 描述成"类 TLS"。它是"内层 Noise + 带外承诺锚"，实现更小、语义更准确。

---

## 13. 定档威胁模型：只不信任 Server，两端自有

这是实际采用的前提：**Server 视为敌对，Host 与所有 Client 都是同一用户的设备且可信。** 该前提把方案缩到最小。

### 13.1 结论：只需要带外锚 + pinning

因为两端都由你控制，你可以用任何你本来就信任的通道传递一次性信息（看屏幕、读数、拍照）。这在密码学上就等价于一个安全信道，足以完成身份锚定。

于是不需要：

| 方案 | 为什么不需要 |
| --- | --- |
| CA / 证书链 / 自签 PKI | 只有你自己的两三个设备，没有第三方要验证，也不需要撤销体系。一把公钥 + 一次比对就够。 |
| 内层第二套加密（§12） | 带外锚已经让 MITM 不成立；再加一层不增加任何对抗敌对 Server 的能力。 |
| Key transparency 日志 | 那是"无法见面比对"时的替代品。你能见面比对。 |
| 服务端任何改动 | 全部本地完成。 |

### 13.2 敌对 Server 还能做什么（以及能不能挡）

| 能力 | 能否挡 | 手段 |
| --- | --- | --- |
| 解密/篡改会话内容 | **能挡** | 带外锚 + pin（§11.2），密码学保证 |
| 注入假 Client 读取 Host | **能挡，靠人** | Host 侧首次连接必须比对 SAS；不能只弹"允许" |
| 降级到"未验证"路径 | **能挡** | 不变量 I1：无 pin 即拒绝，不提供跳过 |
| 拒绝服务、强制重连、限速 | **挡不住** | 只能检测与告警 |
| 强制所有流量走 Relay（拒绝转发 signaling） | **挡不住，但可拒绝配合** | 提供 `refuseRelay` 策略：P2P 不可达则连接失败，而不是静默回落 |
| 观察连接时间、流量大小、消息条数 | 部分 | padding / 批处理 / 心跳抖动（§F3），都是纯客户端 |
| 偷换客户端程序 | 只在你从它那里下载时 | 从本仓库/GitHub 构建安装，不从 Server 取任何代码 |
| 拿到配对码 | **能挡** | 不变量 I2：配对码只在 Host 本地生成并显示 |

关键点：**表格前四行里，只有"注入假 Client"需要人的判断，其余都是代码保证。** 这也是为什么 §11.2.2 坚持要 SAS，而不是"显示 fingerprint 让用户点确定"。

### 13.3 交互成本

两端自有、且首次配对时通常就在手边，所以流程可以极简：

```text
1. Host（Desktop / dsh-TUI）执行 /remote pair
   -> 屏幕显示二维码，内含 hostDeviceId + identityKey + nonce + 过期时间
2. Client（手机/另一台电脑）扫码
   -> 直接 pin Host 公钥，不读 Server 的 descriptor
3. 首次连接成功后，两端各显示 6 位 SAS
   -> 你确认两边一致，Host 侧点确认
   -> Client 公钥写入 Host 的 pin 表，此后永久免操作
```

第 3 步可以合并进第 2 步（二维码里带一个短时 SAS 种子），但分离更稳：二维码只解决"Host 是谁"，SAS 解决"这个 Client 是不是我的"。

### 13.4 对 §12 提案的最终判定

在你的威胁模型下，**第二层加密没有对价**：

- 它不增加"防敌对 Server 读内容"的能力——带外锚已经给了；
- 它增加的是抗量子、跨 Server 身份稳定、外层回归兜底——这三项与"不信任服务器"无关；
- 它引入 T1–T5 五个新失败模式，其中一个（T2 重放）恰好只在"服务器已敌对"时才会被触发。

所以：**先做 A。B 只有在你要抗量子或要换 Server 不重配时才值得。**

### 13.5 一个副作用：可以顺带去掉对 Server 的部分依赖

既然两端都可信，还可以做两件纯客户端的事，进一步减少对 Server 的信任面：

1. **`refuseRelay` 策略项**：不允许静默降级到 Relay。敌对 Server 想把你所有字节都吸到它自己的管道里，就会直接连不上——你能明确知道，而不是被悄悄降级。
2. **本地直连兜底（可选）**：在同一局域网内，允许通过 mDNS/手动 IP 直接建连，完全绕开 Server 的 Control 通道做建连（Noise 握手可在直连上跑）。这不是替代品——公网仍需 Server——但在家里/办公室能彻底移除中间人位置。

### 13.6 两点澄清：Relay 与机密性无关；fail-closed 不等于抗 DoS

**（1）走 Relay 时 Server 同样读不到内容——这是对的。**

E2EE 与网络路径无关：`relay.payload.ciphertext` 就是 Noise transport 密文，Server 只做转发（`gateway.ts:157-162`）。LAN、P2P、TURN、Relay 四种模式下报文内容的安全性质**完全相同**。

所以"避免 Relay"不是机密性要求，只关乎两件事：

| Relay 的真实代价 | 说明 |
| --- | --- |
| **元数据** | Server 是唯一路径，能精确关联"哪个 Client 与哪个 Host 在何时通信、每条消息多长、多少条"。 |
| 延迟与带宽 | 多一跳中转，且占用 Server 带宽。 |

补充一个易被忽略的细节：Relay 帧长度 ≈ `(明文 + 16B tag) × 4/3`，与明文长度成正比，因此 Server 能从长度分布区分长 Prompt、短回复、心跳等消息类型。P2P 路径下它看不到这些。

结论：`refuseRelay` 是**元数据策略**，不是安全必需项；它的代价是可用性（见下）。如果要降低长度泄露，更便宜的做法是直接在**外层**加 padding / 批处理，不需要内层加密。

**（2）"一有问题就拒绝/断开"是正确策略，但它不缓解 DoS。**

必须把两个目标分开，否则会得出"严格的 fail-closed 能抗拒绝服务"这个错误结论：

| 目标 | fail-closed 的作用 |
| --- | --- |
| 机密性 | ✅ 保证。密钥/身份/认证任何一步不符即拒绝。 |
| 完整性 | ✅ 保证。篡改、重放、乱序即关闭通道。 |
| **可用性** | ❌ **不保证**。断开恰恰是攻击者想要的结果。 |

在"你依赖对方的链路"这个前提下，**可用性由对方决定**，这是使用第三方中转的固有代价，无法通过更严格的校验反转。

对敌对 Server 的正确做法是三层，而不是"校验更严"：

1. **不给它中间人的位置** —— 带外锚 + pin（§11.2）。
2. **不给它静默降级的机会** —— 任何非预期状态显式失败并告警，禁止"自适应"地接受降级后的结果；换路径必须变成用户可见的状态变化。
3. **让它不在关键路径上** —— 局域网/overlay 直连、或多路径并行（两个 relay 任选其一可用）。

第 3 条才是真正的 DoS 缓解；第 2 条只是把攻击从"静默"变成"可见"。

**诚实的边界**：敌对 Server 随时可以让你连不上。使用它的中转服务时，你能保证的是"**它读不到，也改不了**"，不能保证"**它一定让你连得上**"。这一句必须写进对外文档，否则就是过度承诺。

---

## 14. 更正：证书"经通道传递"只绑定一个方向

§12.4 建议"二维码只放承诺值、证书经外层通道传递"。这个设计本身没有哈希问题，但**作用域被写窄了，容易被误读成双向都能覆盖**。这里更正。

### 14.1 承诺方案的真实边界

`QR = H(cert)`、`cert` 经不可信通道传，这个组合是成立的：攻击者无法构造同哈希的第二份证书。但它能证明的只有一件事——**"通道送来的这份证书就是二维码承诺的那一份"**。

而二维码是 **Host 生成的**，所以它只绑定 Host 的证书。Client 的证书仍然由 Server 提供，Host 没有任何带外依据。于是：

```text
Client 认证 Host   ✔ 由二维码承诺覆盖
Host 认证 Client   ✘ 完全没有覆盖 ← 伪造设备连接就发生在这里
```

这正是"冒充设备连接"的位置：恶意 Server 不需要 MITM 真实 Client，它只要伪造一个 Client 身份连到 Host，拿到 `connect.accepted`，就能使用 Host 的 allowlist。**这个洞和证书怎么传无关，和"谁扫了谁的码"有关。**

### 14.2 三种方向组合

| 方案 | Host→Client | Client→Host | 需要摄像头 | 适用 |
| --- | --- | --- | --- | --- |
| **A（推荐）** | Host 显示二维码（配对码） | **人工输入确认码（SAS）** | 否 | 桌面 Host + 手机 Client |
| B | Host 显示 QR | Client 显示 QR，Host 扫 | **是**（桌面通常没有） | 两台都带摄像头的设备 |
| C | Host 显示 QR | 双向动画 QR | 是 | 需要传 PQ 证书/大载荷 |

A 的具体流程：

```text
1. Host 显示 QR：dshpair://v1?h=<hostDeviceId>&k=<hostPub>&n=<nonce>&e=<expiresAt>
2. Client 扫码，pin Host 公钥（不读 Server descriptor）
3. Noise 通道建立后，两端各算 SAS = trunc6(KDF(hostPub, clientPub, nonce))
   —— Host 用的 clientPub 来自"通道"，可能是伪造的
4. 用户读**自己手机屏幕上**的 SAS，输入到 Host
5. Host 比对输入值与它按通道 clientPub 算出的 SAS：
   一致 => 通道里的 clientPub 就是这台真实 Client 的公钥
   不一致 => 有人在中间塞了别的设备，拒绝
```

关键点在第 4 步：用户读的是自己手机上的码，不是 Host 显示的码。伪造设备无法让真实手机显示同一个 SAS，所以 Server 伪造的 Client 一定对不上。

### 14.3 动态二维码工具

静态 QR 在低纠错（L）下最多约 2.9 KB 字节。对照载荷：

| 内容 | 大小 |
| --- | --- |
| X25519 公钥 + deviceId + nonce | 约 100 B |
| 加 ML-KEM-768 公钥（抗量子） | 约 1.3 KB |

也就是说：**不做 PQ 时静态 QR 完全够用；做 PQ 也仍然塞得进一张静态 QR**。动画 QR 的价值不在容量，而在**拍摄鲁棒性**（多帧 fountain 编码，丢帧也能重建）。

若确实需要，现成方案：

- **BC-UR / Uniform Resources**（Blockchain Commons）：CBOR + fountain code 的多帧 QR，air-gap 设备配对的事实标准，Keystone、OneKey、Sparrow 等在用。有 TypeScript 实现（`@bcts/multipart-ur`、`@ngraveio/bc-ur`）与 Dart 实现（`bc_ur`）。参考 [OneKey air-gap 文档](https://developer.onekey.so/en/air-gap/)、[bc_ur (Dart)](https://pub.dev/packages/bc_ur)。
- **txqr**（Go）：fountain code 动画 QR 编解码，带 CLI，适合先做原型验证。见 [divan/txqr](https://github.com/divan/txqr)。
- **decimen-optical-transfer**：纯 Web 的光传输方案，可参考其分帧与刷新策略。见 [decimen-optical-transfer](https://github.com/superdividenz/decimen-optical-transfer)。

### 14.4 结论

- **先做 A**：静态 QR（Host 公钥）+ 人工输入 SAS（Client 公钥确认）。零依赖、双向覆盖、桌面不需要摄像头。
- 不要用"通道传证书"来覆盖 Client 方向——那正是伪造设备的入口。
- 动画 QR 只在要上 PQ 或要塞完整证书链时才需要；届时选 BC-UR，而不是自己造分帧协议。

---

## 15. 攻防循环：只有 Server 是对手

### 15.1 前提决定攻击面

固定前提：**Server 敌对；Host 与 Client 都是用户可控的可信代码；用户会配合流程。**

由此可推出三条作用域结论，它们把攻击面砍掉一大半：

1. **攻破端点不在范围内。** 能读设备内存、改 pin 文件、替换已安装二进制的攻击者已经赢了，任何协议设计都拦不住，不再讨论。
2. **"服务器下发前端"这条路径直接排除。** 只要不用 Remote Web，Client 代码就不由 Server 控制——所以这不是"要防的攻击"，而是"不采用该部署"。
3. **剩下的攻击面只有一类：Server 在协议内的能力。** 具体只有五种：

| Server 能做 | 说明 |
| --- | --- |
| 伪造描述符 | 提供任意 `identityKey` / `name` / `deviceId` 映射 |
| 伪造连接 | 以任意设备身份发起或中转 `connect.*` |
| 调度时序 | 延迟、重排、丢弃、制造重连 |
| 选择降级 | 声称无 WebRTC/TURN、只给 relay |
| 诱导用户 | 用可控字段（设备名等）影响人的判断 |

下面每一轮都只在这五种能力里找路径。

### 15.2 循环 1：替换密钥

**攻击 1｜Server 换掉 descriptor 里的 Host 公钥。**
Client 用 Server 给的公钥做 `rs`，Server 同时对 Host 冒充 Client。两端"握手成功"，中间明文可见。

**成立原因：** 公钥只有一个来源——Server；pin 记的是攻击者密钥，此后永远一致，永不报警。

**修补：** `rs` 必须来自带外二维码；Server 的值降级为 hint，不一致即 `PEER_IDENTITY_MISMATCH`。

**修补后 Server 还剩什么：** 不能换 Client 侧看到的 Host 密钥。

### 15.3 循环 2：不 MITM，直接冒充设备

**攻击 2｜伪造 `connect.incoming`，自己当 Client。**
Host 的 Client 公钥仍来自 descriptor，首见即信任；攻击者拿到 `connect.accepted`，随即使用 Host 的 allowlist。

**成立原因：** 二维码只锚住 Host 一个方向。这不是中间人，是"多了一台设备"。

**修补：** Host 侧必须有人类可验证的确认。采用输入式 SAS：

```text
SAS = HKDF(hostPub, clientPub, nonce, info="dsh-sas-v1") → 取前 N 位
用户读自己手机上的 SAS，输入 Host；Host 与"通道里那个 clientPub"算出的值比对
```

**为什么不能只显示两个 fingerprint 让人比对：** fingerprint 是 48 bit 全量但分组展示，比对成本高且用户会疲劳；确认码是刻意设计的短串，但短就要防碰撞——见下一轮。

### 15.4 循环 3：攻击摘要本身

**攻击 3｜离线碰撞 SAS。**
攻击者不需要猜用户输入，它可以自己造 2^N 个密钥对，挑一个 SAS 与真实 Client 相同的塞给 Host。

| SAS 强度 | 空间 | 单机 X25519（约 1e5/s/核） |
| --- | --- | --- |
| 6 位十进制（20 bit） | 1.0e6 | **约 10 秒** |
| 8 位 base32（40 bit） | 1.1e12 | 约 5 天，多机可缩短 |
| 12 位 base32（60 bit） | 1.2e18 | 不可行 |

**成立原因：** SAS 是攻击者可自由选择输入（自己的公钥）的短摘要，任何 <40 bit 的摘要都能被离线枚举。

**修补：**
1. SAS ≥ 40 bit，推荐 60 bit；
2. HKDF 带域分离派生，禁止裸哈希截断；
3. 限次 + 限时，堵住在线穷举。

**攻击 4｜让用户照抄 Host 自己算出的值。**
若 Host 在输入框旁显示"期望值"，用户会直接抄 → 任何密钥都通过。

**成立原因：** 纯 UI 失效，把"比对"退化成"复制"。

**修补：** Host 输入前不显示自身算出的 SAS，输入后才显示用于审计。用户唯一信息来源必须是 Client 屏幕。

### 15.5 循环 4：时序与状态机

**攻击 5｜抢在 SAS 确认前发业务帧。**
`connect.accepted` 先于握手完成，Host 随即建立 tunnel 并把连接放进可用集合。攻击者在握手完成后立刻发 `rpc.request`，而用户还在看手机。

**成立原因：** 认证（SAS）与授权（allowlist）在时间上解耦。

**修补：** 连接先进入 `pending-verification`：只允许控制面，业务帧一律拒绝；SAS 通过才提升为 `ready`；超时即断开。

**攻击 6｜nonce 复用与配对互换。**
Host 若复用 nonce，旧的 SAS 关系可被重放；并发配对时可能发生"用户以为在配 C1，实际落到 C2"。

**修补：** nonce 单次使用、5 分钟过期、单会话独占；成功后立即作废。

### 15.6 循环 5：攻击"人"（在前提下仍然成立）

前提说用户可控，但"可控"不等于"不会累、不会慌"。Server 能控制 `name` 等字段，这足够做诱导。

**攻击 7｜设备名注入。**
Server 把 Host 名称改成 `输入 000000 完成配对` 或 `配对失败，请重试 000000`。用户可能照做。因为 Host 是拿输入值与它自己算的 SAS 比对，攻击者必须造出 SAS=000000 的密钥——60 bit 下不可行，所以**失败关闭**；但会造成困惑与重试。

**修补：** 设备名在配对界面标注"服务器提供，未验证"，限制字符集与长度；输入框只接受 base32 字符集，不做任何"按提示自动填充"。

**攻击 8｜诱导重新配对。**
Server 谎报已 pin 的设备换了 key，Client 报 `PEER_IDENTITY_MISMATCH`。用户若习惯性点"接受新密钥"，攻击完成。

**修补（新增不变量）：** **永不提供一键"接受新密钥"**。密钥变更只能走完整的带外重新配对（本地二维码 + 输入码）。UI 必须区分"服务器可能撒谎"与"设备确实换了"。

**攻击 9｜Origin 混淆。**
pin 按 origin 隔离，所以换 origin 会变成一次"正常的重新配对"。攻击者把你引到 `evil.example`，那里出现同名设备。

**修补：** 配对界面必须显示 origin + 设备名 + 双方指纹，并高亮"这台 Host 上次所在 origin"的差异。

**攻击 10｜QR 钓鱼。** 用户扫了攻击者设备的二维码。

**修补：** 扫码后 Client 显示 Host 名称/指纹/origin，要求与 Host 屏幕一致；配对必须由 Host 主动发起并带倒计时，不支持后台自动接受。

### 15.7 循环 6：沿修补再攻击一次

把上面全部修补装好后，再逐条试：

| 再攻击 | 结果 |
| --- | --- |
| 把 Client 的 `connect.request` 转给另一台 Host | 失败。Client 的 `rs` 是 pin 的那台，别的 Host 没有对应私钥，Noise 直接失败 |
| 告诉 Host 这条连接来自另一个 `clientDeviceId` | 失败。Noise static key 必须与该 deviceId 的 pin 一致 |
| 在同一对设备间开两条连接做拼接 | 失败。密钥按 `connectionId` 隔离，跨连接 AEAD 不通过 |
| 重放旧 `secure.handshake` | 失败。发起方每次生成新 ephemeral，prologue 绑定 connectionId |
| 重放旧 `relay` 密文 | 失败。接收方 nonce 单调，重复/过旧即关闭通道 |
| 收买 SAS 输入（诱导、注入设备名） | 失败关闭，但会制造困惑（见攻击 7） |
| 强制走 relay | 内容仍不可读，只多暴露元数据 |
| 拒绝服务 | 仍然可行，无法消除 |

**这一轮没有找到能让 Server 读到明文的新路径。**

### 15.8 剩下的确实消除不掉

| 项 | 为什么 | 处置 |
| --- | --- | --- |
| 可用性 | 你依赖它传输 | 显式失败 + 多路径，不静默降级 |
| 元数据 | 中继必然可见 | padding / 批处理，只能弱化 |
| 端点被入侵 | 前提之外 | 私钥 0600，声明不在威胁模型内 |
| 供应链 | 信任链在仓库/商店 | 从源码构建，校验 bundle |
| 用户疲劳 | 人的极限 | UI 强制输入、不给"跳过"、一次性完成 |

### 15.9 七条不变量（缺一条，前面的修补就白做）

| # | 不变量 | 防的攻击 |
| --- | --- | --- |
| I1 | 无带外 pin 即拒绝，不提供"跳过配对" | 攻击 1 |
| I2 | 配对秘密只在 Host 本地生成，绝不经 Server | 攻击 1 |
| I3 | pin 不可被任何 descriptor 覆盖 | 攻击 1、8 |
| I4 | SAS ≥ 40 bit（推荐 60），HKDF 域分离，限次限时 | 攻击 3、7 |
| I5 | Host 输入前不显示自身算出的 SAS | 攻击 4 |
| I6 | 未完成 SAS 的连接只走控制面 | 攻击 5 |
| I7 | nonce 单次、短时、单会话独占 | 攻击 6 |
| I8 | 永不提供一键"接受新密钥" | 攻击 8 |

**结论**：在"两端可信 + 二维码带外 + 输入式 SAS + 上述八条"下，逐类试过五种 Server 能力，**没有留下能读到明文的路径**。

这不是数学证明，只是经验性收敛：攻击类别已经覆盖身份分发、摘要碰撞、时序、状态机、诱导与分发链。真正的价值不在"找不到"，而在于**每一条不变量都对应一条可执行回归测试**——把"我们讨论过"变成"CI 会拦住"。
