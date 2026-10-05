# 独立合作方参考钱包 · 本机沙箱

这个入口在独立进程、独立 PostgreSQL 数据库运行现有钱包协议实现；HTTP 只监听 `127.0.0.1:8801`，不提供网页、文件或无授权调账接口。它证明部署边界可分离，不代表已有真实合作方币账或生产钱包。

在 `platform/` 下执行 `npm ci` 安装根依赖。先由数据库管理员创建一个专用测试数据库，例如 `oasis_partner_sandbox`。不要使用 `oasis_platform` 或平台当前配置的数据库。

将 [config.example.json](config.example.json) 复制到 **platform/.local/partner-wallet/config.json**，设置目录权限 0700、文件权限 0600。填入新建沙箱 App 的完整 scope，以及专用于 `platform-to-wallet` 的独立 key ID / Base64 secret；这个 secret 与调用平台 `/v1/sessions` 的 `partner-to-platform` secret 不同。配置文件不能放入公开目录、仓库、截图或日志。

数学配置必须填写平台当前批准的 `math_version`、`math_config_hash` 和完整周期最高派彩倍数。模板明确不包含可用数学 hash，不要直接把占位值当作已批准配置。默认提供每款游戏一个配置；若沙箱允许 98 / 99 两种参数，须为两款游戏分别登记相应的不可变版本，总共四条。当前参考上限 Thunder 为 10000 倍、Tiger 为 455 倍，最终仍以登记版本为准。

```sh
OASIS_PARTNER_WALLET_DATABASE_URL='postgres://oasis_local@127.0.0.1:5487/oasis_partner_sandbox' \
OASIS_PARTNER_WALLET_CONFIG='.local/partner-wallet/config.json' \
node examples/partner-wallet/server.mjs
```

开服仅为新 scope / 用户创建配置中的测试余额；重启不重置已有余额或已绑定密钥。四个 demo 用户、参考准备金及开户分录均只写入独立钱包数据库。启动日志没有 key、secret、用户余额或数据库连接凭证。

平台部署配置需加入 `OASIS_WALLET_ALLOWED_ORIGINS=http://127.0.0.1:8801`。由平台管理员或所属合作方开发者给全新、暂停、没有会话/房间/周期/出站账务记录的沙箱 App 绑定该 origin 与钱包方向密钥；绑定永久锁定，不能把旧 App 已受理的操作移往新钱包。原本参考钱包里的测试余额不会复制过来。

绑定完成后，使用 `demo_player` 做签名余额探测。该请求验证方向、scope、用户、币种精度与账户存在性，通过 GET 查询金额；参考钱包会登记防重放 nonce，并按正常规则释放已到期冻结。随后再依据平台接入教程创建真实启动会话、进行测试入场与结算，并查看双方账务凭据。普通 `GET /health` 成功不能替代验签、主钱包事务或完整接入验收。

安全连接层仅允许精确部署白名单 origin；HTTP 限回环地址，外部 HTTPS 要求公开 DNS 地址与有效 TLS，并将校验过的地址固定用于该次连接。拒绝重定向、超出 128 KiB 的响应和 3 秒超时。超时视为结果未知，平台保留原业务号查单。

当前只验证回环 HTTP 与独立本机数据库；公网域名、实际 TLS 链路和真实合作方设施尚未验收。生产密钥管理、KMS/HSM、跨区链路、备份恢复、容量、监控告警与真实 App 送礼账本接入仍需分别实现和验收。示例数据库中的 `wallet_keys` 是参考实现存储，不能当作生产密钥托管方案。
