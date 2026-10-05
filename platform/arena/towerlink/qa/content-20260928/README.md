# Tower Link v2.2 内容验收

规则与兼容说明见 [audit.md](./audit.md)。新增 3 种真实道路结构，6 张竞技地图；12 训练关保持原结构和版本。

可复现命令（工作目录 platform）：

```sh
node --test tests/towerlink.engine.test.mjs tests/towerlink.training.test.mjs tests/towerlink.multiroute.test.mjs tests/towerlink.layout.test.mjs tests/towerlink.content.test.mjs tests/towerlink.presentation.test.mjs tests/visible-interval.test.mjs
node arena/towerlink/qa/content-evidence.mjs
node tests/towerlink-content-ui.mjs
```

- `tests.tap`：旧 2.1 核心规则与多路出兵回归、当前 12 训练关成功/失败轨迹、当前全图布局和呈现时钟；新内容 8 项定向验证包括版本恢复和对称公平。
- `engine-traces.json`：六图真实 250ms 引擎回放，每次动作走正常 act，包含完整动作/时间。六图都完成，16–100 次受理指令、4–17 次占领、6–17 次升级。四人图有 122.375/138.375 秒全占；其余到时结算。额外两条桥头突破见证证明集结补给可打破标准机器人僵局。普通 bot 的 ID 决策偏好不被当成公平证据；公平由道路/权重/出生点旋转与同旋转指令同结果验证。
- `ui.json`：最终浏览器结果以该文件的 `passed/errors/cases/serviceClosed` 为准。隔离本地 HTTP fixture 接真实权威引擎，不连接钱包；Chrome 为真实触摸输入，桌面 WebKit 为可信 pointer。每图建立/撤销同一条路线各一次，核对权威 orders，并测量 48×52px 独立塔目标、控制按钮和页面边界。
- 展示 100ms timer 改为共享 `startVisibleInterval`：页面隐藏时停止，返回前台按实际服务器时钟立即刷新；模拟、网络和规则时钟不暂停。Run 70ms / Match 80ms 使用同一策略。

浏览器 fixture 最终会关闭浏览器及本次服务。该批不包含物理 iPhone、公网新版本、60 秒帧时序、内存堆 GC 或五局人类平衡验收，不据此宣布整体上线准入通过。

最终结果：142 / 142 定向检查通过；12 / 12 浏览器场景通过，`errors: []`、`serviceClosed: true`。截图实际目检双向桥头/四方补给网：道路随拓扑改变，页眉显示当前地图，没有覆盖棋盘。
