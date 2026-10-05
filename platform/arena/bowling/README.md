# NEON BOWL — Phase E 本地实现

独立的 2 / 3 / 4 人三局保龄球。每人自己的球道同时准备、投球和计分；全部球道采用同版本初始十瓶布局。Blender 资产与实时 Three.js 场景参考已确认的 07-bowling 概念图，包含球的旋转、瓶身刚体姿态、跟球镜头、碰撞粒子、全中 / 补中演出和手机 HUD。场景是真实 WebGL 渲染，不使用概念图充当可玩画面。

## 当前美术版本

[2026-09-20 场馆纵深与柔光第三轮](ART-VENUE-V3-2026-09-20.md) 是当前版本，包含 360 / 390 / 430 修改前后、Metal 真实投球录像与剩余原稿差距。原生 Blender 场馆已重建；[上一轮完整美术与交互交付](ART-RESTORATION-2026-09-20.md) 保留为历史记录。当前交互与物理已更新为 [v1.1 技巧校准](qa/skill-20260928/README.md)：方向、力度与旋转常驻，投球按钮保留，点球道选站位，滑动时实时预览球路。逐局成绩可展开。

## 接入契约

默认组件 `BowlingGame({room, me, onAction, audio, onExit, locale='zh'})`。`room.status` 为公共外壳状态，`room.game` 为该玩家的引擎 view，`me` 为 external_user_id。`onAction` 返回 `Promise<{room,event}>`；动作没有钱包或分数字段：

```js
{ type: 'roll', offset: 0, angle: 0, power: 0.78, spin: 0 }
// offset ∈ [-0.85,0.85]，angle ∈ [-0.20,0.20] 弧度
// power ∈ [0.25,1]，spin ∈ [-1,1]
```

玩家可调站位、旋转和力度后点击投球，或在场景向前拖拽投球；划动距离映射力度、横向偏移映射角度。按钮与拖拽都提交相同的受限物理输入。客户端不能提交分数、倒瓶数、落点或轨迹。

引擎导出 `RULE_VERSION, createState, act, tick, forfeit, shiftTime, rank, view, botAction`。状态原地更新；`status` 为 `active / finished`，`phase` 为 `playing / fault / finished`，全部弃权产生 `outcome:'void'`。`botAction` 仅生成普通合法投球输入，是否允许 BOT 由房间服务决定。

`view.me` 包含本人完整回放，`view.players` 只带公开计分、完成与准备时间等轻量字段，不重复传其他人的轨迹。轨迹格式为 `{t,b:[x,y,z,qx,qy,qz,qw],p:[[id,x,y,z,qx,qy,qz,qw],...]}`；首帧包含全部剩余瓶，后续只传改变的瓶姿态。服务端 20 Hz 采样，前端插值。`scene.mjs` 仅导入几何常量，不把服务端 Cannon 模拟打进游戏 UI 包。

## 规则与完成资格

- 共三局，非最后一局全中最多一投，否则两投；第三局全中有两次补投，补中有一次补投。`X X X X X = 90`；`9/ 5- 8- = 28`；第三局 `X,7,3 = 20`，没有第四次补投。全局最多七次投球。
- 每次准备 20 秒，单次球体模拟最多 15 秒；比赛总时限 180 秒。总时限前已受理的球先完成物理结果，剩余未投机会补零。
- 准备超时消耗一次零分投球并保留该次未倒瓶；连续第三次准备超时弃权。第三次超时即使刚好填完最后一局，也不能获得有效完成资格。有效投球会重置连续超时计数。
- 已经合法完成的成绩保留，之后的断线不撤销成绩；未完成者批量弃权时，先处理同一时刻全部资格变更，再决定胜负。完全同分并列第一，没有额外付费决胜。
- 加分依赖未来投球的全中 / 补中保持待确认状态，HUD 的星号和计分格不会提前伪造最终总分。

## 物理与资源

权威物理为固定 60 Hz Cannon ES 刚体；倒瓶依据最终瓶姿态与瓶区边界，重返有效区域并恢复直立的瓶不算倒。进入沟槽后球不能再次击瓶得分。十瓶采用 1 + 2 + 3 + 4 三角阵；瓶身使用四段简化碰撞体，显示使用独立连续旋转体模型。

休眠除速度阈值外，还检查连续 600 毫秒姿态稳定：直立瓶位移低于 3 毫米、转动约 1 度；已倒瓶位移低于 12 毫米、转动约 3.7 度。新的实体撞击会清空该瓶稳定历史并唤醒它。该条件用于消除静止接触的求解器微抖动，不按目标分数或客户端动画强行判定结束；超出 15 秒且仍不稳定会返回 `PHYSICS_TIMEOUT`，交给公共故障恢复流程。

依赖统一从 `platform/package.json` 安装，包括固定 `cannon-es@0.20.0`。没有额外 bowling 子包。当前显示模型由实际运行的 Blender 脚本制作，球道纹理和实时灯光由代码生成；球体树脂及墙面美术为本项目 imagegen 原创素材，使用既有平台字体与音效接口；`audio.play` 调用 `shot / hit / bounce / win / click`。真实音频输出和宿主静音、钱包、会话握手由公共外壳负责。

## 验证与边界

在 `platform/` 下运行：

```sh
node --test tests/bowling-engine.test.mjs tests/bowling-skill.test.mjs
node tests/bowling-physics-matrix.mjs
node tests/bowling-ui.mjs
BOWLING_BROWSER=webkit node tests/bowling-ui.mjs
node arena/bowling/qa/skill-20260928/scan.mjs
```

- [规则 TAP](rules-validation.tap)
- [物理输入矩阵](review/physics-matrix.json)
- [UI 自动验证](review/ui-validation.json)
- [可视检查与验证说明](review/QA.md)

UI 验证创建独立临时 HTTP 服务和 esbuild 包，真实执行 Chrome 移动视口指针手势、WebGL 回放与本地权威引擎请求；不占用 8795 / 8797 / 8798，不写钱包。稳定选择器：`bowling-scene`、`bowling-canvas`、`bowling-roll`、`bowling-aim`、`bowling-angle`、`bowling-spin`、`bowling-power`。

当前证据是 macOS 桌面 Chrome 的 390 / 360 × 844 移动视口模拟，不是 Android / iOS 真机 WebView、跨区弱网、GPU 压力或生产验收。物理是固定参数的游戏近似模型，不代表经认证的专业保龄球仿真；主菜单中文完整，英文 HUD 可用，阿拉伯语目前只有方向支持，完整本地化尚需验收。生产多房间并发还需将同步物理计算移至受控工作池并测量尾延迟。

## 2026-09-19 visual restoration

See [RESTORATION.md](RESTORATION.md) for the updated real geometry, camera, materials, exact local evidence and remaining reference gaps. Rules and authoritative physics were preserved.
