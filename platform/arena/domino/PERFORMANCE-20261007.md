# Domino 时钟渲染专项，2026-10-07

冻结标准是 [`mobile-quality-v1`](../../specs/mobile-quality-v1.md)：活动前台采样至少 60 秒，P95 ≤20ms、P99 ≤34ms、最大 ≤100ms，不能用本地短夹具替代 iPhone 15 Pro Safari 验收。

旧公开候选的 20.1 秒 Domino 活动记录出现一次 116.6ms 可见 RAF 间隔，位于页面时钟 16374.0–16490.6ms；当时没有触摸或 HTTP 回包重叠，原记录没有可用调用栈。因此该峰仍是 `fail`，本次不宣称找到了它的根因。详见 [旧峰复核](../../review/deep-mobile-20261004/domino-thunder-spike-review.md)及[旧发布状态](../../review/deep-mobile-20261004/release-quality-status.md)。

独立确认的冗余工作是 `DominoGame.jsx` 原先每 80ms 把新时间写入 React state；即使显示秒数和 `busyUntil` 的可操作状态都不变，也会重算整张牌桌的 JSX。现在仍每 80ms 检查边界，但只有秒数或忙碌状态变化时更新 state。规则引擎、出牌请求、操作解锁时间和隐藏页停止时钟的机制没有改动。

使用 [`performance-fixture.jsx`](performance-fixture.jsx) 和 [`domino-render-cadence.mjs`](../../tests/domino-render-cadence.mjs)，在同一台 Mac 的本地 Chromium 390×844 / DPR2 / touch 视口，对同一个 20 张可见牌链、20 秒倒计时做两组成对的 5 秒空闲采样。基线从 Git `063063c41fb99c298b92a699501d76955677a6e0` 读取旧 `DominoGame.jsx`，候选读取工作区文件；两者均由同一 esbuild 夹具打包，没有实际服务端、钱包或网络节流。

| 指标 | Git 基线（第一次 / 第二次） | 候选（第一次 / 第二次） |
| --- | ---: | ---: |
| 5 秒 React Profiler commits | 64 / 64 | 12 / 12 |
| React Profiler 累计 actualDuration | 527.9 / 596.8ms | 58.3 / 66.0ms |
| 倒计时 | 20→15 / 20→15 秒 | 20→15 / 20→15 秒 |
| 420ms `busyUntil` 后按钮可用 | 464.8 / 485.4ms | 489.1 / 451.0ms |
| RAF P95 / P99 / max | 16.8 / 16.8 / 16.8ms（两次） | 16.7 / 16.8 / 16.8ms（两次） |
| 页面、资源异常 | 0 / 0 | 0 / 0 |

这次可归因的改善是空闲牌桌 React 工作量减少；短夹具中两版 RAF 本就无长帧，因此不能写成旧 116.6ms 问题已修复。一次前后对照也不提供统计置信区间。`node --test tests/domino-engine.test.mjs` 15/15 通过；该定向 UI 夹具检查倒计时、20 牌链、操作禁用与解锁、资源打包和页面异常。未重跑 ≥60 秒完整局、复杂中盘、物理 iPhone 或公网候选，移动发布状态继续保持 `fail`。
