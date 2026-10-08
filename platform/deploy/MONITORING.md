# 只读运行监控

`monitor.mjs` 不调用游戏操作、不创建试玩身份、不修改数据库、不向外部消息或 webhook 渠道发送通知。它直接使用 PostgreSQL 只读连接统计待结算记录，因此 API 的浅层 `/health` 成功也不能掩盖数据库故障。所有查询均有超时。

沙箱默认每分钟检查 API、实际被 App 使用的参考钱包、公网 HTTPS 入口、试玩页面、数据库积压及超时、故障／停滞房间、OASIS 服务和备份／续期定时器、最近完成备份的文件存在性、磁盘空间、自有域名证书有效期。备份文件存在且新鲜并不证明可恢复；恢复演练需独立执行。公网入口检查来自服务器自身，也不能替代外部可用性监控或真实客户端验收。

概率局与钱包操作按 `created_at` 判断超时，避免持续失败重试更新 `updated_at` 后隐藏积压。PvP 活跃房间按最近更新时间、结算／故障房间按结束／故障时间、等待／扣款／取消房间按已冻结截止时间检查。

## 沙箱安装与检查

发布包安装后，以 root 执行以下命令；安装不会自动触发备份、续期或修复订单：

```sh
install -m 0644 /opt/oasis/current/platform/deploy/oasis-monitor.service /etc/systemd/system/oasis-monitor.service
install -m 0644 /opt/oasis/current/platform/deploy/oasis-monitor.timer /etc/systemd/system/oasis-monitor.timer
systemctl daemon-reload
systemctl enable --now oasis-monitor.timer
systemctl start oasis-monitor.service
cat /opt/oasis/private/monitor/status.json
journalctl -u oasis-monitor.service --since today --no-pager
```

服务读取既有 `/opt/oasis/private/runtime.env`，可在 root 专用 `0600` 的 `/opt/oasis/private/monitor.env` 覆盖阈值。不得把运行配置、连接串或凭证复制到网页目录。沙箱报告默认写入 `/opt/oasis/private/monitor/status.json`（可通过 `OASIS_MONITOR_STATUS_FILE` 指定），默认文件 `0600`、目录 `0700`。仅显式 `OASIS_MONITOR_REPORT_GROUP_READ=1` 才采用文件 `0640`、目录 `0750`；配套服务使用 `root:oasis`，允许平台进程通过经过鉴权的管理员接口只读检查报告。报告使用临时文件、fsync、原子替换；只包含检查名称、固定错误码及数字指标，不包含钱包数据、用户身份、Cookie、数据库连接串或异常原文。

`status=failed` 时进程返回 1；全部检查正常返回 0。第一次故障、检查状态变化、恢复时写一条结构化 journal 事件；同一故障重复检查不再输出应用事件，systemd 自身仍会记录任务失败。恢复后后续正常轮次保持安静。报告写入失败会输出固定 `MONITOR_EXECUTION_FAILED` 并非零退出，此时原报告的 `checked_at` 会停滞；读取方须检查新鲜度（建议 180 秒），不能只检查旧 `status`。

| 环境变量 | 默认值 |
| --- | --- |
| `OASIS_MONITOR_TIMEOUT_MS` | `5000`，单项超时 |
| `OASIS_MONITOR_OVERDUE_SECONDS` | `120`，未完成结算／钱包操作时限 |
| `OASIS_MONITOR_ROOM_STALE_SECONDS` | `180`，活跃房间停止更新时限 |
| `OASIS_MONITOR_BACKLOG_LIMIT` | `100`，各队列待处理数量上限 |
| `OASIS_MONITOR_DISK_USED_PERCENT` | `85`，可用空间口径 |
| `OASIS_MONITOR_BACKUP_MAX_HOURS` | `30` |
| `OASIS_MONITOR_CERT_MIN_DAYS` | `14` |
| `OASIS_MONITOR_DISK_PATHS` | `/opt/oasis,/var/lib/docker`，逗号分隔 |
| `OASIS_MONITOR_BACKUP_DIR` | `/opt/oasis/backups` |
| `OASIS_MONITOR_CERT_FILE` | `/opt/oasis/acme/config/live/oasis-game/fullchain.pem` |
| `OASIS_MONITOR_REPORT_GROUP_READ` | 脚本默认关闭；配套 systemd 服务显式设为 `1` |

服务使用既有 `OASIS_DATABASE_URL`、`OASIS_PUBLIC_ORIGIN` 和 API／钱包／试玩端口配置。数据库连接强制 `default_transaction_read_only=on`，无需导入平台服务启动模块。系统级 watchdog 限制单轮最长 30 秒。

## 生产与钱包依赖

`OASIS_ENVIRONMENT=production` 时必须 `OASIS_START_WALLET=0`，同时明确提供 API 端口、公网 HTTPS origin、独立 `OASIS_MONITOR_STATUS_FILE`、独立 `OASIS_MONITOR_BACKUP_DIR`、备份 `OASIS_MONITOR_BACKUP_UNIT`（service）与 `OASIS_MONITOR_BACKUP_TIMER`（timer）。缺项或复用已知沙箱默认项会在检查前失败。API unit 为 `oasis-production.service`；不检查 demo unit/试玩页面，不因参考钱包关闭而失败。Nginx/证书续期仍是实际共同依赖。loopback API 读取 `/health/ready`，公网入口读取既有 `/health`；两者必须明确返回当前环境。此处未修改 Nginx 路由。

数据库使用只读 repeatable-read 事务检查 `gp_runtime_identity`、App 环境、逐 App 钱包 binding 的完整 scope、有效 key/origin 配置及平台账本表和 scope。平台自有生产账本不走 HTTP 参考钱包，不创建用户、赠币、过期释放或测试交易。未知 provider、混合环境、改变的绑定、缺少 scope/table 均失败；最多检查 2000 个 App，超限明确失败，不能静默截断。该检查证明配置及数据结构可读，不等于逐笔对账或结算/恢复验收。

外部钱包保留真实独立模式。活跃 App 或仍有未决义务的外部钱包返回 `EXTERNAL_WALLET_PROBE_REQUIRED`，即使平台账本和参考钱包正常也不报绿。未定义统一外部 `/health` 合同，故此版本不以任意 HTTPS 200 代替签名余额验证，也不引入监控凭证加载。暂停且无未决义务的外部 App 可以尚未配置；已配置的暂停 App 显示配置状态，`external_connectivity=not_checked` 不表示外部账本可用。外部持续自动探测仍需后续明确的逐 App 合同与合法用户 ID。

生产备份还必须有 `runtime-identity.json`，形如 `{"environment":"production","database":"实际 current_database() 名称"}`；没有文件、环境错误或数据库名不符不得用该备份报告绿色。它是可信备份 producer 的身份声明，不验证 dump 内容或跨 cluster 唯一身份；完整校验及真实恢复演练仍是独立门槛。现有沙箱备份脚本不会产出这份生产声明，现有 monitor service/timer 仍读取沙箱配置。**本变更未安装生产监控 unit、生产备份 producer 或启用生产**；部署前必须实现并验证独立配置，不能直接把上面的沙箱安装命令当生产安装完成。

管理端读取报告也按环境拒绝错配：生产必须显式独立状态路径、报告 `environment=production`、完整八项检查且无矛盾状态；旧报告缺少 environment 仅在 sandbox 兼容。默认路径缺失或仍指向沙箱时显示 unavailable。当前健康身份绑定精度为环境（备份额外包含数据库名），**不证明同环境多个 API/数据库实例之间的唯一身份绑定**；多生产实例部署需另增实例身份与备份 cluster 绑定，不能从本检查推导已完成。

## 本地验证

`node --test tests/monitor.test.mjs tests/dependency-health.test.mjs tests/operations-status.test.mjs` 覆盖配置、依赖、真实 loopback HTTP 与报告消费。`node --test tests/dependency-health.integration.test.mjs tests/runtime-isolation.test.mjs` 创建独立本地 PostgreSQL 数据库并启动真实 API，验证生产平台/外部混合模式、admin session 环境及错误依赖；结束必须删掉各自创建的库。测试不访问部署数据库、公网或设备。
