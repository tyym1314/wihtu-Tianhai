# 阶段 E · 八球、保龄球与沙丘竞速

本批已完成本地规则、手机尺寸浏览器和平台联调验证，证据见[阶段 E 交付记录](phase-e-delivery.md)。已有九款游戏保持原入口，新增 `pool`、`bowling`、`run` 后共十二款。生产部署、真实设备表现与独立合作方自接入尚未验收。

## 目录与入场

| game_id | 游戏 | 人数 | 本局规则 |
|---|---|---|---|
| pool | 八球对决 | 2 | 单盘；20 秒出杆；10 分钟 / 100 杆上限 |
| bowling | 保龄球对决 | 2 / 3 / 4 | 独立球道，3 个计分局，含末局补投；180 秒 |
| run | 沙丘竞速 | 2 / 3 / 4 | 同能力角色、三跑道、480 米；100 秒上限 |

三款均为个人赛，沿用创建房间时冻结的 App 服务费与冠军 / 并列冠军分奖模板。免费练习明确标记 BOT、零入场、零费用，不写入付费钱包；有奖房间只有真实参与用户。

同一 App 的不同用户可通过房间码加入；全员准备后先批量确认钱包捕获，再开始比赛。不要用同一用户重复开的窗口当作两名参赛者。原管理员、应用设置、密钥、余额、会话和局单继续保留。

阶段 E 只把恰好保持旧九款默认授权的 App 一次性扩展为十二款；自定义授权不会变更。新建 App 从共享游戏注册表写入完整默认授权，不依赖过期的数据库默认值。入口仍以签名 `GET /v1/games` 返回的 `available` 与 `modes` 为准。

## 合作方启动

身份、HMAC、一次性启动码与钱包协议沿用[通用指南](integration-guide.md)、[阶段 D 同源 Web 握手](phase-d-local-integration.md#同源-web-启动握手)。合作方在后端使用[Node 客户端](examples/sdk-node.mjs)创建会话：

```js
const launch = await client.createSession({
  requestId: persistedRequestId,
  externalUserId: authenticatedUser.id,
  gameId: 'bowling', // pool / bowling / run
  locale: 'zh',
  hostPlatform: 'web'
});
```

将阶段 D 宿主示例的 `games` 白名单扩展加入 `pool`、`bowling`、`run`，或由自有后端返回该 App 已授权且可用的游戏列表。仅允许返回入口的同源 `/play/{gameId}`，校验消息 `origin`、`source`、`game_id`。顺序为 `oasis.ready → oasis.launch{launch_code} → oasis.loaded / oasis.error`；密钥留在后端，启动码和 Bearer 不进入 URL。

`loaded` 表示身份兑换与上下文载入完成；美术场景按需加载，开始入场前仍须等待实际游戏就绪。原生 Android/iOS WebView 桥接、跨域宿主、外部钱包注册和独立合作方生产自接入属于后续交付，当前教程覆盖本机同源 Web 联调。

## 第一方游戏动作

合作方只负责授权入口与主钱包。以下是游戏页面使用的 Bearer 接口，合作方不提交分数、胜负或客户端物理结果：

`POST /api/pvp/rooms/{id}/action`，正文 `{request_id,seq,action}`。未知结果保留原 request_id、seq、正文重试；不得因为超时另建投球、扣币或派奖。

| 游戏 | action | 权威计算 |
|---|---|---|
| pool | `{type:'place',x,y}`、`{type:'call',pocketId}`、`{type:'shot',angle,power,spinX,spinY}` | 合法自由球位置、第一碰撞、库边、入袋、分组、黑八与犯规 |
| bowling | `{type:'roll',offset,angle,power,spin}` | 球与十瓶刚体碰撞、落沟、稳定倒瓶、三局与补投计分 |
| run | `{type:'left'|'right'|'jump'|'slide'|'item',observed_tick?}` | 下一模拟步受理、固定步长位置、碰撞、掉落、道具与冲线 |

八球旋转参数范围 -1..1、力度 .02..1；合法放球或叫袋不重置出杆倒计时。开球入黑八回位；普通击打须在本组已清空时先叫袋，黑八与白球同入袋判负。详细规则见[规则册](game-rules-v1.md#8-八球-pool)。

保龄球 offset 为 -.85...85、angle 为 -.20...20 弧度、power 为 .25..1、spin 为 -1..1。每次已受理投球必须等物理结果；3 个计分局最多 90 分，未知补分显示待定。第三局全中或补中按固定规则补投，不能无限补投。已完成成绩不会因后来断线而失效。

竞速动作不接收客户端位置、速度、得分或时间。`observed_tick` 只用于拒绝过旧输入，不能指定执行时刻或回溯。跳跃与 600 ms 滑铲互斥，横梁可滑过或变道绕开。护盾与加速来自固定赛道，各玩家单独记录领取；掉落重生不重复领取。相同服务端步冲线者并列，结束时净距离按厘米比较，画面以米显示。

## 同步、演出与恢复

- 八球完整轨迹采用稀疏变化帧；保龄球只给本人投球轨迹，对手展示公开进度与分数。客户端插值呈现，服务端负责碰撞与计分。
- 保龄球本地 V1 使用 60 Hz 固定步进。当前刚体求解仍同步占用服务端事件循环；本轮本机样本求解 CPU 用时 P95 为 281 ms、最大 513 ms，属于有限样本观察，不是生产延迟承诺。生产 worker pool、队列隔离及并发压测尚待实施，不能把竞速 150 ms 轮询间隔理解为请求响应延迟保证。
- 竞速服务端以 60 Hz 固定模拟步推进，活动房间串行 HTTP 轮询间隔 150 ms；动作通过同一个有序请求通道提交。画面插值与有限外推不改变服务端结果。当前尚未提供生产实时网关或跨区域延迟保障。
- 页面隐藏时关闭声音并停止新增交互；断线 30 秒按规则处理。多人在同一服务器时点触发的弃权先批量裁决，已完成的有效成绩保留。
- BOT 决策前先推进到当前服务端时刻，防止在过期回合发动作并把自然结束误判为故障。
- 服务短暂中断按既有规则平移游戏时钟；超过 60 秒作废退款。规则/数学版本已固定的局不会在中途改版，结果未知继续查原钱包操作。

## 本地运行与验证

```sh
cd platform
npm ci
npm run db:start
npm run build:arena
npm run build
npm run server
# 另一个终端
npm run dev
```

`cannon-es` 固定版本随根 `npm ci` 安装，保龄球不用另外安装子目录依赖。管理台 8795、API 8797、参考钱包 8798、PostgreSQL 5487；原两款独立演示仍为 8787 / 8790。

验证命令 `npm run test:backend`、`npm run check:contracts`、`node scripts/review-phase-e-ui.mjs`。平台/PvP 测试使用独立临时 PostgreSQL 数据库；钱包单项测试使用随机 partner/scope，默认留在开发数据库。

运行 UI 脚本前，先用 `.local/development-credentials.json` 中的管理员凭证进入管理台，在应用管理中准备唯一一个名为 **QA UI** 的专用沙箱 App。已有该 App 时复用它，不重复创建。确保 App 为启用状态，并授权全部十二款游戏；旧默认九款授权在阶段 E API 首次启动迁移后扩展为十二款，自定义授权需由管理员逐项确认。新建本地 App 会配置参考钱包和 `demo_player`、`demo_player_2`、`demo_player_3`、`demo_player_4` 四个测试用户；运行前确保这些用户有足够测试币、没有遗留活动房间。仅连接本机参考钱包和测试余额，不使用业务合作方 App 或真实用户资金。脚本会实际创建有奖房、扣除测试入场币并结算测试奖金与服务费，不是只读检查。

UI 脚本不要求把 App 服务费改回 5%。每个有奖房在开局后记录冻结的 `entry_minor`、`capacity`、`fee_bps`，按整数最小单位计算奖池与费用，并检查“所有派奖之和 + 服务费 = 捕获奖池”。竞速免费练习与有奖房均要求左移、右移、跳跃、滑铲四种动作出现对应的服务端输入事件，且后续 `appliedInputNo` 达到该动作序号；不会仅凭 HTTP 200 或瞬时跳跃画面判定通过。证据写入 `review/phase-e/ui-validation.json`（筛选运行写入 `ui-validation-partial.json`）。手机尺寸浏览器检查不替代真机 WebView 或生产验收。
