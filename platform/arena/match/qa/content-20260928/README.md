# Match v2 目标与手机UI验证

2026-09-28，本地真实权威引擎和HTTP。没有部署或钱包写入。

三目标已实现并影响决策和排名：积分、指定色收集、旧特殊宝石实际触发。各目标固定seed、只用合法act从正常初盘完成90秒：12300分 / 148颗目标色 / 37次特殊触发，分别109 / 103 / 103次交换。两位玩家相同行动得到逐项相同棋盘、补充计数和目标进度；JSON恢复可重放。完整轨迹见`engine-traces.json`，这是自动基准策略，不是人类可玩性或手机速度测量。

定向测试还覆盖：同一棋盘在不同目标下选到不同交换；不同目标产生不同名次；同目标值以原积分决胜、同值同分并列；颜色只计被消除的原宝石、特殊创建不算触发；无效交换和洗牌不加进度；三目标均无步重排恢复；截止前受理的连锁继续结清；私密seed/refill不出视图。旧v1创建、45步中盘RNG/事件、暂停、结束与排名逐字段等同保留引擎。

`ui.json`包含24个样本：三目标×360×800、390×844、393×852、430×932×Chrome/WebKit。Chrome为可信原生touch tap，WebKit为桌面可信pointer，不是iPhone。每样本完成真实HTTP合法交换恰好1次，目标进度与权威响应相符；目标不挡棋盘，棋盘全屏可见，无水平溢出，辅助按钮至少44px，最终零页面错误。截图已检查：修复了目标条加入后吉祥物transform丢失居中导致挡对手成绩的问题。

保留`ui-first-navigation-failure.json`记录早次夹具跨本地origin导航取消fetch时未捕获的异常；夹具补退出时网络取消处理后最终完整重跑通过。它不是旧生产服务故障证据。

可重跑命令：

```sh
node --test tests/match-engine.test.mjs tests/match-content.test.mjs tests/mobile-swipe.test.mjs
node arena/run/qa/content-evidence.mjs
CONTENT_UI_GAME=match node tests/mobile-content-ui.mjs
```

初盘仍是6×6五色，特殊宝石和连锁规则/素材质量保留。目标里程碑达成后继续累计到90秒，不能将勾号理解成已获胜；最终名次依目标值与明示积分决胜。服务端集成负责新房v2、旧房v1的版本选择和终局显示。

本轮全量UI浏览器和本地服务均已关闭。尚无15分钟真机、五名非开发试玩者、60秒帧统计或服务容量结论；整体mobile-release-pass未满足。当前源码清单见`source-sha256.txt`。

最终手势回归 `node tests/mobile-swipe-ui.mjs`：Match Chrome 10项 / WebKit 8项，Run Chrome 11项 / WebKit 9项全部通过，零页面错误；包含可信方向滑动、双指/取消/失capture/加载和状态失效门控，报告位于相邻`../touch-20260928/report.json`。Run旧触控夹具286m在新路线临近横梁，首次因此被正确BUSY门控；夹具改为安全起跑直道后重跑通过，未放松产品门控。

最终展示计时器使用共享 `startVisibleInterval`（仍为 80ms）：后台不运行展示 interval，恢复前台立即用实际 clock 刷新；权威规则时间继续。修改后 `node tests/mobile-content-ui.mjs` 重跑 Run 12 / Match 24 样本全部通过，errors 为 []。共享 helper 的隐藏/恢复/cleanup 两项定向测试通过。

图片准备统一使用共享 `preloadImages`，超时覆盖 fetch 与 decode。最终头像预载 URL 与 shared CSS 对齐为 `player-portraits-v2-mobile-e193e8ea76.webp`；头像最后路径变更在上述 UI 回归之后，最终生产网络检查由根代理统一执行。
