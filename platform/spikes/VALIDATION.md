# 阶段 A 跑酷灰盒验证报告

测试开始：2026-09-18T13:00:54.286Z；结束：2026-09-18T13:01:11.672Z。结果：**本地桌面技术链路通过**。本报告不代表正式游戏或移动端性能验收。

## 实际测试环境

- 系统：darwin 25.2.0 / arm64，Node v22.22.3。
- 浏览器：系统 Chrome 153.0.8010.52，父目录 Playwright 驱动，headless，四个独立上下文，每个 1280×900。
- 网络：4 个真实 WebSocket 连接到 `127.0.0.1:8796`；100/150/200/250 ms 是客户端队列额外延迟，不是运营商、跨区或移动网络实测。
- 场景：程序化占位角色、简化 78 米四道赛道、4 组障碍。没有真实金币、专业角色素材或 App 身份。

## 检查结果

| 检查 | 实测结果 |
|---|---|
| 服务端规则测试 | 6/6 通过，见 unit-tests.tap |
| 独立浏览器/socket 身份 | qa-0 至 qa-3，共 4 个 |
| 非法客户端传入 z=999 | INVALID_INPUT 拒绝，未接受瞬移 |
| 重复输入序号 | DUPLICATE_SEQUENCE 拒绝 |
| 断线恢复 | runner-0 断线后恢复同角色、同 clientId、保留 lastSeq；位置继续前进 |
| 四端最终结果 | 全部 winner=runner-1，结果摘要相同 |
| 结果回执 | 服务端收到并验证 4/4 份 |
| 浏览器未捕获异常 | 0 |
| 默认预览连接 | 1 个用户＋3 个明确脚本测试连接，通过开始/跳跃/重置 |

最终结果摘要：`3bdbd24eda000162449cb00d110ff404402e72242215fe68fcaafcbabd688cfe`。

重连前 runner-0 位置 **11.30 m**，重连后 **17.26 m**；输入序号 1 → 1。比赛没有因客户端退出暂停或重新创建玩家。

## 短时桌面观测值

| 客户端 | 人工增加 RTT | 测得 RTT 样本 | 帧时间 p95 | 最终首名 | 摘要 |
|---|---:|---:|---:|---|---|
| qa-0 | 100 ms | 102.1 ms | 16.8 ms | runner-1 | 一致 |
| qa-1 | 150 ms | 152.1 ms | 16.8 ms | runner-1 | 一致 |
| qa-2 | 200 ms | 203.4 ms | 16.7 ms | runner-1 | 一致 |
| qa-3 | 250 ms | 253.0 ms | 16.7 ms | runner-1 | 一致 |

帧时间由浏览器 requestAnimationFrame 的间隔统计，包含本次短测试启动阶段；不是 GPU 定时器，也不是移动端 20 分钟持续性能。RTT 为结束时最近的 ping 样本，不是网络分位数统计。服务器本次记录的最大单步计算时间为 1.124 ms，仅对这个简化场景有效。

## 证据文件与限制

机器证据：[browser-validation.json](evidence/browser-validation.json)；普通预览：[default-preview-validation.json](evidence/default-preview-validation.json)；规则测试：[unit-tests.tap](evidence/unit-tests.tap)。实际画面：[运行中](evidence/graybox-racing.png)、[已冲线](evidence/graybox-finished.png)。运行中截图已目视检查，四个模型、跳跃控制、脚本角色标签、延迟与帧时指标可见。

未验证：APK/WKWebView 真机、低端机、长时温升/内存、专业骨骼模型、最终视觉图还原、真实公网弱网、跨区域部署、生产并发、服务器重启后恢复、正式反作弊与钱包结算。当前恢复证明仅针对同进程 WebSocket 断线，房间仍在内存。到阶段 C/E 必须补做上述对应验收。
