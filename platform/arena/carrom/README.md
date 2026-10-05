# Oasis Carrom — 翡翠会客厅

本目录是完整可玩的 Carrom 首个质量样板。视觉参考已检查的 `output/design/pvp-arena-concepts-v1/01-carrom.png`：翡翠宫廷、胡桃木边框、金色细嵌、浅木台面、金边头像与力度控制。棋盘、棋子、瞄准线、碰撞和入袋粒子全部实时绘制，环境图不包含棋盘或 UI。

## 入口与接口

`CarromGame.jsx` 默认导出 `CarromGame({room,me,onAction,audio,onExit,locale='zh'})`。完整手机界面由组件绘制，父层负责邀请、扣款、准备和最终结算。支持中文、英文、阿语 RTL。`room.game` 为 engine `view`，`room.server_now` 提供时钟校准，`me` 为当前 external_user_id。稳定选择器为 `carrom-board`、`carrom-shoot`。返回、静音、置位、力度、左右微调和玩法按钮均有可访问名称。

发送动作只包含：

```js
{ type: 'shot', offset: -1 /* 至 1 */, angle: -Math.PI /* 至 Math.PI */, power: .02 /* 至 1 */ }
```

`offset` 是本人基线横向位置；`angle=0` 朝本人面前的棋盘中心，正值向本人右侧。客户端不发送棋子位置、袋口、进球或分数。可触摸拖动金色击子置位、点击棋盘瞄准、在击子下方向后拉以蓄力，或使用位置/力度滑条和微调按钮；最后按出杆。UI 将本人一侧转到屏幕底部，服务端仍使用该人的冻结物理座位。

`engine.mjs` 导出 `RULE_VERSION`、`createState`、`act`、`tick`、`forfeit`、`shiftTime`、`rank`、`view`、`botAction`。函数原地修改并返回同一 `state`，所有权威状态可 JSON 持久化，无进程内缓存依赖。`simulateShot`、`resolveShot` 额外导出用于规则与物理测试，不是网络 API。

- `createState(seedHex,now,{players})`：2 或 4 名唯一 key，连续 seatIndex，64 位十六进制种子。每名玩家可有冻结 `teamId`。规则固定 10 分钟；通用房间传来的其他游戏 `durationMs` 不改变本版本时限。
- `act(state,key,action,now)`：拒绝越界、NaN、多余字段、不清空的基线位置、非当前玩家、未静止等。无效输入不消耗杆数。通过验证后计算完整轨迹，保存 `pending`，设置真实 `busyUntil`。
- `tick(state,now)`：先等球盘物理静止，再裁决得分/犯规/换杆；迟到的 tick 依时间顺序补处理过期回合，不会用 10 分钟结束绕过早先已成立的弃权。
- `forfeit(state,keys,now)`：同一时点的断线/退出批量处理，一人退出使整队弃权，双方均弃权且没有已固定合法完赛则 `outcome='void'`。第三次超时与同 tick 的对方断线不会提前固定单方胜利。该时点已完成的合法清台不被后来退出撤销。
- `shiftTime(state,deltaMs)`：只平移绝对时间，不改相对轨迹。
- `view`：所有棋子和两队收子均为公开数据；包含 `shotId`、`shotStartedAt`、`trajectory`、`events`、`lastAction` 与全局最新 `lastEvent`，用于双方/BOT一致演出。
- `rank`：分数为本队收子数，附 `scoreLabel`。队伍成员同名次，胜队两名成员均 rank 1。引擎不分币、不计算平台费用。

## 本项目候选规则细则

候选规则版本 `pvp-carrom-v1.0.0`；几何 `oasis-carrom-wood-v1`；物理 `oasis-carrom-fixed240-v1`。以下是本项目明确选用的数字版解释，不冒称完整复现某一官方竞赛规则。

1. **座位和颜色。** 2 人席位 0/1 映射物理对座；4 人 0/2、1/3 对座。队伍依据开局冻结的 teamId，不能按后来座位重算队友；root 在扣款前只在对座约束内随机座位。偶数席位白子、奇数席位黑子。0 号先开杆，未续杆时沿物理顺时针顺序轮转。
2. **皇后资格。** 本队必须在此杆之前已有至少一次“合法收取且未被当杆退回”的己方子经历。首枚己方子与皇后同杆入袋不追溯产生资格。此历史资格在后续罚退旧子后保留。偿还罚退债而立即退回的子不建立资格。
3. **覆盖顺序。** 有资格收皇后，同杆至少一枚己方子经罚退债处理后实际留存，即覆盖成功；否则皇后进入 pending，射手获得下一杆。下一杆有实际留存己方子则覆盖，否则（含只进对手子、超时、犯规）皇后退回。偿债退回的子不能覆盖皇后。
4. **最后一子与清台。** 尚无任何一方覆盖皇后时，一队的第九枚己方子会退回，不得清台获胜。同杆覆盖皇后允许同时清台。皇后已由任何队覆盖后，一队收齐九子即可获胜。无犯规的同一杆双方同时九子，则双方共同第一，不用碰撞先后或用户 ID 决胜。
5. **对手子。** 入袋的对手颜色计给对手；仅进对手子不续杆。任何队的新入袋本色子都先偿该队已有罚退债，包含被对手打入的本色子。射手犯规不撤销对手本杆正常收子。
6. **犯规与罚退债。** 击子入袋/飞出、己方子飞出，或物理裁判标识的犯规，结束当前杆。退回本杆全部己方入袋子与本杆皇后（或正待覆盖皇后），再退回一枚该队此前收取的己方子；此前无子就记一笔罚退债。被罚旧子取该队已有收子序列最后一个，顺序被冻结。犯规杆不允许射手清台取胜；若对手因此合法收齐，仍可获胜。
7. **飞出和退子。** 对方子飞出只退回，不算射手犯规。皇后飞出退回且结束本杆，即使同时收己方子也不续杆。本平面物理正常不会生成飞出，但权威裁判保留明确分支和测试。退子搜索顺序为中心、由内到外同心圆上的顺时针点、由内到外顺时针方格环，避开棋子和袋口；所有退子在胜负判定前完成。无安全空位产生真实 fault，不随意放置或判玩家输。
8. **时间。** 每杆限 20 秒；输入非法不重置倒计时。合法出杆后计时暂停直到全部棋子静止，续杆/换人再给 20 秒。连续三次本人操作超时导致整队弃权；本人完成一次有效出杆重置本人连续次数。比赛 10 分钟或第 200 次有效出杆后，必须完成已受理物理演出，再按收子数、已覆盖皇后归属比较；仍相同为共同第一。不得截断在途球来决定输赢。
9. **方向。** 本项目不额外限制相对出杆角度；前后左右均可。棋子摆在正确基线上且不得重叠。错误输入属于拒绝受理，不伪造为已完成犯规杆。

## 物理与演出

共享几何位于 `geometry.mjs`，权威固定步长为 1/240 秒。棋子半径 .22，击子 .29；棋子质量 1、击子 1.5；最大初速 18；滑动减速度 2.4；棋子恢复系数 .91、边框 .8。服务器每杆最多模拟 12 秒，帧采样 30Hz。所有冲量与摩擦只损失能量；边框和碰撞不增加动能。12 秒是异常保护，不是动画强行停球点；无法可靠静止进入 `phase='fault'`，由房间共同故障协议处理。

初始种子只决定规范棋子排列的小角度旋转。实时射击没有命中率、中奖或派彩 RNG。服务器预计算轨迹并持续禁止在 `busyUntil` 前再次出杆；客户端更快播放不会加快真实回合。客户端 Canvas 按服务器时间插值，双方均播放同一棋子轨迹、碰撞高光、入袋金色粒子。棋盘木纹/雕金边框缓存为离屏静态层；实时棋子拥有阴影、金边与高光。灯光、辉光与环境浮尘持续轻动。

声音经父层 `audio.play(kind,strength)` 调用，覆盖 click、shot、hit、bounce、win；本目录不重复创建音频上下文。免费练习机器人仅根据公开棋盘几何选择合法方向/力度，不直接改位置或分数。付费房间禁止机器人由父层控制，本引擎不自动启动 BOT。

## 资源来源与交付

环境图使用 **builtin image_gen** 生成原创位图，不使用命令行图片生成或网页素材。原始产物：

`/Users/tyym/.codex/generated_images/01a0b48c-a11d-7cc0-8767-b1b8a14320e0/exec-0bd14328-ba40-42e4-9424-67fb01b1efda.png`

仓库原始保留 `assets/emerald-palace.png`（1024×1536，SHA-256 `ef28d8ae96f9858648dd1ff24fa1672f93dd3a62f2ce1f55e035f5ee87933e60`）。移动端 CSS 加载 `assets/emerald-palace.webp`，使用 `cwebp -q 82 -m 6` 仅做格式压缩，无缩放和美术修改，**227,192 bytes**，SHA-256 `96bb7104e7b616b3eba7e2f16051131011123ffa5a34b3c6c1c4dfe4ab8b1a2c`。棋盘、标线、几何花纹、棋子和头像是原创程序绘制。

原始生成提示词：

> Use case: stylized-concept. Asset type: portrait mobile game environmental background, no interface. Create a sumptuous Middle Eastern night palace lounge for an original premium Carrom tabletop game. Vertical 2:3 composition, emerald green silk upholstery, rich dark carved walnut wood, delicate gold geometric inlay, hanging glowing brass lanterns at upper left and right, subtle palm foliage on edges, a distant courtyard arch and moonlit turquoise domes in the upper 22 percent. Bottom 20 percent shows beautifully embroidered emerald velvet cushions and a woven gold-patterned carpet. The middle 55 percent must be mostly dark emerald low-contrast negative space, intended to be covered by a large real playable square board. Cinematic warm amber practical lighting, photorealistic 3D mobile-game render with painterly art direction, exceptionally fine materials, deep shadows, warm highlights, elegant luxurious atmosphere, composition symmetrical but organic. No people, no carrom board, no coins, no chess pieces, no game HUD, no buttons, no text, no logos, no watermark. This is only scenery behind a separately rendered live board. High polish, crisp texture, restrained emerald/teal/gold palette.

## 验证记录

`node --test platform/tests/carrom-engine.test.mjs`：**23/23 通过**。包括实际物理开球、角袋入袋/击子犯规、序列化重放、所有席位物理基线、非法输入不计杆、完整皇后顺序、最后子、债务、双方同杆清台、组队弃权、同 tick 超时与全退、10 分钟补处理、时钟平移、合法 BOT 实打至完整终局。

独立视觉验证：启动 `platform/node_modules/.bin/vite --config platform/arena/carrom/preview.config.mjs`，再运行 `node platform/tests/carrom-ui-qa.mjs`。专用端口 18107，独立 `.vite-carrom-review` 缓存，不使用平台 8795。`preview.*` 只用于零价值 QA，平台生产入口不导入它。

当前 `qa/browser-report.json` 和截图证明桌面 Chrome 手机仿真中的三组状态：中文 390×844、英文 360×800、阿语四人 390×844。三者均无横向/纵向溢出，棋盘宽 382/352/382px，主按钮完整可见；通过触摸瞄准与滑条后实际出杆，等待物理静止并观察到 BOT 下一杆；无 pageerror。另测四人 seat 1：拖击子到 offset≈.504、server lastAction.seatIndex=1、规则弹窗、静音状态与返回回调成功；截图 `qa/en-team-seat1-motion.png`。

这些证据是桌面浏览器的移动尺寸与操作验证，不是真实 iOS/Android/WebView 的触控、帧率、发热和耳听混音验收。真实付费钱包、多人 App 接入与平台结果页由根集成测试另行报告。

## 2026-09-19 视觉恢复 v2

依据 `01-carrom.png` 的 PLAY/MOMENT 重新压紧赛事 HUD：头像、收子数、九枚进度与回合钟合在一行，棋盘完整占据主要宽度，置位和力度在同一控制带；入场金额也使用最小单位 /100 显示。头像复用共享原创人物肖像，合作方头像可由 `PlayerPortrait` 覆盖。

棋盘仍是逐帧 Canvas：四边独立方向的胡桃木纹、暗缝与内框接触阴影缓存为静态底层；每颗棋子增加厚度侧壁、贴地软硬两层阴影、同心车削纹与雕刻击子。动态拖尾只读取服务器已经提交的轨迹；原碰撞、入袋粒子和退子裁决没有改写。保留既有宫殿原创背景，没有用概念图代替棋盘。

本轮脚本 `qa/visual-restoration.mjs`（需启动三个目录的独立 Vite preview）验证三个游戏；Carrom 390×844 / 360×800 均无横向或纵向溢出、无 pageerror，实际触摸瞄准、置位 .4、力度 .85，真实引擎产生 128 帧轨迹和 4 个碰撞事件。证据在 `review-v2/ui-validation.json`、`carrom-{390,360}-{before,motion}.png`。`qa/money-display.mjs` 对真实 JSX SSR 验证 38000→380、10000→100，且输入 room 不变。三款规则测试共 60 项通过。

本轮没有修改 engine/physics/geometry 或钱包。共用结果页由平台负责；本模块报告不等同于逐像素还原、真实移动设备性能或最终美术验收。

## Fixed-view restoration V3

See [RESTORATION-V3.md](RESTORATION-V3.md) for independent asset layers, exact geometry boundaries, original source/prompts, screenshots and actual local-engine UI validation.

## Controls restoration V4

See [RESTORATION-V4.md](RESTORATION-V4.md) for the emerald AIM rail, carved striker control, three-width real pocket verification and before/after video evidence. The latest scoped regression command is `node platform/arena/carrom/qa/visual-v4.mjs` with the two isolated Carrom/Darts previews running.
