# PostgreSQL 参考合作方钱包 · 阶段 B

此模块已实现本机参考服务及 PostgreSQL 集成测试。它用于验证合作方主钱包协议，**不是已经部署到真实合作方的生产钱包**。平台与参考钱包在本地共享同一个 PostgreSQL 实例，但使用 `wallet_*` 独立表及独立 HTTP 服务；真实合作方部署应使用自己的服务、数据库与币账。本模块没有现金充值、提现或真实合作方余额接入。

根入口负责调用 `createWalletServer(pool).listen(8798, '127.0.0.1')`；本模块 import 时不占端口，不自行修改数据库连接配置。当前本地数据库为 `postgres://oasis_local@127.0.0.1:5487/oasis_platform`。

## 导出与集成

```javascript
import {
  migrateWallet, provisionWallet, registerMathProfiles,
  createWalletServer, readWalletSnapshot, giftForTest,
} from './wallet/index.mjs';

await migrateWallet(pool);
await provisionWallet(pool, {
  scope: {
    partner_id: 'partner_demo', app_id: 'app_demo', environment: 'sandbox',
    wallet_scope_id: 'main', currency_id: 'GOLD',
  },
  key_id, secret_base64, // 至少 32 字节随机秘密，Base64 编码
  users: [{ external_user_id: 'player_demo', balance_minor: '100000' }],
  treasury_minor: '1000000000000',
  math_profiles: [
    { game_id: 'thunder', math_version, math_config_hash, max_payout_multiplier: '10000' },
  ],
});
const wallet = createWalletServer(pool);
wallet.listen(8798, '127.0.0.1');
```

`provisionWallet` 只为新 scope/用户创建初始测试余额；重复调用不会覆盖已使用余额。新创建的本地开户资金写入 `reference_provision` 双向分录，明确是参考环境测试资产。更改已绑定 key 的 scope/secret 会失败。`registerMathProfiles` 可以登记新数学版本，但不能修改已有版本的 hash 或最高赔付倍数。空白名单不能进行概率授权。

`readWalletSnapshot` 和 `giftForTest` 是用于参考部署/测试的直接数据库函数，**没有 HTTP 调账路由**。`giftForTest` 代表合作方已有送礼路径必须与游戏冻结共用的账本约束，不代表本模块交付了完整礼物系统。

## 已实现的端点

- `POST /wallet/v1/reservations`
- `POST /wallet/v1/matches/capture`
- `POST /wallet/v1/matches/release`
- `POST /wallet/v1/matches/settle`
- `POST /wallet/v1/probability/authorize`
- `POST /wallet/v1/probability/accept`
- `POST /wallet/v1/probability/cancel`
- `POST /wallet/v1/probability/settle`
- `GET /wallet/v1/operations/{operation_id}`
- `GET /wallet/v1/matches/{match_id}`
- `GET /wallet/v1/probability/authorizations/{authorization_id}`
- `GET /wallet/v1/scopes/{wallet_scope_id}/currencies/{currency_id}/users/{external_user_id}/balance`
- `POST /wallet/v1/events`：持久去重通知，不作派奖。
- `GET /health`：只公开本地服务与数据库连通状态，无金融数据，无需签名。

除 health 外全部使用现有 [9 行 HMAC 规范](integration-guide.md)。密钥绑定完整范围，签名同时检查方向、原始 body、时间和持久化 nonce。JSON 重复键、非 UTF-8、BOM、压缩 body、查询参数和非法路径会被拒绝。请求与响应结构由 [OpenAPI](openapi.json) 定义。

成功及已持久化的业务拒绝均返回 HTTP 200 `Operation`，必须查看 `state`：`SUCCEEDED` 或 `REJECTED`；拒绝原因在 `rejection.code`，不能只凭 HTTP 200 开始游戏。验签、范围、schema、同号异参等请求层错误返回 4xx `Error`；不确定的数据库/基础设施错误返回 503，并要求原业务号查单。

Operation 的 `partner_id/app_id/environment/wallet_scope_id/currency_id` 在顶层，不是嵌套 scope。余额结构为：

```json
{
  "balance": {
    "external_user_id": "player_demo",
    "available_minor": "90000",
    "reserved_minor": "10000",
    "currency_scale": 2,
    "ledger_version": "18"
  }
}
```

可花余额取 `available_minor`；展示含冻结的余额合计时才计算 `available_minor + reserved_minor`。金额使用 BigInt 与 PostgreSQL bigint，JSON 始终使用十进制字符串。

## 原子性与资金约束

每个完整 scope 获取 PostgreSQL advisory transaction lock；不同连接/服务实例也受同一把数据库事务锁约束。正常查询与资金命令使用同一范围边界。幂等操作、账本分录、余额和最终凭据在一笔事务提交，不依赖内存 Map 或 Redis 去重。

业务号不仅在 scope 内唯一，还通过 `wallet_operation_ids` 在 partner/App/environment 内唯一，防止跨钱包范围重用同一业务号。原方法/路径/body 摘要相同返回原结果；任何差异拒绝。比赛捕获、结算及概率周期还有各自唯一终态约束，新 request_id 不能重复捕获或派彩。

竞技全员捕获、全员派奖和费用同时成功或同时不发生；作废全退、费用为零。并列首名奖池按 seat_index 升序分配余数；2v2 两名队员必须同名次并均分。当前参考实现的分奖语义是首名/并列首名/胜队，前二名奖励模板属于后续扩展。

取消先写永久墓碑；迟到的 Reserve/Capture/Authorize/Accept 不会复活已取消比赛/周期。捕获成功后不能 release，必须按规则作废结算；概率 ACCEPTED 后不能 cancel。

概率授权按已配置 profile 验证 `max_payout_minor = stake_minor × max_payout_multiplier`，同时冻结投注和完整付费周期毛派奖责任。受理时再次由数据库时钟检查未过期；受理后责任不自动过期。结算使用既有冻结责任，不因当时可用准备金为零拒赔。用户与准备金账户同时预留整数范围容量，避免已受理结果因余额上溢无法入账。

未捕获/未受理资金的 TTL 在该 scope 下一次钱包调用或参考赠礼调用时原子清理；余额查询也执行清理，因此过期冻结不能继续阻止合法消费。此参考版本尚未提供独立定时清理/长期运营任务。已捕获或已受理资金不参与这类过期清理。

## 真实 PostgreSQL 测试

从 `platform` 目录运行：

```sh
node --test tests/wallet.integration.test.mjs
```

默认使用上面的本地 PostgreSQL，或通过 `DATABASE_URL` 指定。测试每次创建独立随机 partner/scope，会写入并保留该范围内的测试用户、资金操作和账本记录；它不自动创建或删除测试数据库，也不删除、重置共享 schema 或现有演示用户。HTTP 使用临时本地端口，不占用正在运行的 8798。平台 API / PvP 集成测试的临时独立库策略不应套用到这个钱包单项测试。

钱包子集 **16/16 通过**，见[阶段 D 完整 TAP 报告](../review/phase-d/backend-report.txt)中的第 188–203 项；该报告同时包含其他模块，共 203 项。钱包验证包括：

1. 各 10 次真实并发捕获/派奖只有一次效果，账本守恒。
2. 重建 HTTP 服务后从 PostgreSQL 读回原凭据。
3. 真实代理在钱包提交后断开响应，原号查询与重试恢复。
4. 取消墓碑、预约 TTL、全员捕获失败和全额作废退款。
5. 送礼与入场冻结争抢同一笔可花余额，不透支。
6. partner/App/environment/钱包/币种隔离。
7. 受理后可用准备金为零仍用冻结责任完成中奖结算。
8. 非白名单数学版本、错误完整周期上限、授权过期被拒绝。
9. 验签、nonce、重复 JSON key、重复事件与不重复派奖。
10. 非法分奖全量回滚；三人并列余数；四人 2v2。
11. 捕获/取消、受理/取消真实并发只到达一个合法边界。
12. 固定 HMAC 向量一致；测试中的 HTTP 请求/响应同时经 OpenAPI schema 验证。

这些测试验证参考钱包，不替代整个平台与合作方的完整验收；App 登录、60 秒启动码、游戏引擎、移动端 WebView、UI/声音和平台恢复队列由对应模块另行验证。

## 仍需生产交付时补齐

独立合作方数据库与服务部署、密钥加密/KMS 与正式轮换、容量压测与更细粒度锁、nonce 归档/清理、独立到期清理任务、监控告警、备份恢复与整进程/数据库故障演练、管理审批与财务补偿流程。当前生产密钥、真实合作方接入和商业资产都没有在此模块上线。
