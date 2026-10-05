# 保龄球 v1.1 技巧校准（2026-09-28）

本次修复“默认投球一直全中”，不是给投球加随机失败概率。服务端仍用同一输入复现同一刚体轨迹与倒瓶结果。未修改三局计分、奖励、钱包或其他游戏。

## 根因与校准

原默认按钮、默认 BOT 都使用 offset=0 / angle=0 / power=.78 / spin=0，固定得到10瓶。原物理回归甚至把该结果写成了必须通过的“中心全中”。全角度必中并不成立：大角度本来就会落沟，偏角也会留瓶。问题是默认值配合过密瓶阵制造了零瞄准全中。

旧瓶心距 .37、行距 .325，瓶高 .803、球半径 .215。参考 [USBC 2026 Equipment Specifications](https://images.bowl.com/bowl/media/assets/usbc/equipment%20specs/26_231-26-march-es-manual.pdf) 第38页对等边三角瓶阵与12英寸瓶心距的定义检查比例；本游戏保留短球道与简化碰撞体，**不是认证的真实保龄球仿真**。把标准比例照搬到简化模型并不保证合理玩法。

对多组间距、球尺寸与阻尼做参数比较后，最终采用瓶心距 .55、等边行距 .55×√3/2、球半径 .23、瓶线性/角阻尼 .20/.50。显示瓶阵和球尺寸同步使用这组参数。没有投后改判、瞄准吸附或隐藏随机惩罚。

| 同一可提交输入 | v1 结果 | v1.1 结果 |
|---|---:|---:|
| 默认正中 .78 力度 | 10瓶 | 8瓶，留4/7号瓶 |
| 正中 .6 力度 | 10瓶 | 7瓶 |
| 正中最大力度 | 10瓶 | 8瓶 |
| 左口袋 offset=-.20 / power=1 | 参数扫描记录 | 10瓶 |
| 右口袋 offset=.24 / power=1 | 参数扫描记录 | 10瓶 |
| angle=±.20 | 0瓶落沟 | 0瓶落沟 |

正中心14档力度均为6–9瓶，正确口袋有全中，周边输入有不同留瓶组合。求解器的碰撞迭代顺序存在左右数值差，不能承诺正负镜像输入逐瓶完全相同；两侧均有可学习的全中输入。BOT 仍提交普通瞄准动作，完整三局实测54分（8/、8/、8/8），不再默认90分。

密集口袋扫描额外发现3次超过原10秒上限的自然瓶运动；它们分别在10.867、11.767、13.050秒完全静止。物理上限延长至15秒，原睡眠判据不放宽，常规投球仍提前结束。默认投球约6.117秒，触控大角度落沟约2.3秒。超出15秒仍不稳定继续返回故障，不能跳过物理稳定直接判分。

## 交互

- 保留辅助投球按钮；方向和力度常驻可见，旋转控制保留。
- 点球道确定出手站位，向前滑动直接投球；斜向改变角度，滑动距离改变力度。
- pointermove 与 pointerup 使用同一个手势计算函数，预览与提交一致；以 .01 站位/.001弧度/.01力度量化，避免指针浮点噪声。
- 防止同一渲染间隙重复提交；取消触控不会出球。

## 版本与旧状态

- RULE_VERSION：`pvp-bowling-v1.1.0`
- PHYSICS_VERSION：`bowling-rigid-v1.1.0`
- LEVEL_VERSION：`neon-lane-v1.1`

激活必须先排空所有旧 waiting / funding / active 等非终态房间。旧版本状态不能接受新版本 `act`（`PINNED_RULE_UNAVAILABLE`）。已经受理的 `trajectory` 和 `pending` 不重算；恢复/tick 按已记录结果揭示，回归测试验证了旧10瓶结果仍按10瓶揭示。没有把旧房悄悄转换成新物理。

共享目录、游戏目录版本与规则册由主任务整合。本改动不修改结算规则。

## 证据与复现

- `parameter-matrix.json`：最终311例扫描，含完整旧/新参数、倒瓶、剩余瓶、落沟、结算状态和耗时；包括100例固定种子的广域/剩余瓶组合与100例密集左右口袋组合。固定随机种子仅用于生成测试输入，不在游戏模拟中注入随机数。
- `physics-matrix-summary.json` 与 `../../review/physics-matrix.json`：原106项边界/参数矩阵。
- `rules.tap`：25项计分、确定性、剩余瓶、输入、旧状态和迟滞运动回归。
- `touch-ui.json`：Chrome Metal 390×844，真实CDP touchStart/move/end、原生触屏点击、实际HTTP权威引擎；默认按钮8瓶、直线滑动8瓶、斜投0瓶落沟、左右口袋各10瓶。每个场景有截图和WebM录像。
- `webkit/touch-ui.json`：Playwright WebKit 真触屏tap，默认按钮与左右口袋的真实HTTP引擎验证。它是 macOS WebKit，不是 iPhone 15 Pro 真机。
- `calibration-*.json`、`candidate-matrix.json` 与 `pocket-and-bot-10s.json` 是中间调参证据，不能当最终验收；保留其失败项。

在 platform 目录运行：

```sh
node --test tests/bowling-engine.test.mjs tests/bowling-skill.test.mjs
node tests/bowling-physics-matrix.mjs
node arena/bowling/qa/skill-20260928/scan.mjs
node tests/bowling-ui.mjs
BOWLING_BROWSER=webkit node tests/bowling-ui.mjs
```

本地HTTP浏览器验证没有访问钱包、不创建公网房间。并未完成 iPhone 真机、弱网、多人公网容量验收。
