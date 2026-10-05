# Run v2 内容与资源归属验证

2026-09-28；本机工程验证。没有部署、钱包写入或真实 iPhone 性能结论。

六条路线使用同一物理/美术资产，由不同手工 60m 赛段组合而成。三档的障碍/缺口事件数为 19–21 / 23–24 / 30，变化包含局部跑道缺口换道、全宽水沟跳跃、低箱/横梁交替；镜像归一签名全部不同。所有关卡都由一份持久化定义驱动引擎和场景。

| 路线 | 节奏 | 不用道具合法操作数 | 17ms控制轨迹 | 250ms真实worker轨迹 |
| --- | --- | --- | --- | --- |
| palm-weave | 1 | 20 | 60s / 0撞击 | 60.97s / 2撞击 |
| sunrise-arches | 1 | 18 | 60s / 0撞击 | 61.92s / 3撞击 |
| canal-crossing | 2 | 30 | 60s / 0撞击 | 60.97s / 2撞击 |
| red-beam-rhythm | 2 | 24 | 60s / 0撞击 | 65.67s / 8撞击 |
| rapid-bridges | 3 | 33 | 60s / 0撞击 | 63.48s / 5撞击 |
| oasis-switchbacks | 3 | 37 | 60s / 0撞击 | 60.97s / 2撞击 |

每条另有正常使用道具的零撞击轨迹，finishTick=3564；无操作对照全部在100秒未完成，35–49次撞击/落水。250ms worker测试覆盖每条2/3/4人，同场完成tick一致，所有动作经过正常act，没有直接改玩家位置。机器人能完成不代表人类难度已验证；250ms机器人会撞击，不能当作无损专家策略。原始动作时间和结果在 `engine-traces.json`。

兼容：旧 waiting/funding房显式传 v1创建时状态逐字段不变；旧pending输入、机器人、恢复pause、view、rank、forfeit与完整保留的v1引擎逐字段对比。新旧版本白名单严格，未知版本拒绝。v2中断JSON恢复和不同tick批次保持轨迹一致。

UI：`ui.json`含Chrome可信原生touch tap与桌面WebKit可信pointer，每种6条路线，共12样本；每次真实HTTP跳跃恰好1请求，路线/节奏HUD实际可见，画面courseId匹配权威定义，零页面错误。截图已检查。WebKit不是iPhone真机。此前夹具跨本地origin导航的fetch取消异常保留在`ui-first-navigation-failure.json`；夹具轮询补取消处理后重跑通过。修正过程中也发现原CSS隐藏course-label，最终信息放入顶部可见HUD，不以隐藏DOM文本作为UI通过证据。

资源：每场克隆并复用geometry/material/texture，缓存源仅提供CPU对象；默认Sprite的全局geometry也改为每角色所有。退出先dispose场景对象，再renderer.dispose与公开forceContextLoss。`lifecycle-webkit.json`是10次真实WebGL重挂载：每次退出RAF、ResizeObserver、worker、canvas、liveContext归0，30个缓存源对象dispose listener均0。Vite自身1个interval是进入前基线，10次后仍1；不是遗留游戏计时器。每个退役context实测lost；记录了未显式delete的默认handle（Buffer1/Texture4/Framebuffer3/Shader4），未伪称每个对象都显式释放。

这只是场景资源账本，没有强制GC堆趋势数据，也没有全React页面、15分钟真机、五名非开发试玩者或100并发容量验收；对应标准项保持unmeasured/insufficient。本次未做满足60秒口径的帧间隔验收，不能宣布FRAME通过。

可重跑命令（platform目录，浏览器与其他性能采样串行）：

```sh
node --test tests/run-engine.test.mjs tests/run-content.test.mjs tests/run-scene-resources.test.mjs tests/run-static-batches.test.mjs tests/run-presentation.test.mjs tests/run-input-readiness.test.mjs tests/mobile-swipe.test.mjs
node arena/run/qa/content-evidence.mjs
CONTENT_UI_GAME=run node tests/mobile-content-ui.mjs
node tests/run-lifecycle-ui.mjs
```

所有本轮本地浏览器与服务已关闭，脚本finally执行清理。当前版本源码清单见`source-sha256.txt`。

最终手势回归 `node tests/mobile-swipe-ui.mjs`：Match Chrome 10项 / WebKit 8项，Run Chrome 11项 / WebKit 9项全部通过，零页面错误；包含可信方向滑动、双指/取消/失capture/加载和状态失效门控，报告位于相邻`../touch-20260928/report.json`。Run旧触控夹具286m在新路线临近横梁，首次因此被正确BUSY门控；夹具改为安全起跑直道后重跑通过，未放松产品门控。

最终展示计时器使用共享 `startVisibleInterval`（仍为 70ms）：后台不运行展示 interval，恢复前台立即用实际 clock 刷新；权威规则时间继续。修改后 `node tests/mobile-content-ui.mjs` 重跑 Run 12 / Match 24 样本全部通过，errors 为 []。共享 helper 的隐藏/恢复/cleanup 两项定向测试通过。
