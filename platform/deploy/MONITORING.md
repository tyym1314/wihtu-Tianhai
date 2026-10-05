# 只读运行监控

`monitor.mjs` 不调用游戏操作、不创建试玩身份、不修改数据库、不向外部消息或 webhook 渠道发送通知。它直接使用 PostgreSQL 只读连接统计待结算记录，因此 API 的浅层 `/health` 成功也不能掩盖数据库故障。所有查询均有超时。

默认每分钟检查 API、参考钱包、公网 HTTPS 入口、试玩页面、数据库积压及超时、故障／停滞房间、OASIS 服务和备份／续期定时器、最近完成备份的文件存在性、磁盘空间、自有域名证书有效期。备份文件存在且新鲜并不证明可恢复；恢复演练需独立执行。公网入口检查来自服务器自身，也不能替代外部可用性监控或真实客户端验收。

概率局与钱包操作按 `created_at` 判断超时，避免持续失败重试更新 `updated_at` 后隐藏积压。PvP 活跃房间按最近更新时间、结算／故障房间按结束／故障时间、等待／扣款／取消房间按已冻结截止时间检查。

## 安装与检查

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

服务读取既有 `/opt/oasis/private/runtime.env`，可在 root 专用 `0600` 的 `/opt/oasis/private/monitor.env` 覆盖阈值。不得把运行配置、连接串或凭证复制到网页目录。报告固定写入 `/opt/oasis/private/monitor/status.json`，默认文件 `0600`、目录 `0700`。仅显式 `OASIS_MONITOR_REPORT_GROUP_READ=1` 才采用文件 `0640`、目录 `0750`；配套服务使用 `root:oasis`，允许平台进程通过经过鉴权的管理员接口只读检查报告。报告使用临时文件、fsync、原子替换；只包含检查名称、固定错误码及数字指标，不包含钱包数据、用户身份、Cookie、数据库连接串或异常原文。

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

测试：`node --test tests/monitor.test.mjs`。测试注入故障和时间，不修改真实数据库或服务器。
