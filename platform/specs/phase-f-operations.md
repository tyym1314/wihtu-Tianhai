# Phase F 本机运行与恢复

本文仅用于当前本机沙箱。公网发布、生产迁移和真实合作方环境另行验收。

## 进程与文件

| 端口 | 服务 | 启动方式（从 platform 目录） |
|---|---|---|
| 5487 | 本机 PostgreSQL | `npm run db:start` |
| 8795 | 管理台、游戏公共入口 | `npm run dev` |
| 8797、8798 | 平台 API、原参考钱包 | `OASIS_WALLET_ALLOWED_ORIGINS=http://127.0.0.1:8801 npm run server` |
| 8801 | 独立合作方参考钱包 | 见下方命令 |
| 8800 | 独立合作方 H5 / BFF | `node specs/examples/partner-host/server.mjs --config "$PWD/.local/partner-host.json"` |
| 8787、8790 | 原两款独立游戏 | 保留原服务，不随平台重启 |

```sh
OASIS_PARTNER_WALLET_DATABASE_URL='postgres://oasis_local@127.0.0.1:5487/oasis_partner_sandbox' \
OASIS_PARTNER_WALLET_CONFIG='.local/partner-wallet/config.json' \
node examples/partner-wallet/server.mjs
```

启动前用 `lsof -nP -iTCP:端口 -sTCP:LISTEN` 确认没有另一份服务。平台 API 的钱包允许列表必须在每次启动保留。独立示例的日志在 `.local/partner-wallet/server.log` 与 `.local/partner-host.log`；不应打印配置内容或密钥。

管理账号沿用现有配置。专用合作方测试账号及 App 凭证保存在权限 `0600` 的 `.local/phase-f-partner-account.json`；H5 BFF 与钱包各读取自己的私有配置。前端包、教程、截图、ZIP 均不包含这些文件。

重新构建游戏和后台静态页面：

```sh
npm run build:legacy
npm run build:arena
npm run build
```

`build:legacy` 只对复制件做平台适配，原游戏源码保持不变。游戏 API 读取已构建的 `legacy/dist` 和 `arena/dist`；只刷新浏览器不能替代游戏资源构建。

## 重启与未知结果

1. 计划维护前暂停新会话接入，检查局单页和接入报告是否存在未决操作。暂停 App 仅拒绝新会话，不能取消已经受理的责任。
2. 保留原库、原密钥、原钱包绑定与业务号，使用 SIGTERM 停止需要更新的进程。不要为了重启清空数据库、钱包日志表或重建 App。
3. 先启动 PostgreSQL 和独立钱包，再启动平台 API、H5 入口、BFF。检查 `/health` 后，还应执行签名余额探测并查询原业务号；健康检查不能证明账务正确。
4. 平台会恢复原操作与 `RUNNING` 接入检查。网络退避最长 30 秒，429 退避 65 秒；看到等待状态时不要创建新的资金操作。概率结果已经固定后只重试原结果的结算。
5. 对局短中断按已实现规则共用暂停，长中断可能整局作废；单方断线也可能按规则弃权。恢复不保证继续原动画，更不能靠浏览器显示判断退款。

当前已用隔离测试验证：钱包已成功捕获但响应丢失时，强制终止并重启平台，沿用同一房间和同一 capture/settle 操作恢复，重复请求不会额外扣款/派奖。它不代表物理机断电、跨区故障或完整备份恢复均已验收。

## 保留与停用

备份应包含平台数据库 `oasis_platform`、独立钱包数据库 `oasis_partner_sandbox`、平台 `.local/master.key` 及各服务私有配置。应在停止新写入并核对未决责任后取得一致备份；不能只保存前端产物。当前尚未执行生产级备份恢复演练。

需要停用 Phase F 示例时，先暂停 **Majlis 独立沙箱**，核对该 App 原局、资金操作和检查任务终态，再停止 8800 与 8801 的专属进程。保留数据库和原绑定用于审计。不要改动原四个 App、16 个原钱包用户、管理员账号或 8787/8790 服务。

这是一条示例服务停用路径，不是数据库向旧版本回滚方案。此次迁移为新增表/列/索引；不能未经核对删除迁移，因为其中可能已有接入记录、账户和资金凭据。

## 已知容量边界

本机基准使用 12 个独立测试 App / 12 个免费 BOT 房，12 与 24 条请求流。24 条流仍对应 12 个人类控制席，不能称为 24 个独立真人房或生产 CCU。保龄球刚体计算当前与 HTTP 服务共用进程，会增加其他游戏延迟；后续需要独立计算执行、更多负载档位和目标地区实测。

重跑隔离基准：`node scripts/benchmark-phase-f.mjs`。报告含 p50/p95/max、实际动作数、游戏故障快照和清理结果；HTTP 200 本身不等于对局正常。
