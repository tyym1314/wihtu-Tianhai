# 阶段 D · 桌游、飞镖与组队接入

当前是可运行的本地沙箱。7 款竞技与原有 2 款概率游戏可以从同一个应用启动；八球、保龄球、沙丘竞速继续开发。本文更新[阶段 C 教程](phase-c-local-integration.md)中的可启动范围与游戏动作，启动码、服务端 HMAC、主钱包、幂等恢复和应用隔离继续沿用原协议。

## 当前游戏目录

| game_id | 游戏 | 人数 | 模式 |
|---|---|---|---|
| carrom | Carrom 弹盘 | 2 / 4 | 双人或对座 2v2 |
| darts | 飞镖对决 | 2 | 301 直出，双方等轮 |
| ludo | Ludo 快速版 | 2 / 4 | 每人双棋子个人赛 |
| jackaroo | Jackaroo 搭档赛 | 4 | 对座 2v2，暗传牌 |
| domino | 多米诺对战 | 2 / 4 | 双六个人抽牌赛 |
| match | 三消对战 | 2 / 3 / 4 | 90 秒竞分 |
| golf | 绿洲高尔夫 | 2 / 3 / 4 | 三洞杆数赛 |
| thunder / tiger | 雷霆王座 / 虎虎生财 | 各 1 | 既有概率游戏的独立平台构建 |

所有竞技都支持明确标记 BOT 的免费练习。BOT 不进入付费房间，不参与资金结算。原有两个独立演示入口及源文件保持保留。

新建沙箱 App 默认授权上述 9 款。已有 App 仅当授权仍与阶段 C 默认四款完全一致时，由一次性迁移补上五款；自定义授权保留，可在「合作方与应用」自行勾选。迁移不重置账户、密码、余额、对局或服务费。

## 从管理台试玩

打开 `http://127.0.0.1:8795/#/partners`，登录后选择 App 和游戏。「免费练习」可直接与 BOT 对局；好友房用同一 App 的 `demo_player`、`demo_player_2`、`demo_player_3`、`demo_player_4` 分别打开窗口，通过房间码加入并各自准备。

参考钱包只为这些测试身份首次初始化测试币。刷新、重新登录或重启不会补满余额。不要把同一用户的两个窗口当作两个参赛者。后台「局单与对账」可查看资金操作与结果；真实结算以钱包成功回执为准。

## 2v2 队伍冻结与分奖

Carrom 的四人房、Jackaroo 的四人房固定为两队。第 1、3 位加入者是 `team_a`，第 2、4 位是 `team_b`。大厅和准备页在扣币前展示队友与弃权规则。全员准备时随机分配座位，保持同队对座；颜色、先后手随冻结座位确定。`players[].team_id` 不随座位随机变化。

| 字段 | 含义 |
|---|---|
| `team_size` | 个人赛为 1，组队赛为 2 |
| `players[].team_id` | 组队赛为 `team_a` / `team_b`，个人赛为空 |
| `seed_commitment` | 房间建立时种子的 SHA-256 承诺值；原种子和未来随机序列不发送给页面 |
| `terms.payout_template_version` | 个人赛 `winner-all-v1`；2v2 `team-share-v1` |
| `participants[].team_id` | 付费比赛查询及钱包 capture 冻结的队伍名单 |

费用仍按总奖池计算，App 可选 3% / 5% / 8% / 10%，默认 5%。四人各 100 币、5% 时，总池 400，服务费 20，胜队两人各获得 **190 币（含本金）**。有效并列两队则四人平分净奖池。最小币值余数按冻结座位顺序分配。整局作废，每人退回 100 币且不收服务费。

主动退出、个人断线超过 30 秒或达到该游戏的连续超时阈值，会按该游戏弃权规则处理。飞镖只把**整回合没有任何有效投镖**计入超时次数；有效命中或有效脱靶都会清零连续次数，已经投过一镖后耗尽剩余时间不会累计，连续三次无有效投镖才弃权。其他桌游的三次本人回合超时按各自规则计数。组队赛一人弃权导致全队弃权，包含其队友。一个 tick 内全部断线会先批量处理，再判定全局作废；不会由遍历顺序选赢家。

## 合作方启动

合作方后端仍签名调用 `POST /v1/sessions`，把 `game_id` 换成目录中的 ID 即可。推荐先签名查询 `GET /v1/games`，以该 App 的 `available` 和 `modes` 为准显示入口，不自行假定授权即上线。

```javascript
const launch = await client.createSession({
  requestId: persistedRequestId,
  externalUserId: authenticatedUser.id,
  gameId: 'jackaroo',
  locale: 'zh',
  hostPlatform: 'web'
});
// 将一次性启动码通过受控宿主消息通道传给 entry_url 对应页面。
// HMAC 密钥保留在合作方后端；启动码与 Bearer 不放进 URL。
```

当前本地宿主只完成同源 Web 通道。原生 App 的 WebView 桥接、跨来源宿主、阿拉伯语/RTL、第二合作方独立部署、HTTPS 和生产自接入仍须后续实现及验收。本地参考实现与教程可用于联调，不代表合作方已可直接生产上线。

### 同源 Web 启动握手

下面函数运行在与游戏入口**完全同源**的宿主页上，例如当前 `http://127.0.0.1:8795`；端口也必须相同。`fetchLaunchFromYourBackend(gameId)` 是宿主提供的函数：请求自己已鉴权的后端，由后端执行上面的 HMAC `client.createSession()`，返回 `{entry_url,launch_code,session_id}`。它不是平台新增接口，也不能把 Node 客户端或 HMAC 密钥打包进网页。浏览器只接收当前登录用户的这份短期启动响应。

```javascript
// 浏览器宿主代码；在用户点击事件内直接调用，先开窗口再等待后端。
async function openSameOriginGame(gameId, fetchLaunchFromYourBackend) {
  const games = ['carrom', 'darts', 'ludo', 'jackaroo', 'domino',
                 'match', 'golf', 'thunder', 'tiger'];
  if (!games.includes(gameId)) throw new Error('未开放的游戏');
  const origin = window.location.origin;
  const popup = window.open('about:blank', '_blank', 'popup,width=460,height=880');
  if (!popup) throw new Error('请允许本站弹窗后重试');

  let entry, launchCode, sessionId;
  try {
    const launch = await fetchLaunchFromYourBackend(gameId);
    entry = new URL(launch.entry_url, origin);
    if (entry.origin !== origin || entry.pathname !== '/play/' + gameId ||
        entry.search || entry.hash || typeof launch.launch_code !== 'string') {
      throw new Error('启动响应不符合当前同源入口约定');
    }
    launchCode = launch.launch_code;
    sessionId = launch.session_id;
    if (popup.closed) throw new Error('游戏窗口已关闭');
  } catch (error) {
    popup.close(); // 此时尚未进入游戏或发送启动码。
    throw error;
  }

  return new Promise((resolve, reject) => {
    let sent = false, timer, closedCheck;
    const finish = error => {
      window.removeEventListener('message', receive);
      clearTimeout(timer);
      clearInterval(closedCheck);
      launchCode = '';
      if (error) reject(error);
      else resolve({popup, session_id: sessionId});
    };
    const receive = event => {
      if (event.source !== popup || event.origin !== origin ||
          event.data?.game_id !== gameId) return;
      if (event.data.type === 'oasis.ready' && !sent) {
        sent = true;
        popup.postMessage({type: 'oasis.launch', launch_code: launchCode}, origin);
        launchCode = ''; // 已同步交给 postMessage，不存 URL、存储或日志。
      } else if (event.data.type === 'oasis.loaded' && sent) {
        finish();
      } else if (event.data.type === 'oasis.error' && sent) {
        finish(new Error(typeof event.data.message === 'string'
          ? event.data.message : '游戏报告启动失败'));
      }
    };
    // 必须先监听，再导航，避免遗漏页面首次发出的 ready。
    window.addEventListener('message', receive);
    timer = setTimeout(() => finish(new Error('25 秒内未确认启动，请检查游戏窗口')), 25000);
    closedCheck = setInterval(() => {
      if (popup.closed) finish(new Error('窗口已关闭，启动尚未确认'));
    }, 500);
    popup.location.replace(entry.href); // entry_url 不带 code 或 Bearer。
  });
}

// fetchLaunchFromYourBackend 由宿主自己的后端接入代码提供。
// 按钮需由宿主页面提供；不要把平台管理员 launch 接口当合作方 API。
document.getElementById('open-game').onclick = () => {
  openSameOriginGame('jackaroo', fetchLaunchFromYourBackend)
    .then(() => { document.getElementById('launch-status').textContent = '游戏会话已载入'; })
    .catch(error => { document.getElementById('launch-status').textContent = error.message; });
};
```

当前游戏页面会发送 `{type:'oasis.ready',game_id}`；收到并验证同源宿主的 `{type:'oasis.launch',launch_code}` 后，自行调用 `POST /v1/launch/exchange`，把 Bearer 保留在页面内存，随后发送 `{type:'oasis.loaded',game_id}` 或 `{type:'oasis.error',game_id,message}`。宿主不需要代替游戏兑换，也不从这些消息获取 Bearer。`loaded` 表示会话兑换与上下文载入完成，不表示所有美术资源已经渲染或奖金到账。

此协议依赖 `window.opener`（当前沙箱弹窗）或同源父窗口，弹窗不能使用会切断 opener 的 `noopener` 配置。错误或握手超时只说明启动未确认，不应据此重发扣款、强制关闭可能已载入的游戏或把旧启动码放入 URL。重新授权、请求幂等及原房恢复仍按前文约定处理。这里没有实现 Android/iOS 原生桥接或跨来源消息授权。

## 第一方动作与隐私

游戏页面继续使用 `POST /api/pvp/rooms/{id}/action`，正文为 `{request_id,seq,action}`。这是平台自有 Bearer 客户端接口；合作方不提交胜负或得分。每次成功动作序号递增，网络结果未知时保留原请求号、序号及正文重试。

| 游戏 | action | 服务端裁定 |
|---|---|---|
| Carrom | `{type:'shot',offset,angle,power}` | 基线位置、朝向、物理碰撞、收子、皇后覆盖、犯规与罚退 |
| Darts | `{type:'throw',gesture:[{t,x,y},...]}` | 拖动轨迹和释放速度映射落点，靶区得分与爆分；不接受客户端分数 |
| Ludo | `{type:'roll'}` / `{type:'move',piece}` | 骰子在该轮开始时固定；公开后选择合法棋子，不可重抽 |
| Jackaroo | `{type:'pass',cardId}`、`{type:'play',cardId,effect,...}`、`{type:'discard',cardId}` | 牌权、棋子归属、完整牌效、暗传与拆 7 原子执行 |
| Domino | `{type:'play',tileId,end}` / `{type:'draw'}` / `{type:'pass'}` | 手牌所有权、接龙点数、抽牌及封局 |

Carrom `offset` 为本人的基线归一化位置 -1..1，`angle` 为相对自己朝向的弧度，`power` 为 0.02..1。客户端旋转视角不改变服务端席位坐标。确定性轨迹用于演出，不由页面上报碰撞或进袋。

Darts 手势在靶心坐标系中记录，半径归一化，3–128 个采样、80–2000 ms；靶区与计算常量客户端/服务端共享。靶外有效投掷计 0 分，不算没有动作的回合超时。

Jackaroo 页面只收到自己的手牌和合法动作。暗传后对手只能看到是否已传牌，不能看到牌号。拆 7 通过选择棋子、步数和后续分段组成总计 7 的合法动作；若任何分段非法，整张牌和全部棋子都保持原状。自己的四珠全部进家后才可帮助队友。

Domino 页面只收到自己的手牌、公共牌链、对手手牌张数和余牌堆数量；活动对局不通过公共排名泄露对手手牌点数或暗牌序列。弃权者手牌移出本局，不能回到牌堆被他人抽取。

所有桌游的 `game.lastEvent` 允许对手/BOT 动作在轮询后播放；不是只重放自己的动作。`game` 中的时间字段与 `room.server_now` 配合插值。后端冻结规则、计时与结算，动画结束不是资金到账信号。

## 运行与验证

```sh
cd platform
npm run db:start
npm run build:arena
npm run build
npm run server
# 另一终端运行 npm run dev
npm run test:backend
npm run check:contracts
```

竞技构建与服务端都使用 `shared/games.mjs` 的准入清单。修改竞技前端需要重新构建 `arena/dist`，修改服务端需要重启 API；不要在有付费进行中房间时直接切换规则引擎版本。服务端短暂中断会同时平移游戏与心跳时钟；超过 60 秒执行约定的整局退款，已固定的结算结果仍按原操作号恢复。

平台 API 与 PvP 集成测试使用隔离的临时 PostgreSQL 数据库与真实 HTTP 参考钱包，结束后删除测试库，不修改正在试玩的游戏状态。钱包单项测试使用独立随机 partner/scope，默认会在本机开发库写入并保留测试记录；可用 `DATABASE_URL` 指定其他数据库，不重置已有演示用户或共享 schema。规则测试、集成测试和浏览器实际操作的范围及结果见[阶段 D 交付记录](phase-d-delivery.md)。
