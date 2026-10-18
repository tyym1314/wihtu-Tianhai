# Tianhai 游戏平台 · 第三方 App 正式接入指南

平台入口：`https://game.tianyahuyu.com`　|　协议版本：`gp-api-v1`　|　机器契约：[openapi.json](openapi.json)

本指南面向接入方（第三方 App）的后端与客户端工程师。接入后，你的用户使用**你的账号体系**登录，游戏内金币**始终保存在你的钱包**里：平台在开局时通过签名请求冻结/扣除入场费，结束后派奖。平台不保存你的用户余额，也不提供充值或提现。

## 1. 可接入的游戏

| game_id | 名称 | 类型 | 人数 |
|---|---|---|---|
| `match` | 三消对战 | 竞技 | 2–4 |
| `golf` | 绿洲高尔夫 | 竞技 3D | 2–4 |
| `bowling` | 保龄球对决 | 竞技 3D | 2–4 |
| `run` | 沙丘竞速 | 竞技 3D | 2–4 |
| `carrom` | Carrom 弹盘 | 竞技 | 2 / 2v2 |
| `pool` | 八球对决 | 竞技 | 2 |
| `darts` | 飞镖对决 | 竞技 | 2 |
| `ludo` | Ludo 快速版 | 棋类 | 2 / 4 |
| `jackaroo` | Jackaroo 搭档赛 | 棋牌 | 2v2 |
| `domino` | 多米诺对战 | 棋牌 | 2 / 4 |
| `towerlink` | 连线占塔 | 策略 | 2–4 |
| `thunder` | 雷霆 | 概率 | 1 |
| `tiger` | 虎虎生财 | 概率 | 1 |

娱乐场游戏（38 款，均支持中文 / 英文 / 阿语，含背景音乐、音效、规则说明与“我的记录”）：

| game_id | 名称 | 玩法 |
|---|---|---|
| `greedylion` | GreedyLion | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `rocketstar2` | RocketStar2 | 共享回合（爆点，随时提现） |
| `teenpatti` | TeenPatti | 共享回合（三家比牌） |
| `olympus` | Olympus | 单人（老虎机） |
| `greedycat2` | GreedyCat2 | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `greedybrutal` | GreedyBrutal | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `bigeater` | BigEater | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `greedyking` | GreedyKing | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `greedyforest` | GreedyForest | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `herochest` | HeroChest | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `fruitparty` | FruitParty | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `oceanslot` | OceanSlot | 单人（老虎机） |
| `mahjongslot` | MahjongSlot | 单人（老虎机） |
| `cleopatraslot` | CleopatraSlot | 单人（老虎机） |
| `crazygems` | CrazyGems | 单人（老虎机） |
| `slot777` | Slot777 | 单人（老虎机） |
| `djlive` | DJlive | 单人（老虎机） |
| `jackpotslots` | jackpotSlots | 单人（老虎机） |
| `yummy` | Yummy | 单人（老虎机） |
| `worldgoal` | WorldGoal | 单人（老虎机） |
| `chillislot` | ChilliSlot | 单人（老虎机） |
| `sphinxlegend` | sphinxlegend | 单人（老虎机） |
| `nights1001` | 1001Nights | 单人（老虎机） |
| `pyramidslots` | PyramidSlots | 单人（老虎机） |
| `magicslot` | MagicSlot | 单人（老虎机） |
| `crazyfruit` | CrazyFruit | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `magiccard` | MagicCard | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `bountyfootball` | BountyFootball | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `footballleague` | FootballLeague | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `glorycup` | GloryCup | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `solomonmines` | SolomonMines | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `roulette` | roulette | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `roulettepro` | RoulettePro | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `sicbo` | SicBo | 共享回合（转盘 / 押注 / 轮盘 / 骰宝） |
| `monster` | Monster | 单人（街机射击） |
| `molestar` | MoleStar | 单人（街机射击） |
| `crash` | Crash | 共享回合（爆点，随时提现） |
| `crashstar` | CrashStar | 共享回合（爆点，随时提现） |

竞技游戏：入场 10/50/100/200 币，满员且全员就绪后冻结并扣除入场费，冠军（或胜队）分得奖池，平台按 App 配置的服务费率（默认 5%）收取服务费。所有判定都在平台服务端完成，客户端不能提交分数。三种开局方式：

- **快速匹配**：自动撮合**同一 App 内**选择相同游戏、人数和入场费的真人玩家，满员后自动开局；最长等待 120 秒，未匹配到不收费。
- **好友房**：创建房间后把房间码发给好友加入（可在你的 App 聊天里分享）。
- **免费练习**：对战明示的 BOT，不扣币。

**语言**：所有游戏支持简体中文、英文、阿拉伯语（阿语界面为从右到左；棋盘与赛道方向不镜像）。

概率游戏：每次投注是一个完整周期（含免费转），开奖前先在你的钱包冻结投注与最高派彩责任；数学模型为 1000 万周期仿真验证的 RTP 98%/99% 两档，未经第三方认证。

娱乐场游戏的扣款与派奖（都走第 5 节的同一套钱包接口）：

- **共享回合**：同一 App 内所有玩家共用一条连续回合（开奖前公布种子承诺，开奖后公开种子）。每一注下注时扣款一次，开奖后按结果加款；错过截止或无法确认的下注全额退回。爆点类在飞行中可手动或自动提现。
- **单人老虎机**：一次付费旋转（含其触发的全部免费旋转与特色玩法）扣款一次、派奖一次。
- **街机射击**：首发时按每发押注一次性购买 50 发弹药（扣款一次）；结束、换押注或离开时结算一次，赢得与未用弹药一起加款返还；闲置 2 分钟自动结算。
- 游戏列表以 `GET /v1/games` 返回为准；新建 App 默认开放全部游戏，可在应用设置中勾选。

## 2. 开通流程

1. **平台开账号**：平台管理员在管理台“合作方与应用”为你创建合作方账号，通过安全渠道发送初始密码。
2. **登录工作台**：打开 `https://game.tianyahuyu.com`，选择“合作方”登录，首次登录后在“账户安全”修改密码。
3. **创建 App**：新 App 默认**暂停**，并要求绑定你自己的钱包。创建结果中的 `key_id` 与 `secret_base64`（合作方→平台签名密钥）**只显示一次**，请立即存入你的后端密钥管理。丢失时可在“接入”页创建备用密钥再撤销旧密钥。
4. **实现钱包接口**（第 5 节，3 个接口），部署到一个**公网 HTTPS** 域名（只解析到公网地址、证书有效、不跳转，3 秒内响应）。
5. **绑定钱包**：在“接入”页填写钱包 Origin（如 `https://wallet.example.com`）以及你生成的**平台→钱包**签名密钥（Key ID + 32 字节以上随机数的 Base64）。绑定只能在 App 暂停且尚无任何会话/账务时进行，绑定后永久锁定。
6. **余额探测**：输入一个已存在的用户 ID，点击“查询玩家余额”，确认签名、scope、币种精度都正确。
7. **启用 App**：在应用设置中把状态改为“启用”，选择开放的游戏。

> 建议先创建一个“测试 App”，绑定你的预发钱包和测试用户完成联调；再创建“正式 App”绑定正式钱包。两个 App 的用户、订单与密钥完全隔离。

## 3. 后端：为用户创建游戏会话

用户在你的 App 内点击某款游戏时，由**你的后端**（不能是客户端）签名调用：

```
POST https://game.tianyahuyu.com/v1/sessions
```

```json
{
  "partner_id": "<你的 partner_id>",
  "app_id": "<app_id>",
  "environment": "production",
  "wallet_scope_id": "<App 的 wallet_scope_id>",
  "currency_id": "COIN",
  "request_id": "launch_7f3c...（你持久化的唯一业务号）",
  "external_user_id": "<你的用户 ID，1–128 位 [A-Za-z0-9_-]>",
  "game_id": "bowling",
  "locale": "en",
  "host_platform": "android"
}
```

返回：`session_id`、`launch_code`（60 秒内一次有效）、`expires_at`、`entry_url`。

- 签名规则见[接入教程第 3 节](integration-guide.md#3-hmac-sha256-签名规范--request-authentication)与[固定签名向量](examples/signature-vector.json)；Node.js 可直接使用 [sdk-node.mjs](examples/sdk-node.mjs) 的 `OasisClient.createSession()`。
- `locale` 决定游戏语言：`zh-CN`、`en` 或 `ar`。
- 网络超时请用**相同 request_id 和相同正文**重试，平台返回同一结果；新的启动意图使用新 request_id。
- 使用平台启动页（第 4.1 节）时**不要传 `host_origin`**。只有在你自己的网页里用 iframe 嵌入（第 4.2 节）时，才传入并在“接入”页登记你的网页 Origin。

## 4. 客户端：打开游戏

### 4.1 原生 App（Android / iOS WebView，推荐）

用全屏 WebView 打开：

```
https://game.tianyahuyu.com/launch/?game=<game_id>&lang=<zh|en|ar>#code=<launch_code>&session=<session_id>
```

`lang` 可选，建议与 `/v1/sessions` 的 `locale` 一致；省略时按会话语言或设备语言。

启动码放在 `#` 片段中，不会发送到任何服务器日志；页面加载后会立即从地址栏移除。

WebView 设置：开启 JavaScript 与 DOM Storage；允许媒体自动播放（Android `setMediaPlaybackRequiresUserGesture(false)`）；不要开启文件访问与混合内容；只允许 `https://game.tianyahuyu.com` 顶层导航。

**游戏 → App 消息**（JSON 字符串）：

| 平台 | 接收方式 |
|---|---|
| Android | `webView.addJavascriptInterface(obj, "TianhaiApp")`，实现 `@JavascriptInterface void postMessage(String json)` |
| iOS | `WKUserContentController.add(handler, name: "tianhai")` |
| React Native | `onMessage`（`window.ReactNativeWebView.postMessage`） |

| type | 含义 | App 处理 |
|---|---|---|
| `loaded` | 会话兑换成功，游戏已加载 | 可隐藏原生加载层 |
| `close` | 玩家选择返回 | 关闭 WebView，回到游戏入口；随后从你的后端刷新余额 |
| `reauth_required` | 长时间对局令牌过期 | 后端用 `resume_session_id=<session_id>` 再次调用 `/v1/sessions`，用新启动码重新打开启动页 |
| `error` | 启动失败（启动码过期等） | 提示用户并允许重新进入 |

**系统返回键**：调用 `webView.evaluateJavascript("window.TianhaiLauncher&&window.TianhaiLauncher.requestBack()", null)`。游戏会自行处理“对局中离开”的确认，确认后再发送 `close`。不要在对局中直接销毁 WebView（服务端对局仍会继续计时，断线 30 秒判弃权）。

**切后台**：WebView 暂停即可；回到前台游戏会从服务端恢复状态。

### 4.2 H5 网页嵌入

在你自己的网页中使用 [H5 SDK](/sdk/oasis-h5.mjs)：

```js
import { TianhaiHost } from 'https://game.tianyahuyu.com/sdk/tianhai-h5.mjs';
const game = new TianhaiHost({
  platformOrigin: 'https://game.tianyahuyu.com',
  gameId: 'match',
  requestLaunch: ({ gameId, resumeSessionId }) => yourBackend.launch(gameId, resumeSessionId), // 返回 /v1/sessions 的结果
  onEvent: e => { if (e.type === 'return_requested') game.destroy(); }
});
await game.mount(document.querySelector('#game'));
```

此方式需在 `/v1/sessions` 传入 `host_origin`（你的网页 Origin），并在“接入”页登记该 Origin。

## 5. 钱包接口（由你实现）

你只需实现 3 个接口（协议 `simple-v1`）。冻结、全员扣款、未开局退款、派奖、概率周期责任等状态全部由平台处理。

平台以 `platform-to-wallet` 方向签名调用（签名格式同第 3 节，`X-GP-Direction: platform-to-wallet`，使用绑定时登记的钱包密钥）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/wallet/simple/v1/users/{external_user_id}/balance` | 查询可用余额 |
| POST | `/wallet/simple/v1/debit` | 扣款（入场费、投注） |
| POST | `/wallet/simple/v1/credit` | 加款（派奖、退款、中奖） |

所有金额都是整数，单位就是你 App 自己的币（`currency_scale` 固定为 0）：传 `125000` 就是 125000 个币，不做换算。

**余额**响应：

```json
{ "external_user_id": "u_10086", "available_minor": "125000", "currency_scale": 0 }
```

**扣款 / 加款**请求体：

```json
{
  "request_id": "in_reserve_pvp_8f2c..._0",
  "external_user_id": "u_10086",
  "amount_minor": "10000",
  "currency_id": "COIN",
  "reason": "match_entry",
  "reference_id": "pvp_8f2c...",
  "game_id": "bowling"
}
```

`reason`：扣款为 `match_entry` / `spin_bet`；加款为 `match_payout` / `match_refund` / `spin_win` / `spin_refund` / `payout` / `refund`。`reference_id` 是对局号或概率周期号，便于对账展示。

响应（HTTP 200）：

```json
{ "request_id": "in_reserve_pvp_8f2c..._0", "status": "SUCCEEDED" }
{ "request_id": "...", "status": "REJECTED", "code": "INSUFFICIENT_FUNDS" }
```

你必须保证：

1. **验签**：校验签名、时间戳（±300 秒）和 nonce 不重复。
2. **幂等**：同一个 `request_id` 最多生效一次；重复请求原样返回第一次的结果（包括 REJECTED）。平台在超时或网络异常时会**用同一个 `request_id` 重试**，不会另起一笔。
3. **扣款不透支**：余额不足返回 `REJECTED` + `INSUFFICIENT_FUNDS`，不要部分扣款。
4. **加款不拒绝**：加款是平台欠用户的钱，只应返回 `SUCCEEDED`；暂时失败时返回 5xx，平台会持续重试直到成功。
5. 与你 App 内其他消费（送礼、转赠等）共用同一个原子余额。

资金时序：对局满员就绪后，平台对每位玩家扣入场费；有人扣款失败则整局取消并把已扣的加回；结束后给胜者加奖池（总入场 − 服务费），服务费即你扣入与加回的差额。概率游戏每转扣投注、开奖后加中奖额（未中奖不加款）。


## 6. 查单与对账

- `GET /v1/matches/{match_id}`：本 App 的比赛状态与结算明细。
- `GET /v1/operations/{operation_id}`：平台侧资金操作的镜像与对账状态。
- 宿主消息（`loaded` / `close`）只是展示层信号，不代表扣款或派奖；余额以你的钱包账本为准。

## 7. 上线前检查

- [ ] 签名向量自测通过；密钥只在后端，App 包与网页中没有任何 secret。
- [ ] 钱包：同一 request_id 并发重复只记一次账；扣款不透支；加款始终成功。
- [ ] 测试 App 上完成：免费练习、2 人付费房（一方中途退出）、概率游戏至少一次中奖，并核对双方账务。
- [ ] Android/iOS：系统返回、切后台、断网重连、进程被杀后重新进入。
- [ ] 正式 App 绑定正式钱包并启用；测试用户与测试币不迁入正式环境。
