# 平台自有钱包（生产候选）

生产新建 App 默认选择 `platform` 钱包：`gp_wallet_bindings.provider` 持久记录提供方，`wallet_scopes` 保存该 App 独立账务范围，`wallet_users` 保存真实注册玩家的可用、冻结和待入账容量。新建资金池与玩家账户余额均为 **0**，不调用参考钱包、不创建钱包方向 HMAC 密钥、不发放演示币、不迁移沙箱余额。注册玩家、App 内身份映射、零余额开户及审计在同一 PostgreSQL 事务提交。既有玩家的新 App 绑定幂等开户，不会覆盖已有余额。

内部提供方直接调用 `wallet/index.mjs` 的账本事务核，不伪装为 HTTP 钱包。冻结、捕获、派奖、释放、到期退款、原业务号查单和相同请求重放共用原有 App scope 锁、数据库事务、账本守恒和持久幂等规则。内部请求没有跨网络重试；进程重启后仍从原有业务号和 PostgreSQL 回执恢复。参考钱包 `provisionWallet` 仅允许 sandbox，production 调用返回 `REFERENCE_PROVISION_SANDBOX_ONLY`。

生产创建接口 `POST /api/partner/apps` 的可选字段 `wallet_provider` 接受 `platform`（默认）或 `external`。选择 `external` 的 App 保持未绑定状态，随后走原有允许列表内 HTTPS 钱包配置、HMAC、DNS/IP 校验及签名余额探针。迁移给所有既有钱包绑定填入 `external`，不改变 URL、密钥、scope 或余额。既有、暂停且无会话/订单的未绑定生产 App 可向 `POST /api/partner/apps/{app_id}/integration/wallet` 提交 `{"provider":"platform"}`；绑定后不可改换提供方。sandbox 仍沿用参考钱包与原来的外部联调行为，不接受 platform 提供方。

`GET /api/partner/apps/{app_id}/integration` 的 `wallet.mode` 区分 `platform`、`external`、`reference` 和 `unconfigured`；`platform` 的 URL 为空、钱包 key ID 为 null。账户余额仍经同一个游戏余额接口返回，范围、用户和币种精度必须与 App 匹配。不同 App 的玩家 ID、账户与订单不互通。

迁移保留既有 external/sandbox 行，但生产库一旦创建 platform 绑定，旧代码无法理解空 URL/key 和内部提供方。此时回滚目标必须是支持 platform 的已验证版本，不能仅凭 SQL 可增量执行就回滚到旧外部钱包限定代码；任何回滚均不得重置玩家余额或账本。

零余额玩家可以通过正式玩家 BFF 创建免费竞技练习；免费局不扣款、不新增账本资金记录。付费局在余额不足时返回持久的 `INSUFFICIENT_FUNDS` 拒绝，相同业务号仍返回同一拒绝。**当前没有生产充值、提现或人工调账入口**；测试注资只存在于隔离数据库测试夹具，不能作为运营资金来源。启用付费运营前仍需实现资金来源、对账、退款与权限审批体系并单独验收。

该提供方不打开生产准入。App 默认暂停，`OASIS_PRODUCTION_ADMISSION_ENABLED` 默认关闭；宿主 Origin、玩家身份、CSRF、手机性能和容量验收仍是上线条件。概率游戏生产数学审批仍不通过，因此 `thunder`／`tiger` 继续禁止进入生产 App。公网沙箱与 APK mock 不因该模块成为生产环境。

验证命令：`node --import tsx --test tests/platform-wallet.integration.test.mjs`。测试创建并最终删除随机隔离 PostgreSQL 数据库，覆盖注册→App 身份→零余额→免费会话、跨 App 拒绝、不开测试币、冻结/捕获/结算/退款、相同请求并发与新连接池重放、外部提供方迁移和生产准入/数学门槛。
