# Tiger 活动峰边界，2026-10-07

当前保留的发布样本中，Tiger 71.8 秒活动有一次 149.9ms RAF 间隔（页面时钟 19177.0–19326.9ms）。它位于第 4 次 spin ACK 完成后、第 5 次可信 `pointerup` 前，没有同期请求或静态资源传输。原样本没有 `pointerdown` 时间或 LongTask/主线程任务栈，不能将这次峰归因于服务器、音频、动画、GC 或自动化。

后续独立 71.545 秒、19 次 SETTLED spin/ACK 的观察没有复现峰，活动最大 16.8ms。那次观察测得 AudioContext 构造 123.3ms，但发生在**加载阶段**；七个 AudioBuffer 复制也在活动采样开始前，活动中没有重新准备 buffer。无峰的新样本不能清除旧样本的 `fail`。证据见 [`tiger-audio-spike-readonly.md`](../../platform/review/deep-mobile-20261004/probability-audio-v2/tiger-audio-spike-readonly.md)、[`tiger-causal-v1/runs/outcome.md`](../../platform/review/deep-mobile-20261004/diagnostic/tiger-causal-v1/runs/outcome.md)与[发布矩阵](../../platform/review/deep-mobile-20261004/release-quality-status.md)。

本次没有修改 Tiger 源码或概率数学。`./node_modules/.bin/tsx --test tests/tiger-audio.test.ts tests/tiger-math.test.ts` 19/19 通过，只证明音频状态和规则单测，不是物理 Safari 或 60 秒复测。后续若在独占测量窗口复查，应复用原 spin/ACK 驱动并在第 4 次 ACK 到第 5 次手势之间记录真实 `pointerdown`/`pointerup`、LongTask/LoAF、Task/Layout/Paint/GC 和动画阶段，再按具体证据确定修复。当前发布状态保持 `fail`。
