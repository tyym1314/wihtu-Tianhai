# 台球手机输入回归

2026-09-28。仅修改 `table.mjs` 和 `PoolGame.jsx` 的触控生命周期与派发门控；原渲染、物理、规则和画质保留。

- 自由球由起手指针的合法释放提交，任意其他 pointerup 不再放球。取消会清空预览，不发送请求。
- 叫袋从 pointerdown 改为同一指针在同一袋口释放后提交，取消/拖离袋口不会叫袋。
- 拖拽和旋转控制绑定 pointerId、服务器回合与 shotId；第二触点、失 capture、隐藏/失焦、可操作状态变化会取消。帮助期间禁用操作，发送前复核截止时钟并持同步 pending 锁。
- WebKit 中刚请求的 pending capture 被释放时，不一定产生 lostpointercapture。移动/释放额外核验 hasPointerCapture，已用真实浏览器复现路径验证取消不会误叫袋。

运行 `node tests/precision-touch-ui.mjs`。Chrome 8 项、WebKit 7 项检查通过，页面错误 0。自由球取消/丢失 capture/双指/跨回合均为 0 次 HTTP 请求；之后正常放球和叫袋各由真实引擎受理一次。旋转控件在第二指按到控件外时也会终止原拖拽。

证据在 `report.json` 与两张浏览器截图。Chrome 为原生 trusted touch（含多指），桌面 WebKit 为原生 trusted mouse pointer，不能代替 iPhone Safari 实机验收。独立 HTTP 引擎在校验之前计数全部请求；无生产房间、钱包或部署。
