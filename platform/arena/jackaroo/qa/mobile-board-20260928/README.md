# Jackaroo 手机选择、拆七与派生数据

2026-09-28。仅修改 `JackarooGame.jsx` 和本模块 `restoration.css`。暗传、换位、完整拆七和胜负规则不变。

- 四位玩家头像位于棋盘外的独立栏，不再遮住外环。
- 原小而互不重叠的 SVG hitbox 保留。新增按玩家/珠号区分、至少 44×44 px 的独立选择按钮；每个按钮仍来自服务器同一份完整合法动作集合。
- 拆七步数按钮至少 44×44 px，效果按钮和确认按钮同步扩大。确认栏随滚动保留在视口中，部分七步仍不能提交。
- 帮助文字明确全队八珠入家获胜。
- `useMemo` 缓存 cardActions、modes、options、可用牌、splitOptions、nextSegments、selectable、chosen、preview 和步数列表；稳定 callback 与 memoized Board 避免单纯倒计时变化重画棋盘。没有削减或截断合法方案。

运行：`node tests/mobile-board-controls-ui.mjs`。

Chrome 原生触摸与桌面 WebKit 可信指针各在 390×844、360×844 完成实际 HTTP 换位及原子 3+4 拆七，验证指定两珠的新位置、路径吃子、部分计划禁用和确认栏位置。矩阵与截图见同目录 `report.json`、`*-split.png`。

另用明确配置的 916 条拆七合法动作状态，只在 QA 暂停新快照请求，保留真实 100 ms 显示时钟运行。1150 ms 内检查倒计时继续变化，而效果派生访问与 Board 重绘增量均为 0；新快照或选择仍会正常重算。观察计数仅注入 QA 编译，生产无计数器。

隔离引擎 fixture 为明确可重放位置；没有生产房间或钱包。WebKit 是桌面浏览器引擎，不代表 iPhone Safari 真机触摸验收。临时服务器清理读回见 `../../../ludo/qa/mobile-board-20260928/server-cleanup.json`。
