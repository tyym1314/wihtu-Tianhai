# Match 主画面更新成本对照（2026-10-07）

**结论边界：**旧正式样本的 233.3 ms 前台帧间隔仍是 `FRAME-01/02` 失败。本次本机对照没有复现该尖峰，不能说已定位或修复它，也不能代替 iPhone 15 Pro Safari 验收。旧峰发生在第 40/41 次权威交换确认后的演出窗口，原记录无活跃期 Long Task；后续 CDP trace 同样未复现，正常帧中主线程最大 task 5.3 ms。见 [旧峰只读与 trace 审查](../../../../review/deep-mobile-20261004/match-frame-spike-review.md)。

本次改动只门控 `MatchGame` 的展示时钟状态：仍每 80 ms 比较权威剩余时间与 `busyUntil`，但整块 6×6 棋盘只在画面可见秒数或忙碌锁变化时因时钟提交。实际提交前仍以当前服务端时钟独立校验动作截止与忙碌状态；未改权威引擎、交换、消除或数学结果。

| 同一 65 秒夹具 | 改前 | 改后 |
| --- | ---: | ---: |
| 权威有效交换 | 47 | 47 |
| React Profiler 提交 | 1,769 | 1,181（-33.2%） |
| React Profiler `actualDuration` 累计 | 6,073.1 ms | 4,370.9 ms（-28.0%） |
| RAF P95 / P99 | 16.8 / 16.8 ms | 16.8 / 16.8 ms |
| RAF 最大 | 16.8 ms | 33.4 ms |
| >50 ms 帧 / Long Task | 0 / 0 | 0 / 0 |
| 页面或资源错误 | 0 | 0 |

两次在同一 Mac/Chrome 154.0.8037.98、390×844 CSS px、DPR2、前台、CPU 1×、本地 loopback 及 300 ms 房间轮询下**串行**运行；种子、47 组 `from/to` 与每组 wave 数逐项相同。使用真实 Playwright 点击、独立 HTTP、同一权威 Match 引擎。React Profiler 会增加诊断开销，累计 `actualDuration` 是 React 自报渲染时间，不等同整机 CPU 时间；单次对照不能推断分布显著性或线上收益。改后最大 RAF 从 16.8 到 33.4 ms 也显示本机噪声存在。原始逐帧/逐提交/逐动作数据分别在 [before.json](before.json) 和 [after.json](after.json)，可用 `node tests/match-frame-profile.mjs before|after` 复测。产品文件改前 SHA-256 `af0762bf5c5b4f30b0c8bd193005d8ba9ba0f7fa5f5d6b548d874129fceeee21`，改后 `e9d21ce04d06d27b9f2a1866b0d6fa9d6a8654ed229ecab27aa668cd2f60c1e5`。

定向回归：`node --test tests/match-engine.test.mjs tests/match-content.test.mjs` 23/23；`node tests/match-ui.mjs` 通过，覆盖倒计时推进、真实点击与滑动、无效交换、轮询中的动画、资产解码、中阿英语言和低动态效果。UI 夹具补齐当前哈希资源及目标模式分数字段读取；未改变产品资源。没有运行全量发布构建、真实手机或公网性能验收。
