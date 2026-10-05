# 阶段 B · 本地沙箱接入与运行

> 这是阶段 B 基础记录。当前三消、高尔夫多人样板与新增接口见 [阶段 C 补充](phase-c-local-integration.md)。

这份教程对应仓库中可运行的本地实现。管理端、平台 API、参考合作方钱包和 PostgreSQL 已连接；两款概率游戏使用独立的平台构建。10 款竞技游戏仍是已批准的规格与设计图，跑酷另有技术灰盒，尚未作为正式竞技产品发布。正式合作方生产接入、真机验收及运营发布不在本报告的已完成范围内。

## 1. 启动与登录

在 `platform/` 目录执行：

```sh
npm ci
npm run db:start
npm run build:legacy
npm run server
# 另一个终端
npm run dev
```

本机地址：管理台 `http://127.0.0.1:8795`；平台 API `8797`；参考钱包 `8798`；独立 PostgreSQL `5487`。数据库脚本默认使用 `/opt/homebrew/bin` 下的 PostgreSQL 14 工具，可用 `OASIS_PG_BIN` 指定其他安装目录。现有 5432 数据库和两款原演示 8787 / 8790 不被修改。8796 是独立跑酷技术灰盒。

首次启动在 `.local/development-credentials.json` 生成管理员账号，文件权限 0600。页面不硬编码密码，登录成功使用 HttpOnly、SameSite Cookie。`.local/master.key` 是本地凭据加密主密钥，应与数据库一起备份，不能删掉后继续使用旧库。整个 `.local` 已加入忽略目录，不进入前端构建。

`db:start` 创建的是**仅本机开发用**、loopback trust 认证的独立数据库，不能原样对外部署。API 和参考钱包默认只监听 127.0.0.1。非本地正式部署必须补齐 TLS、数据库认证、平台角色/合作方角色划分、密钥管理、限流与发布验收；生产环境目前由服务端拒绝创建。

## 2. 后台实际操作

1. 打开「合作方与应用」，查看两个不同 partner 的种子 App。每个 App 都有独立主钱包范围、`demo_player` / `demo_player_2` 两个参考用户，各初始 12000 币；准备金也独立。只有初始化时记入测试资产，刷新和重启不会重置余额。
2. 创建新的沙箱 App，保存一次显示的服务端 `key_id` / `secret_base64`。列表、审计和局单不返回 secret。当前自助创建自动接本机参考钱包；**还没有开放任意生产钱包地址注册**。
3. 修改 App 的名称、启停、游戏授权与 98/99 数学候选档位，刷新页面确认持久化。数学档位只作用于后续付费周期，已固定周期保持原版本。
4. 点击虎虎生财或雷霆王座的「平台启动」。页面先取得 60 秒一次性启动码，在独立窗口通过同源 `postMessage` 兑换为 15 分钟 Bearer 会话。密钥不进入游戏窗口，启动码不进入 URL。
5. 旋转结束后打开「局单与对账」，查看真实 cycle、stake/payout、版本、状态、结果摘要和三次资金操作。概率一局包括完整免费转/重转链，钱包一次结算；后续演出、ack 和重播不再次入账。

旧演示始终保留。平台版独立入口 `/play/tiger` 与 `/play/thunder` 需要有效宿主授权，直接打开不会创建新的本地演示余额。

## 3. 合作方服务端签名调用

下载可直接运行的 [Node SDK](examples/sdk-node.mjs)，只在合作方后端使用。无 npm 依赖，需要 Node.js 22。固定签名向量仍见 [signature-vector.json](examples/signature-vector.json)。密钥先 Base64 解码，签名为九行 canonical string；GET 无查询参数；每次重试更换 nonce，保留原 request ID 和 body。

```javascript
import { OasisClient } from './sdk-node.mjs';
const client = new OasisClient({
  baseUrl: 'http://127.0.0.1:8797', // 本机沙箱；公网必须 HTTPS
  keyId: process.env.GP_KEY_ID,
  secretBase64: process.env.GP_SECRET,
  scope: {
    partner_id: process.env.GP_PARTNER_ID,
    app_id: process.env.GP_APP_ID,
    environment: 'sandbox',
    wallet_scope_id: process.env.GP_WALLET_SCOPE_ID,
    currency_id: 'COIN'
  }
});
// 以下用户必须由 App 服务端已验证的登录态取得，不能采信 H5 自报用户。
const session = await client.createSession({
  requestId: persistedRequestId,
  externalUserId: authenticatedUser.id,
  gameId: 'tiger', locale: 'en', hostPlatform: 'web'
});
// 通过受控宿主通道把 entry_url 和 launch_code 返回给该用户。
```

仓库内可分别验证两个 App：

```sh
npm run partner:smoke
node scripts/partner-smoke.mjs .local/sandbox-app-credentials.json 1
```

脚本实际完成验签目录查询与会话创建，不向日志打印 secret 或启动码。参考钱包只预置上文两个用户。合作方实现自己的钱包时，由其已有用户系统管理用户、赠礼和资产；平台不会自动为任意外部 ID 充值。

## 4. 当前 HTTP 实现范围

| 接口/能力 | 状态 |
|---|---|
| `POST /v1/sessions`，指定 thunder/tiger | 可运行，HMAC、可信 scope、持久幂等、resume 校验 |
| `POST /v1/launch/exchange` | 可运行，60 秒单次兑换、15 分钟访问、代际轮换 |
| `GET /v1/games` | 可运行，按 App 授权过滤；竞技显示未发布 |
| `GET /v1/operations/{operation_id}` | 可运行，该 App 的平台钱包操作镜像 |
| `GET /v1/matches/{match_id}`、正式匹配/房间 | 竞技服务阶段实现，目前无正式比赛 |
| `/api/play/{thunder\|tiger}/session,spin,ack,history,config` | 内部游戏会话端点，Bearer 绑定 App/用户/游戏；不是合作方钱包接口 |
| 8 类 `/wallet/v1/` 资金命令及查单 | 参考钱包已实现；独立 HTTP 端口，数据库事务/锁/分录/幂等 |
| `/wallet/v1/events` | 参考接收端去重和乱序保护；生产事件发送队列与宿主 SDK 待完善 |
| 管理登录、App、启停/授权/数学档位、局单、操作、审计 | 已接真实数据库；当前角色仅本地平台管理员 |
| 生产钱包注册、合作方 RBAC、生产发布、WebView 原生 SDK | 尚未开放 |

完整目标契约见 [OpenAPI](openapi.json) 与 [钱包协议](wallet-protocol.md)。尚未实现的契约能力不会因为出现在 OpenAPI 中就被宣称已上线。本地应用的游戏启动目前按指定游戏入口；开放大厅和多来源宿主注册继续开发。

## 5. 数学版本与冻结责任

Tiger 平台版完整周期上界 455 倍 stake。Thunder 平台版为新规则：完整周期最高 10000 倍，最多 100 次免费转，原有单转上限仍保留。达到总周期上限后结束剩余奖励链；这与旧独立演示数学版本不同，版本名和规则说明分别标识。

98% / 99% 是候选模型目标，不是运营人员直接修改某用户中奖率。每个配置有版本和 SHA-256，钱包只接受登记的版本/摘要/责任上界。完整周期 Monte Carlo、置信区间、边界测试见 `review/math-thunder-98.json` / `math-thunder-99.json` / `math-tiger-98.json` / `math-tiger-99.json` 与相应报告；统计样本不能替代理论证明或第三方认证。

平台先持久化意图，签名请求主钱包冻结 stake 与最高毛派彩责任，再确认 ACCEPT；只有之后才生成随机种子与完整结果。结果持久化后只查原结果，派奖超时会保留处理中并恢复原操作。停用 App、改新档位和前端退出不会删除已受理责任。

## 6. 自动测试与交付边界

```sh
npm run test:backend
npm run check:contracts
npm run build
node scripts/review-phase-b-ui.mjs
```

钱包测试使用随机隔离 scope；平台集成测试创建独立测试库并在结束后删除该库，不清理本地产品库。它包括 HMAC、防重放、单次兑换、跨 App 隔离、24 次并发同单、冻结前容量拒绝，以及**钱包提交后丢弃响应、强制结束进程、重启恢复同一结果和凭据**。测试不是公网压测或真机验收。

上线前仍需要真实第二合作方仅按文档完成接入、外部钱包/回调可达、生产权限和密钥轮换、真实区域网络与 WebView、完整对账/告警/备份恢复，以及游戏阶段的美术动效和多人公平性验收。
