# 阶段 C · 本地多人竞技接入补充

**状态：本地参考实现，部分游戏可运行。** 本文补充并更新[阶段 B 本地教程](phase-b-local-integration.md)中涉及游戏目录、竞技房间和参考用户的部分；启动码、服务端鉴权、主钱包与概率周期规则仍承继阶段 B。完整目标协议见[接入教程](integration-guide.md)、[钱包协议](wallet-protocol.md)及 [OpenAPI](openapi.json)。

本次完整后端测试在主 API 继续运行时连续两轮 **81/81 通过**，报告见[第一轮](../review/phase-c/backend-isolated-run-1.tap)与[第二轮](../review/phase-c/backend-report.txt)。实际浏览器联调已完成，范围与截图见 [阶段 C 交付](phase-c-delivery.md)。生产部署、正式合作方自助上线、真实 Android/iOS WebView、跨区弱网与移动设备性能尚未验收。

## 1. 当前可启动范围

| 分类 | game_id | 当前本地入口与范围 |
|---|---|---|
| 概率 | `thunder` | `/play/thunder`，雷霆王座独立平台构建，延续阶段 B 钱包与完整付费周期 |
| 概率 | `tiger` | `/play/tiger`，虎虎生财独立平台构建，延续阶段 B 钱包与完整付费周期 |
| 竞技 | `match` | `/play/match`，90 秒宝石对决，2/3/4 人好友房、免费练习 |
| 竞技 | `golf` | `/play/golf`，三洞绿洲高尔夫，2/3/4 人好友房、免费练习 |

目录仍有 12 款游戏。其余 **8 款** `carrom`、`darts`、`ludo`、`pool`、`bowling`、`jackaroo`、`domino`、`run` 尚未完成为可启动游戏平台游戏。设计图、规则文件和跑酷技术灰盒不代表其已经完成或发布。目录授权也不会使未完成游戏变为可启动。

既有两款原演示保持独立，平台使用独立构建；原演示地址不是本平台 Bearer 会话入口。

## 2. 本机启动

在 `platform/` 目录执行：

```sh
npm ci
npm run db:start
npm run build:legacy
npm run build:arena
npm run server
```

保持服务终端运行，另开终端：

```sh
cd platform
npm run dev
```

| 本机服务 | 地址/端口 | 用途 |
|---|---|---|
| 平台管理台及宿主页面 | `http://127.0.0.1:8795` | 登录、App 配置、启动游戏；开发代理转发平台接口 |
| 平台 API | `http://127.0.0.1:8797` | HMAC 接入、会话、房间、服务端游戏状态 |
| 参考合作方钱包 | `http://127.0.0.1:8798` | 独立签名 HTTP 接口与原子账务 |
| 开发 PostgreSQL | `127.0.0.1:5487` | 本机隔离数据库，启动脚本和限制见阶段 B |

后台账号保存在 `.local/development-credentials.json`，凭据与 `.local/master.key` 不进入游戏页面。现有服务已运行时不要重复启动相同端口。修改竞技前端后重新执行 `npm run build:arena`；修改服务端后重启 `npm run server`。`npm run dev` 启动的是管理端开发服务，不代替竞技构建或 API 服务。

本地 API 与参考钱包由开发入口在一个 Node 进程内监听不同 HTTP 端口，模块和鉴权方向分开，但共享本机开发数据库。正式合作方钱包分库、TLS、身份和密钥管理属于后续部署工作，不能把这个参考拓扑视为生产接入。

本地开发文件边界已补齐：Vite 拒绝通过普通路径、`?raw` 和 `@fs` 读取 `.local` 凭据/主密钥及受保护服务端、测试目录；本次 6 条敏感路径检查均返回 403，文档与必要前端资源仍返回 200。见[本地文件边界验证](../review/phase-c/local-file-boundaries.json)。这项本地封堵不等同于生产安全验收。

## 3. 鉴权分工

| 调用者 | 接口 | 鉴权与范围 |
|---|---|---|
| 合作方后端 | `POST /v1/sessions` | HMAC；用户身份由合作方后端登录态取得，绑定 App、用户、游戏 |
| 合作方后端 | `GET /v1/games` | HMAC；只返回该 App 的目录和可用性 |
| 合作方后端 | `GET /v1/matches/{match_id}` | HMAC；查询该 App 的付费比赛状态、冻结条款、资金结果，不返回私有棋盘或种子 |
| 合作方后端 | `GET /v1/operations/{operation_id}` | HMAC；查询该 App 的持久化资金操作及回执 |
| 平台游戏页面 | `POST /v1/launch/exchange` | 60 秒一次性启动码，原子兑换一次；本地实现检查允许来源 |
| 平台游戏页面 | `/api/arena/session`、`/api/pvp/rooms/...` | 第一方游戏 **Bearer** 会话；不是合作方 HMAC 房间 API |
| 平台服务端 → 合作方钱包 | `/wallet/v1/...` | 独立 `platform-to-wallet` HMAC；页面不能直接操作钱包 |
| 本机管理员 | `/api/admin/...` | 管理员 Cookie 与来源校验；不与合作方服务端权限混用 |

服务端签名继续使用[九行 canonical string 和头字段](integration-guide.md#3-hmac-sha256-签名规范--request-authentication)、[固定向量](examples/signature-vector.json)及 [Node SDK](examples/sdk-node.mjs)。HMAC secret 不传到 App 包或 H5。房间 API 的 `external_user_id` 取自平台验证的 Bearer 会话，不能通过房间请求正文选择他人身份。

启动流程仍为：合作方后端签名创建会话 → 宿主打开 `entry_url` → 通过受控通道交付 `launch_code` → 页面兑换 15 分钟 Bearer。当前本地宿主使用同源 `postMessage`，启动码不写入 URL。跨来源合作方网页宿主、原生桥接及真实 WebView 的最终接入需要后续验证；当前同源开发宿主不是完整生产 H5/原生 SDK。

Node SDK 已有 `createSession()`、`games()`、`operation()`；通用 `request()` 可查询付费比赛：

```javascript
// client 的 key、secret、scope 和 baseUrl 配置沿用阶段 B，全部位于后端。
const launch = await client.createSession({
  requestId: persistedLaunchRequestId,
  externalUserId: authenticatedUser.id,
  gameId: 'match', // 也可为 golf、thunder、tiger
  locale: 'en',
  hostPlatform: 'web'
});
const catalog = await client.games();
const matchStatus = await client.request('GET', '/v1/matches/' + matchId);
const receipt = await client.operation(operationId);
```

同一次业务重试保留 request ID 和原始 body；HMAC 重试更换 nonce/timestamp。15 分钟令牌到期或页面重启后，宿主后端重新验证用户，并可使用 `resumeSessionId` / `resume_session_id` 请求新启动码；原 App、用户和游戏必须一致。它恢复原比赛或周期，不重新扣入场费。

## 4. 用 2/3/4 个真实参考用户完成一局

参考钱包为新沙箱 App 预置四个独立用户；阶段 C 本地升级也为符合条件的既有参考钱包 App 补齐第三、第四个用户：

| 人数 | 分别启动的 external_user_id |
|---|---|
| 2 人 | `demo_player`、`demo_player_2` |
| 3 人 | 上述两人，加 `demo_player_3` |
| 4 人 | 上述三人，加 `demo_player_4` |

每个用户初始化 12000 测试币，仅首次创建入账，刷新或重启不会恢复初始余额。同名用户在不同 App 的余额和房间不互通。普通任意用户 ID 不会自动领测试币。管理台选择参考身份仅用于本机沙箱演示；真实合作方必须使用自己的已验证登录身份。

1. 在「合作方与应用」选定一个沙箱 App，启用 `match` 或 `golf`，确认 App 状态为启用。所有窗口使用**同一 App、同一游戏**。
2. 为每位参考用户分别启动一个游戏窗口。窗口各自取得该用户的会话；用一个用户打开多个窗口不能充当多个参赛席位。每个 App 用户同一时间只能占一个有效房间席位。
3. 第一位用户选择 2/3/4 人和入场档位，创建好友房。界面显示房间码、每人入场、总奖池扣费后的冠军奖池及费率。
4. 其余用户在自己的游戏窗口输入同一房间码加入。房间码不是身份凭据；跨 App、跨游戏或未登录请求不能借码进入。
5. 每位真人自行点「准备」。满员后 30 秒内全部准备；未满员邀请房最多等待 5 分钟。付费局不会自动加入 BOT。
6. 全部准备后，服务端冻结席位顺序和完整参赛名单，为每人预留入场金额，再原子捕获全员资金。捕获确认之前，页面保持开局处理中，不能提交游戏动作。预留失败、准备超时或开局前离开走取消/解冻。
7. 服务端裁定动作、时间和排名；游戏页面只发送交换或击球输入。宝石棋盘和高尔夫位置/分数不能由页面直接写入。正常断线保留 30 秒重连窗口。
8. 结果固定后页面可能先显示「结果已锁定，正在确认钱包到账」。平台按原操作号完成全员结算，收到成功回执后显示已到账并刷新余额。
9. 在后台「局单与对账」及资金操作记录查看该 App 的 room/match ID、游戏、规则版本、结果摘要和 reserve/capture/settle 回执。合作方后端也可以签名查询该付费比赛及其操作。

选择「免费练习」时仍支持所选的 2/3/4 人规模，只有当前用户是真人，其余明确显示 **BOT**。入场和费用均为 0，不产生钱包资金操作。BOT 通过相同服务端输入校验提交合法动作；退出练习可立即结束该练习房。

## 5. 服务费与 App 配置快照

本地管理台的竞技服务费是实际持久化字段 `gp_apps.competitive_fee_bps`，不是仅改变页面文字。管理员保存 App 配置后，刷新可以读回；内部保存接口为 `PATCH /api/admin/apps/{app_id}`，例如正文 `{"competitive_fee_bps":500}`。

允许值为 `300`、`500`、`800`、`1000`，分别是 3%、5%、8%、10%；默认 5%。**新房创建时**把 App 费率、入场、人数和规则版本保存进房间条款。此后修改 App 配置只影响新房，不能改写已有房间的费用。App 暂停阻止新房/新准入，已接受的对局和钱包结算继续恢复。

金额使用十进制整数字符串和最小单位：当前参考币 `100 minor = 1 coin`，`entry_minor:"10000"` 即每人 100 币。服务端支持 10/50/100/200/500 币五档，当前游戏大厅展示 10/50/100/200 币四档。

```text
total_pool_minor = entry_minor × player_count
fee_minor = floor(total_pool_minor × fee_bps / 10000)
prize_minor = total_pool_minor − fee_minor
```

例如 2 人各 100 币、费率 5%：总池 200、服务费 10、冠军入账 **190 币（含本金）**。有效并列第一仍按冻结费率收费，净奖池均分；最小单位余数只按入场前随机分配并冻结的 `seat_index` 分配，不用席位决定胜负。整局作废退回每个人原入场额，费用为 0。竞技采用确定性游戏规则和费用配置，不使用概率游戏的 RTP 档位。

## 6. 第一方房间 API 与状态

下列房间端点仅供平台游戏客户端携带 `Authorization: Bearer ...` 使用。POST 还检查允许来源。响应正文直接是房间对象，**没有**额外 `{room: ...}` 包装。

| Method / path | 请求或用途 |
|---|---|
| `GET /api/arena/session` | 当前可信用户、游戏、scope、余额快照、`active_room_id` 或 `other_active_game`；钱包暂不可用可返回 `balance:null` 和 `balance_error`，不阻断已有房恢复 |
| `POST /api/pvp/rooms` | `{request_id,game_id,capacity,entry_minor,practice}`；`practice` 默认为 false；可选自定义 `room_id` |
| `GET /api/pvp/rooms/{idOrCode}` | 本人已加入房间的私有视图和公共排名；刷新本人的连接心跳 |
| `POST /api/pvp/rooms/{idOrCode}/join` | `{request_id}`；加入同 App、同游戏房间 |
| `POST /api/pvp/rooms/{id}/ready` | `{request_id}`；本人确认准备 |
| `POST /api/pvp/rooms/{id}/action` | `{request_id,seq,action}`；seq 从 1 开始严格递增 |
| `POST /api/pvp/rooms/{id}/leave` | `{request_id}`；开局前取消，付费开局后主动弃权，免费练习直接结束 |

`request_id` 是 8–128 位的字母、数字、下划线或连字符。创建返回 HTTP 201，其余成功返回 200。一次动作丢响应后，保留相同 `request_id`、`seq` 和正文重试；不要生成另一笔动作。如果返回 `INVALID_SEQUENCE`，GET 原房，依据 `me_last_seq` 和当前棋盘恢复。`IDEMPOTENCY_CONFLICT` 表示相同请求号的参数被改变，应停止该错误重试。

宝石动作示例：`{"type":"swap","from":0,"to":1}`，格子索引 0–35。高尔夫动作示例：`{"type":"shot","angle":0.4,"power":0.5}`，角度为弧度，力度为 0.02–1。是否可交换、是否忙碌、时间到期及物理结果均由服务端验证。

房间对象包含 `id/code/game_id/status/capacity/practice/players/me/me_last_seq/entry_minor/fee_bps/pool_minor/prize_minor/server_now/starts_at/end_at/ready_deadline_at/result/error/version/game`。`game` 是本人可见的权威快照；宝石不会返回对手棋盘、种子或未来补充序列。客户端按 250–500 ms 轮询，用 `version` 防止旧响应覆盖新视图。

第一方房间 `status` 使用**小写**，合作方 `GET /v1/matches/{match_id}` 的 `state` 按 OpenAPI 使用**大写**，二者不要直接比较：

| 房间 status | 签名比赛查询 state | 意义 |
|---|---|---|
| `waiting` | `WAITING` | 邀请/准备中 |
| `funding` | `CAPTURE_PENDING` | 全员预留及捕获确认中 |
| `active` | `ACTIVE` | 已确认成局，可按规则动作 |
| `fault` | `ACTIVE` | 内部共享故障恢复；当前签名状态没有独立 FAULT 枚举，游戏端通过 room.status/error 展示暂停 |
| `settling` | `SETTLEMENT_PENDING` | 结果固定，等待钱包确认 |
| `settled` | `SETTLED` | 结算已确认 |
| `cancelling` | `CANCEL_PENDING` | 取消/释放确认中 |
| `cancelled` | `CANCELLED` | 未成局取消已确认 |
| `voiding` | `VOID_PENDING` | 已捕获局作废退款确认中 |
| `voided` | `VOIDED` | 全额退款已确认 |

签名比赛查询仅覆盖付费房间。免费 BOT 练习不产生钱包比赛和资金操作。HTTP 200、页面演出结束或预期 `payout_minor` 均不能单独证明到账；最终以 `SETTLED`/`VOIDED` 及对应钱包成功回执为准。

## 7. 断线、重启与资金结果未知

- **游戏窗口断开：** 时钟继续，30 秒内重新以同 App/用户/游戏启动并读取原房即可恢复。主动「离开」是弃权；关闭页面是断线。一个 tick 内所有超时玩家先批量处理，再判胜，避免处理顺序决定冠军。高尔夫已完成三洞的有效得分不会因随后断线被抹去。
- **应用/服务重启：** 房间、随机席位、私有盘面、动作序号和钱包 outbox 保存于 PostgreSQL；重启不重新建席、不重新生成入场扣款。已有房间通过 `/api/arena/session` 找回。
- **钱包 unknown：** HTTP 超时不等于未扣款。平台持久保留同一个 operation ID 和原始正文，先查询原号，再按相同业务号重发。合作方不能在页面错误后另建局来“补扣”。
- **取消与迟到捕获：** 未捕获局通过 release 写入持久取消墓碑。若 capture 已执行但回执丢失，release 明确返回 `ALREADY_CAPTURED`，未开玩的房间改走一次全额 void 退款，不假定释放成功。
- **结果固定后钱包不可用：** 保持 `settling`/`voiding`，持续按原号恢复，不重新抽结果、重新排名或改成另一个结算号。页面显示确认中，恢复后确认到账。
- **共享服务故障：** 当前本地参考策略对 5–60 秒服务 tick 间隔同时平移游戏及心跳时间；超过 60 秒作废退款。引擎共享故障暂停恢复，60 秒无法恢复则作废。个人断线不享用共享故障退款规则。结果已经固定的结算等待不改判为 void。

余额来自主钱包可用余额，礼物/转赠与冻结共享同一账本约束。余额请求失败时显示待同步，不能把空值当作新余额；准入与派彩仍由原子钱包命令确认。

## 8. 验证与交付边界

```sh
npm run test:backend
npm run check:contracts
```

本次 `test:backend` 连续两轮 **81 项全部通过**，包含两款竞技各 2/3/4 人原子成局/结算、五档本金与服务费、并列余数、跨 App 隔离、动作幂等、赠礼竞态、30 秒断线、两个新 OS 进程恢复、真实 socket 丢回执后的查单，以及既有概率周期和参考钱包回归。详见[第一轮后端报告](../review/phase-c/backend-isolated-run-1.tap)、[第二轮后端报告](../review/phase-c/backend-report.txt)和[房间验证记录](pvp-verification.md)。

这些测试使用真实本机 PostgreSQL 和 HTTP 钱包；截止时间用隔离测试快照加速，不能当作完整真人计时试玩或手机网络测试。PvP 套件在导入后端前创建独立临时 PostgreSQL 数据库，恢复子进程也只连接该测试库，避免主 API 定时任务干扰加速快照。测试完成后关闭连接并删除该临时库；[清理证据](../review/phase-c/pvp-isolation-evidence.json)确认没有遗留测试库，演示 App 数据库及余额不变。

浏览器实际联调已完成：三消真实 90 秒双人赛、高尔夫实际击球与弃权结算、4 人免费练习、360/390/430 视口、音乐信号/静音、原请求重试均通过，见 [阶段 C 交付](phase-c-delivery.md)。当前没有宣称 12 款全部完成、达到最终设计稿/动效验收、正式合作方可生产自助接入，或 Android/iOS WebView 已通过验收。
