# 沙丘竞速卡顿诊断与本地修复（2026-09-28）

本报告的浏览器是 macOS 上 Chrome / Playwright WebKit。移动视口、触控、DPR 3 与 CPU 限速均不能替代 iPhone 15 Pro Safari 真机验收。未部署。

## 已复现的原因

1. **60 FPS 仍会停走。** 原 `projectedPose()` 在收到快照 250 ms 后停止前进；入口原来每次 HTTP 返回后再等待 150 ms 才发下一次请求。即使每次 HTTP 仅耗时 200 ms，实际间隔也超过视觉外推上限。以 400 ms 固定快照重现，Chrome 的 rAF P95 是 16.7 ms，但 **126 / 377 帧（33.4%）位置完全静止**。这是视觉时间线问题，不能用 rAF 检查证明流畅。
2. **GPU 准备发生在游玩中。** 首轮 WebKit 测试跑到约 47 m（接近第一个水沟）时，单次 `renderer.render()` 耗时 165 ms；原版 Chrome 同一位置观察到 104.8 ms。此时首次出现的几何计数由 25 升至 31。初次可见材质程序/缓冲区准备是可复现的阻塞路径，CPU/rAF 的稳态中位数会掩盖它。
3. **资产准备晚、材质重复准备。** 原场景尚未收到纹理时先渲染占位石材，收到纹理后重新准备另一套材质；所有赛道、角色资源都等比赛已开始才加载。此次提供专属资源预载入口，开局前调用由主入口负责。

## 已修复

- 投影统一使用 650 ms 有界时间；覆盖 350 / 400 / 600 ms 正常快照间隔。超过上限仍等待服务器，客户端不计算碰撞、名次、成绩或输入 tick。
- 重复/旧快照不再重新计时，避免旧状态不断重置视觉位置。
- `preloadRunAssets(kinds)` 按选定/实际角色预载跑步 atlas，以及共享动作、正面、背景、场景 GLB 与石材贴图，场景复用缓存；失败缓存可重试。未传 kinds 时保留全部角色的兼容行为，主入口应传实际所需角色。
- 所有资产齐全后在 loading 阶段使用 public `renderer.compile()` 并以 `try/catch` 处理同步失败，准备全部场景材质，包含尚未进入视野的水沟与护盾。仅在下一次真实 `render()` 完成后显示可玩状态。最终实现不使用 `compileAsync()`，避免它的同步异常越过 Promise catch，以及内部轮询在退出/dispose 后继续访问已释放的程序。编译失败会停止 RAF 并通知错误状态。
- 桥面分块剔除；重复桥墩按 24 m 空间分组实例化，保留原 GLB 几何、材质和变换。近处棕榈/岩石保留逐物件可见范围。角色重复 UV 计算与不必要的材质刷新已去掉。

## 本地证据

| 测量 | Chrome 原版 | Chrome 最终 | WebKit 最终 |
|---|---:|---:|---:|
| 400 ms 快照间隔下的静止帧 | 126 / 377 | 0 / 361 | 0 / 381 |
| rAF P95 | 16.7 ms | 16.7 ms | 19 ms |
| 采样期间 render 提交最大耗时 | 104.8 ms | 4.5 ms | 4 ms |
| 可玩采样期间 shader program 数 | 未记录 | 固定 12 | 固定 12 |

Chrome 使用 M4 Pro Metal、CPU 4 倍限速。WebKit 未限速，报告为 Apple GPU。两者不可横向比较为浏览器性能排行。

启动仍有同步工作，不能宣称消除全部启动阻塞。最终 Chrome 初始化创建约 213 ms，加载期间仍记录 451 ms 长任务。前后启动时间和 GPU 提交耗时会受驱动 shader 缓存影响，不能把重复运行结果直接换算成 iPhone 提升倍数。确定性的主要验收证据是 400 ms 快照停止帧由 33.4% 降为 0、350/400/600 ms 单元测试、可玩期间程序数保持固定，以及真实 HTTP 动作回归。

`before.json` / `before-raw.json` 为原始基线，`safe-compile.json` / `safe-compile-raw.json` 为最终 Chrome，`webkit-safe-compile.json` / `webkit-safe-compile-raw.json` 为最终 WebKit。`after`、`webkit-after`、`after-warm`、`webkit-after-warm` 为中间诊断，后两者是在生命周期审查前使用 `compileAsync()` 的版本。`scene-before.txt` / `environment-before.txt` 保留原始代码证据。图像来自各次实际渲染。

`compilation-lifecycle.json` 为最终实现的四项真实 WebKit 生命周期验证：同步编译异常只触发一次错误，不开放输入也不渲染；GLB 加载期间退出不留下 canvas/回调；编译完成后首帧前退出不留下异步轮询；正常路径只在首帧实际渲染后触发一次 ready。四项均无未捕获异常。

## 01 发布后的两项额外下载修复（供 02 发布）

使用原始图片字节、同源 HTTP、`Cache-Control: public, max-age=31536000, immutable`，每组开启新的桌面 Playwright WebKit 上下文，记录服务器实际响应计数以及浏览器 Resource Timing。前版通过只在内存构建中还原全角色预载与 Three.js 默认 anonymous CORS 模式对照；没有改动旧发布或调用公网房间 API。

| 两人预载与 CSS 头像 | before | after |
|---|---:|---:|
| 跑步图集 | 4 张 | fox / cat 2 张 |
| front-win 实际 HTTP 下载次数 | 2 次：cors + no-cors | 1 次：no-cors |
| 图像响应体合计 | 2,723,410 B | 1,626,738 B |

确定减少 **1,096,672 B**：未使用 bear/rabbit 548,790 B，加上正面图集重复下载 547,882 B。`TextureLoader.setCrossOrigin(undefined)` 对齐同源 CSS 头像的 no-cors 请求模式，原始图像、分辨率和模型均未变化。2 人切换至 4 人的独立冷上下文测试只补下载 bear/rabbit；已载角色和 front-win 未重复请求。此结论只适用于当前同源部署；未来跨源 CDN 需要重新配置和验证。

详见 `atlas-transfer.json`，包含每次真实请求的 `sec-fetch-mode`、字节数，以及 img/CSS Resource Timing。角色选择的两项单元测试覆盖显式名单、去重、恢复的自定义角色、缺省/空名单、未知角色的 fox 回退。此次资源修改后已重新运行四项真实 WebKit 生命周期回归，结果仍写入 `compilation-lifecycle.json`。公网 2/4 人接入由主发布任务单独验证，此本地脚本不等同 iPhone 真机验收。

## 验证与复用

工作目录：`platform`。

```sh
node --test tests/run-presentation.test.mjs tests/run-static-batches.test.mjs tests/run-input-readiness.test.mjs tests/run-engine.test.mjs
node tests/run-readiness-ui.mjs
node arena/run/qa/compilation-lifecycle-review.mjs
node --test arena/run/qa/asset-selection.test.mjs
node arena/run/qa/atlas-transfer-review.mjs
node arena/run/qa/motion-v4-review.mjs
node arena/run/qa/performance-review.mjs next-chrome
RUN_PERF_BROWSER=webkit node arena/run/qa/performance-review.mjs next-webkit
```

`run-readiness-ui` 已通过冷资源输入拦截、真实 HTTP 跳跃、重复旧快照、1700 ms 主线程阻塞后的陈旧输入拦截、STALE_INPUT 恢复五项。它使用真实引擎但没有平台钱包、公网负载或手机 GPU。性能脚本仅使用明确标注的固定空路径快照，不能据此主张权威玩法或生产验收通过。
