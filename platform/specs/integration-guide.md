# 合作方接入教程 / Partner Integration Guide · V1

> 当前阶段 F（v0.6）：本地沙箱已有 **10 款竞技 + 2 款概率**，并提供独立合作方账号、App 隔离、独立钱包绑定、Node BFF、跨来源 H5 SDK 和八项真实接口检查。当前步骤与限制见[阶段 F 自接入教程](phase-f-self-integration.md)。[阶段 E 教程](phase-e-local-integration.md)和[交付记录](phase-e-delivery.md)保留十二款游戏联调说明；阶段 B/C/D 为基础及历史补充，启动与合作方接入方式以阶段 F 为准。下文是完整目标协议及生产验收要求，尚未实现部分不代表已上线。
**状态 / Status：V1 目标契约与生产接入要求；可运行本地实现以阶段 F 教程为入口。** `.invalid` 是不可用于生产的占位域名。已实现本地凭据、参考测试币和自助检查流程；外部人员独立接入、真机及生产环境尚未验收，没有正式生产密钥或公网部署。

相关文件：[主钱包协议](wallet-protocol.md) · [OpenAPI 3.1 契约](openapi.json) · [HMAC 固定向量](examples/signature-vector.json)。平台后台内开发者中心最终应展示相同版本，禁止复制维护两套不一致说明。

## 1. 关键术语 / Terms

| 中文 | English | 含义 |
|---|---|---|
| 合作方 / 应用 / 环境 | Partner / App / Environment | partner_id / app_id / sandbox or production；数据与密钥隔离 |
| 钱包范围 / 币种 | Wallet scope / Currency | 同局资金必须属于同 scope 和 currency；币种精度固定 |
| 外部用户 ID | External user ID | 由合作方登录系统验证，同 ID 跨 App 不合并 |
| 一次性启动码 | One-time launch code | 有效期 60 秒，原子兑换一次，不是钱包密钥 |
| 冻结 / 捕获 / 释放 | Reserve / Capture / Release | 锁住可花余额 / 成局扣款 / 未成局解冻 |
| 完整付费周期 | Paid cycle | 一次投注及其全部免费转、重转；固定数学版本 |
| 派彩责任 | Payout liability | 概率周期最高毛派奖的准备金冻结 |
| 操作 / 幂等 | Operation / Idempotency | 持久化业务号；重复请求产生一次账务效果 |
| 结果未知 | Unknown outcome | 请求超时不等于未执行，必须原号查单 |
| 取消墓碑 | Cancellation tombstone | 持久记录取消，阻止迟到命令再次扣款 |

## 2. 最短完整接入路径 / Minimum end-to-end path

本节描述包含事件注册与生产发布的目标流程。当前本地接入请按[阶段 F 教程](phase-f-self-integration.md)执行，尤其是“新 App 先暂停并绑定钱包，再启动游戏”的顺序；现有 UI 不提供任意币种精度、事件投递或生产启用配置。

1. **Create an App.** 在合作方后台创建 App、测试环境、币种精度与钱包范围，授权所需游戏。记录 partner_id、app_id；游戏 ID 固定为 `carrom, match, golf, darts, ludo, pool, bowling, jackaroo, domino, run, thunder, tiger`。
2. **Configure servers and credentials.** 注册 HTTPS 钱包地址、事件地址、允许的 H5 来源与宿主应用。生成按 App、环境、调用方向分开的服务端密钥。钱包不能依赖来自 H5 的用户 ID 或余额。
3. **Implement wallet commands.** 实现 OpenAPI 的 PartnerWallet 端点，包括数据库原子冻结、全员捕获、全员结算、取消墓碑、操作查单。概率游戏还需准备金授权/受理/周期结算。送礼和转赠使用同一账本的可用余额检查。
4. **Verify HMAC locally.** 使用下文固定向量，确认原始 body 摘要和签名完全一致，再连沙箱。签名密钥必须留在服务端，App 包、网页、SDK 和浏览器存储中均不能包含密钥。
5. **Create a launch session.** App 用户正常登录后，App 后端验证用户身份并签名调用 `POST /v1/sessions`。平台从密钥确定可信范围，返回 launch_code（60 秒）和无秘密参数的 entry_url。一次 session 仅绑定一个 App 用户和一个游戏/大厅用途。
6. **Exchange and launch.** 宿主打开 entry_url，通过受限的 SDK 通道把启动码交给页面；页面 `POST /v1/launch/exchange` 原子兑换为 15 分钟游戏会话。启动码不放长期 URL、分析日志或通知。页面刷新/重启需宿主请求新启动码；不得跨 App 复用会话。
7. **Complete a match and refresh balance.** SDK 进入匹配/邀请房；平台执行钱包冻结、捕获、对局和结算。宿主收到 balance.changed 后向自己的后端读取余额，不采信事件中的任意数字。退出游戏返回原 App 页面。
8. **Run failure and isolation checks.** 用下文 10 条验收覆盖重复、超时、释放、预算、重连和另一 App。保存自动验收报告及对账结果；未通过钱包原子能力的 App 不启用生产。
9. **Enable production.** 生产使用独立钱包域、凭据、用户映射和账本范围；按 App 灰度开启。测试向量、测试用户和测试币不得迁入生产。由合作方管理员完成后台发布权限操作。

本地参考钱包、Node SDK 和自动测试已实现；阶段 F 另提供[可运行 H5 SDK 与独立 BFF](examples/partner-host/README.md)。Java/PHP 语言示例、Kotlin/Swift 原生接入与生产自助验收仍待完成，不能以代码片段替代验收。

### 请求与会话边界

`POST /v1/sessions` 是服务端 HMAC 接口，不允许 App 直接持有密钥调用。`POST /v1/launch/exchange` 只接受一次启动码，是唯一不使用 HMAC 的启动端点；仍需要 HTTPS、限流、允许来源以及原子单次消费。code 不足以访问任何钱包 API。

游戏会话必须约束 issuer、audience、用途、scope、用户、game_id 和过期时间；不从令牌未验证头部自动选择算法。若采用 JWT，按 [RFC 8725](https://www.rfc-editor.org/info/rfc8725/) 固定验证策略。15 分钟为访问令牌寿命候选。长对局在令牌到期前，或断线重启后，由宿主后端重新验证登录，再调用 CreateSession 并带 `resume_session_id` 取得新的 60 秒启动码。平台验证原会话属于相同 scope/用户/游戏，兑换后轮换令牌代际、失效旧代际、保留原比赛/座位/周期；不得用新会话重复报名扣款，也不得延长过期启动码。实时房间消息规范将在对应服务实现阶段补齐，不由本阶段 HTTP 契约冒充已实现。

## 3. HMAC-SHA256 签名规范 / Request authentication

原语采用 [RFC 2104 HMAC](https://www.rfc-editor.org/info/rfc2104/)；以下规范是本平台应用层设计，不是某现有支付公司的兼容协议。全部连接使用 HTTPS 并验证服务器证书。生产 secret 为至少 32 字节随机值，以 Base64 发放；使用时先 Base64 解码为原始字节。

每个服务端请求带下列头，ASCII 字段禁止 CR/LF 与两端空白：

| Header | 格式 |
|---|---|
| X-GP-Key-Id | 控制台分配的 key ID；记录绑定 partner/app/environment/direction |
| X-GP-Direction | `partner-to-platform` 或 `platform-to-wallet`，必须与密钥用途相同 |
| X-GP-Timestamp | Unix 秒十进制字符串；接收时间差绝对值 ≤300 秒 |
| X-GP-Nonce | 至少 128 位随机值，32 位小写十六进制 |
| X-GP-Request-Id | 稳定请求业务号；与正文 request_id 相等。资金命令等于该命令 operation_id；事件通知等于 event_id，原业务 operation_id 保持独立 |
| X-GP-Signature | `v1=` 后接 64 位小写十六进制 HMAC |

body 为发出的**原始 UTF-8 字节**，不接受压缩请求体、BOM 或重复 JSON key。GET 无 body，摘要为 SHA256(空字节)。禁止发送后由代理重新序列化 JSON。API 只使用安全 ID 路径字符 `[A-Za-z0-9_-]`；路径禁止点段、编码斜杠和重复斜杠。V1 查询接口没有查询参数，签名 target 就是原始路径；未来带 query 时必须发布排序/编码扩展，不能自行忽略 query。

以下 9 行以 LF (`\n`) 连接，**末尾没有换行**：

```text
GP-HMAC-SHA256-V1
{direction}
{key_id}
{timestamp}
{nonce}
{request_id}
{UPPERCASE_METHOD}
{canonical_target_path}
{lowercase_hex_sha256_raw_body}
```

`signature = lowercase_hex(HMAC_SHA256(decoded_secret_bytes, UTF8(canonical_string)))`。服务端根据 key ID 查找范围、方向及有效密钥，检查时间并常量时间比较签名；验签通过后原子登记 `(key_id, nonce)`，保留至少 610 秒，拒绝重放。**nonce 防网络重放，request_id 防业务重复，两者不可相互代替。** 正常重试使用新 nonce 和 timestamp，但 request_id、路径和原始 body 完全不变。

新旧密钥只在明确轮换窗口同时接受，按 key ID 验证，不尝试全部秘密。过期密钥仍可保留审计记录，但不得签新请求。服务端响应通过 HTTPS 可信连接返回；本版本不定义额外响应签名，客户端不能转交“钱包响应”触发结算。

固定向量中包含公开测试 secret、原始 body、摘要、完整 canonical string、签名和请求头，方便 Java/PHP/Node/Python 逐字节核对。固定时间戳在普通线上时钟校验下会过期，仅在离线验签测试中使用。

```python
import base64, hashlib, hmac, json
v = json.load(open('platform/specs/examples/signature-vector.json'))
assert hashlib.sha256(v['raw_body_utf8'].encode()).hexdigest() == v['body_sha256_hex']
actual = hmac.new(base64.b64decode(v['test_secret_base64']),
                 v['canonical_string_utf8'].encode(), hashlib.sha256).hexdigest()
assert hmac.compare_digest(actual, v['signature_hex'])
```

```javascript
const fs = require('node:fs');
const crypto = require('node:crypto');
const v = JSON.parse(fs.readFileSync('platform/specs/examples/signature-vector.json', 'utf8'));
const digest = crypto.createHash('sha256').update(v.raw_body_utf8, 'utf8').digest('hex');
const signature = crypto.createHmac('sha256', Buffer.from(v.test_secret_base64, 'base64'))
  .update(v.canonical_string_utf8, 'utf8').digest('hex');
if (digest !== v.body_sha256_hex || signature !== v.signature_hex) throw Error('vector mismatch');
```

## 4. 接口方向与错误处理

机器契约使用 [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.1.html)。`PlatformAPI` 标签的 server 是 `https://api.game-platform.invalid`；`PartnerWallet` 和 `PartnerEvents` 标签的 server 是 `https://wallet.partner.invalid`。它们分别由平台和合作方实现，不能把全部路径部署到一个 App 浏览器中。

金额、循环责任、超时和取消规则以 [主钱包协议](wallet-protocol.md) 为准。有效平局仍按锁定费率收费；奖项均分的零头只按入场/首次冻结前随机分配并冻结的 seat_index 升序分配，不按用户 ID 决胜，不额外传排列字段。游戏示例必须使用目录中的规则版本，例如 Carrom 为 `pvp-carrom-v1.0.0`。HTTP 200 表示返回了可确认的资源；202 表示 PENDING，不能当作扣款成功。每个操作查询返回 operation_id、state、receipt 或明确拒绝原因。余额是有 ledger_version 的快照，不是发起扣款的授权依据。

| HTTP / code | 意义与调用方处理 |
|---|---|
| 400 INVALID_REQUEST / AMOUNT_MISMATCH | 结构、金额或守恒不正确；修复请求设计，不重复扣款 |
| 401 SIGNATURE_INVALID / TIMESTAMP_EXPIRED / NONCE_REPLAY | 检查原始字节、时钟、方向与 nonce；不得关闭验签 |
| 401 LAUNCH_CODE_INVALID | 启动码已过期或已消费；经 App 后端申请新码 |
| 403 SCOPE_FORBIDDEN / GAME_DISABLED | 密钥与资源范围不一致，或新游戏未授权 |
| 404 NOT_FOUND | 当前无记录；不能据此断言迟到写请求不会执行 |
| 409 IDEMPOTENCY_CONFLICT | 同业务号参数不同；停止重试并报警 |
| 409 INVALID_STATE / CANCELLED_TOMBSTONE | 状态冲突或已取消；查原比赛/授权，不重用 ID |
| 409 ALREADY_CAPTURED / ALREADY_ACCEPTED | 已过允许取消边界；按原状态恢复，不能释放既有责任 |
| 409 AUTHORIZATION_EXPIRED / RESERVATION_EXPIRED | 尚未受理/捕获的授权或预约过期，不开始游戏 |
| 422 INSUFFICIENT_FUNDS | 新入场/投注余额不足；不产生部分冻结 |
| 422 LIABILITY_CAPACITY_EXCEEDED | 新概率周期派彩责任容量不足；开奖前拒绝 |
| 429 RATE_LIMITED | 按 Retry-After 退避，保留业务号 |
| 5xx、超时、响应损坏 | 结果未知，原 operation_id 查单；不得猜测成功或失败 |

八类钱包资金命令使用 `operation_id = request_id`，在命令表按 `(partner_id, app_id, environment, request_id)` 持久幂等。事件通知签名使用 `request_id = event_id = X-GP-Request-Id`，其中 `operation_id` 引用原资金命令；同一 operation 可以产生多个不同 event_id 的状态通知。这两种 ID 空间不能混用。事件先落独立接收表再回复 204，按 `(partner_id, app_id, environment, event_id)` 去重，同事件 ID 异原始 body 拒绝；aggregate_version 防乱序。回调不是资金命令。`settlement.completed` 不应再调用钱包派奖，SDK 也无权限调用钱包写 API。

## 5. H5、Android 与 iOS 宿主约束

- H5 宿主只打开平台登记的 HTTPS origin，精确核对 scheme/host/port；跳转外域交给系统浏览器。不要信任 URL 中任意 `app_id` 或 `user_id`。启动码通过受控消息通道传入，消费后立即从内存移除，页面使用 no-store 和严格 referrer 策略。
- Android WebView 的 JS/native bridge 仅对可信页面开放，能力限制为关闭页面、宿主状态、安全区、音频状态等；不得暴露任意代码执行、文件读取或签名秘密。校验消息来源并处理 frame 边界，参见 [Android 官方 Native bridge 风险与控制](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)。
- iOS 使用 WKWebView，采用限定消息处理器和来源检查，不关闭 TLS 校验；在目标 OS/WebView 上验证音频首次手势、前后台、旋转和 safe-area。音频配置与行为以 [WKWebViewConfiguration](https://developer.apple.com/documentation/webkit/wkwebviewconfiguration) 的目标版本能力为准；游戏仍保留首次触摸解锁音频流程。
- WebView 中移除宽泛调试权限与混合内容；沙箱调试开关不进入生产。SDK 原生桥 payload 有版本、事件 ID 和字段 schema，不能执行任意字符串脚本。
- 宿主事件候选为 `ready`、`close.requested`、`balance.changed`、`match.state.changed`、`audio.duck.requested`、`error`；宿主可发送可见性、safe-area 和语音房状态。金币结果均由后端确认；仅关闭 UI 不取消已受理对局。
- 切后台暂停渲染和声音，服务端对局时间继续；返回重新查询状态/恢复座位，不从客户端时间推算赢家。音乐、音效开关独立；语音房中降低音乐，避免遮盖通话。
- 英语/阿语界面、RTL、长昵称与 390×844 / 360×800 / 430×932 布局都需真机验证；棋盘坐标、跑道方向和物理系统不随 RTL 整体镜像。

## 6. 十条自动验收用例 / Acceptance suite specification

**这些是完整目标验收规格。当前已有本地权威对局、PostgreSQL 参考钱包与 HTTP 故障测试；阶段 F 自助检查执行的是教程列明的八项，不等同于本表全部通过。外部合作方人员独立接入、真实移动设备与生产验收尚未完成。** 每条必须保存请求/查单/账本凭据，敏感值脱敏。A/B 初始各 100000 最小单位（1000 币），entry=10000，fee_bps=500，scale=2。

| ID | 故障/操作 | 必须成立的结果 |
|---|---|---|
| A01 正常结算 | A/B 冻结、全员捕获，A 胜，派奖 | A=109000，B=90000，费用=1000；奖池清零；同局一次终态 |
| A02 持久幂等 | capture/settle 各并发重复 10 次，服务重启后再重复；同号修改金额 | 余额同 A01；原凭据一致；不同正文返回 IDEMPOTENCY_CONFLICT |
| A03 响应丢失 | 钱包已提交但代理丢掉捕获/结算响应；平台重启 | 平台先 UNKNOWN 后原号查单恢复；不开第二局、不重扣/重发 |
| A04 取消先到 | 延迟 Reserve/Capture；先 ReleaseMatch；再递送旧请求 | 持久取消墓碑阻止迟到扣款，全部原余额，费用为零 |
| A05 原子捕获/作废 | 一名玩家预约失效导致捕获失败；另组比赛捕获后整体作废 | 前者全员不捕获；后者各退 10000、fee=0；不能只退部分玩家 |
| A06 金币并发消费 | 同一用户同时送礼、转赠、Reserve；包含余额不足 | 原子约束不透支，冻结不可花；失败不部分写账 |
| A07 隔离与启动码 | 第二 partner/App 相同用户 ID；换环境/币种/密钥查单；兑换码两次/61秒后兑换 | 余额与记录独立；越权拒绝；仅一次有效兑换，过期拒绝 |
| A08 概率责任 | 容量不足、授权过期、受理响应丢失；成功受理后降低新局预算，结果中奖 | 拒绝都在开奖前；受理后查单恢复同结果，中奖按冻结责任结算，不重抽/拒赔 |
| A09 签名与事件 | body 增空格、错误签名、旧时间、重复 nonce；事件重复/乱序/延迟 | 验签严格；新 nonce 的同业务重试可查原结果；事件不触发额外账务 |
| A10 重连与多次演出 | 旋转/比赛中断网，关闭 WebView 后新会话恢复；重复胜利动画、延迟派奖 | 恢复同座位/周期与固定版本；UI 完成不触发资金，最终账本仅一次效果 |

可运行测试、故障注入与确定性断言的覆盖以当前测试及对应报告为准。合作方自助接入的最终验收仍需由外部合作方人员使用独立 App 仅依据[阶段 F 教程](phase-f-self-integration.md)实际完成，不要求平台为它修改代码；提供本地示例不等于这项验收已完成。

## 7. 发布与升级

本契约标识 `gp-api-v1-draft.1`。冻结后，新增可选响应字段允许向后兼容；已有状态、金额语义、签名规范、路径方向或必填字段的破坏性变更须升主版本并提供并行迁移窗口。游戏 rule_version、math_version 与 API 版本独立，已受理对局始终保留原版本。

上线材料包括钱包原子能力报告、10 项验收结果、实机 WebView 记录、回调可达与验签记录、对账样例、密钥轮换与告警联系人配置。它们是后续验收门槛，不是本阶段已经取得的结论。
