# Tower Link v2 integration

当前规则 `towerlink-v2.1.0`：Lv.1 / 2 / 3 每塔总出兵 1 / 2 / 3 兵每秒、最多 1 / 2 / 3 路；中央要塞固定 2 兵每秒、最多 2 路。沿相邻道路出线，每秒节拍均分总兵量且整数余兵轮转，留守 5 兵；新增路线超限返回 `ROUTE_LIMIT_REACHED`。`link` 添加一线而非替换，`unlink {from,to}` 只撤销一线，`stop {towerId}` 清除全部；在途部队均继续原路。公共 `view.orders` 始终为扁平路线数组，不能按每塔只取一条处理。

公开的完整玩法、动作、模式、平局退款和恢复契约见 [specs/towerlink-v2-integration.md](../../specs/towerlink-v2-integration.md)。该文档会随 `/specs/` 发布，并在平台开发文档资源区提供入口。

隔离 PostgreSQL 与独立 HTTP 钱包集成验证：`npx tsx --test tests/towerlink.pvp.integration.test.mjs`。测试自行创建并销毁随机数据库，不操作正在使用的沙箱或生产房间。

发布前排空旧房。v2.0.0 与更早房间按其冻结版本保留：旧等待/扣款准备房取消，已捕获资金按原请求返还；旧活动房使用 `PINNED_RULE_UNAVAILABLE` 流程，无法恢复则全额退款。禁止修改旧房版本号后交给新引擎继续运行。钱包的双人金币边界、三/四人免费边界与幂等键不变。
