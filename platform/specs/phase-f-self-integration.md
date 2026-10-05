# 阶段 F · 合作方自助接入教程

状态：**v0.6，本地沙箱实现**。平台提供独立合作方账号、按 App 隔离的管理入口、钱包地址绑定、Node BFF 示例、浏览器 H5 SDK 和真实接口检查。现有目录为 11 款竞技 + 2 款概率游戏。本文是当前可运行入口；资金语义仍以[钱包协议](wallet-protocol.md)为准。

本地脚本、浏览器尺寸模拟和参考钱包验证，不等于外部合作方人员仅凭文档完成接入，也不等于 Android/iOS 真机、公网 TLS 或生产验收。生产环境入口仍关闭。开发者中心的“五场景流程”是浏览器演示；本文第 7 节的八项检查才会调用真实后台并产生测试账务。

## 1. 组件与准备

平台部署命令在仓库的 `platform/` 目录执行；合作方钱包和宿主命令也可在[完整沙箱接入包](/downloads/oasis-partner-sandbox-kit.zip)解压后的包根目录执行，无需取得平台源码。包内带有独立 `package.json`、依赖锁和 README，先运行 `npm ci` 与 `npm run verify`。平台初次部署见[平台 README](../README.md)；已有本地平台时由部署方更新环境并重启，不要并行启动第二份同端口服务。

| 组件 | 默认位置 | 身份与用途 |
|---|---|---|
| 管理台与游戏公共入口 | `http://127.0.0.1:8795` | 浏览器访问；代理平台 API 和游戏资源 |
| 平台 API | `127.0.0.1:8797` | 会话、权威游戏、局单与恢复任务 |
| 平台参考钱包 | `127.0.0.1:8798` | 原本地演示保留；不是合作方独立钱包 |
| 合作方 Node BFF + H5 | `http://127.0.0.1:8800` | 独立宿主；长期平台密钥只在 BFF |
| 合作方独立参考钱包 | `http://127.0.0.1:8801` | 独立进程、独立数据库；使用钱包方向密钥 |
| 本地 PostgreSQL | `127.0.0.1:5487` | 平台库和独立钱包库必须使用不同库名 |

平台运行前，由部署方为钱包 origin 配置精确允许列表：

```sh
OASIS_WALLET_ALLOWED_ORIGINS='http://127.0.0.1:8801' npm run server
```

多个钱包使用逗号分隔的完整 origin。此变量属于平台 API 进程配置，不能在合作方网页里修改。它与每个 App 的 `allowed_origins` 不同：前者控制平台能请求哪些钱包服务器，后者控制谁能作为游戏宿主。HTTP 钱包仅允许回环 IP；外部钱包要求 HTTPS、公开 DNS 地址与有效证书，拒绝重定向和私网目标。当前完整示例只在本机回环运行。

## 2. 取得独立合作方账号，创建并暂停新 App

1. 平台管理员在“合作方与应用”的账号管理区域创建合作方名称、用户名和密码。用户名为 3–64 个英文字母/数字/点/横线/下划线；密码为 12–256 个字符。通过双方已有安全渠道交付账号，密码不在创建响应中回显。当前没有公开自助注册或找回密码流程。
2. 在管理台登录页选择“合作方”，使用独立账号登录。合作方只能读取自身 `partner_id` 下的沙箱 App、局单、资金操作和审计；管理员账号及 Cookie 保留独立边界。
3. 创建专用测试 App，保存创建时仅显示一次的 `key_id` 和 `secret_base64`。这是 **partner-to-platform** 密钥，供 BFF 调用平台，不能用于钱包验签。接入台可复制公开 scope，但不会再次提供这个 secret。
4. **立即暂停这个全新 App，再配置独立钱包。不要先点试玩、运行检查或通过 SDK 创建会话。** 新建 App 默认启用，并已有参考钱包的演示余额；这些余额不会迁移到独立钱包。

合作方可改自己的 App 名称、启停状态，以及当前十三款游戏的开关；不能修改 RTP 数学档位、竞技费率、合作方身份或其他 App。费率/数学配置由平台管理员管理。初始默认竞技费率为 500 bps，即 5%；对局创建后条款冻结。

固定游戏 ID：`carrom, match, golf, darts, ludo, pool, bowling, jackaroo, domino, run, thunder, tiger`。实际可启动游戏以签名 `GET /v1/games` 的 `available` 和 `modes` 为准。

## 3. 准备独立钱包数据库和私有配置

下载[完整合作方沙箱接入包 ZIP](/downloads/oasis-partner-sandbox-kit.zip)。包内 `examples/partner-wallet/README.md` 与 `config.example.json` 提供钱包入口和占位配置；还包含钱包依赖源码、BFF/H5、Node SDK、公开协议和四条数学版本元数据。包不含真实密钥、token、运行报告或游戏素材；所有 `REPLACE_...` 配置需在私有文件中填写。

由数据库管理员创建独立测试库，例如：

```sh
createdb -h 127.0.0.1 -p 5487 -U oasis_local oasis_partner_sandbox
mkdir -p .local/partner-wallet
chmod 700 .local/partner-wallet
cp examples/partner-wallet/config.example.json .local/partner-wallet/config.json
chmod 600 .local/partner-wallet/config.json
```

`createdb` 来自 PostgreSQL 命令行工具；库已存在时不要删除或重建。不能使用 `oasis_platform` 或当前平台配置的数据库。独立钱包启动器会检查库名隔离。

在私有文件中填写：

- 当前 App 的完整 `scope`：`partner_id, app_id, environment, wallet_scope_id, currency_id`，全部照接入台复制，不能自行混用其他 App 的值。`environment` 为 `sandbox`，当前 `currency_scale` 为 `2`。
- 新的、未被使用过的 `key_id` 与至少 32 字节随机值的标准 Base64 `secret_base64`，专用于 **platform-to-wallet**。不要复用第 2 节的 BFF 密钥。用本地密码管理器或加密随机源生成并直接保存到私有文件，不写进浏览器代码、终端日志或聊天记录。
- 四个测试用户及开户测试余额。自动检查使用 `demo_player`、`demo_player_2`，每人至少有 `10000` 最小单位可用余额且冻结额为零；模板还提供 `demo_player_3`、`demo_player_4`。这是测试币，不是充值接口。
- `treasury_minor` 和实际选用的不可变数学配置。模板里的 `REPLACE_...` 不能原样使用。Thunder/Tiger 都需登记 `math_version`、`math_config_hash` 和 `max_payout_multiplier`；若准备启用 98/99 两档，则共登记四条。

平台部署方可从当前实现导出公开数学元数据，再交给钱包配置人员核对：

```sh
npx tsx -e "import {getProfile} from './server/math/index.ts'; console.log(JSON.stringify(['thunder','tiger'].flatMap(game_id=>['98','99'].map(p=>{const m=getProfile(game_id,p);return {game_id,math_version:m.version,math_config_hash:m.hash,max_payout_multiplier:String(m.maxMultiplier)};})),null,2))"
```

这些是沙箱数学版本：98/99 表示统计目标，没有第三方认证或生产批准。当前最高完整周期毛派彩上限为 Thunder 10000 倍、Tiger 455 倍，以所登记版本为准。

启动独立钱包：

```sh
OASIS_PARTNER_WALLET_DATABASE_URL='postgres://oasis_local@127.0.0.1:5487/oasis_partner_sandbox' \
OASIS_PARTNER_WALLET_CONFIG='.local/partner-wallet/config.json' \
node examples/partner-wallet/server.mjs
```

示例只监听回环 `8801`，不提供网页、公开调账或无授权发币接口。重启不会重置已有余额和密钥；数据库、配置与平台 `.local/master.key` 均需要各自的私有备份。不要把 `.local` 放进静态目录或提交版本库。

## 4. 绑定钱包、探测，再启用 App

进入当前 App 的接入台，确认状态为暂停，钱包显示可配置，然后填写：

- 钱包 Origin：`http://127.0.0.1:8801`。
- 钱包 Key ID：第 3 节配置的 `key_id`。
- 钱包 Secret：第 3 节配置的 `secret_base64`。

提交会在后端一次性保存绑定，并替换该 App 原参考钱包方向的有效密钥。绑定只允许 **全新、暂停、尚无会话/房间/周期/出站资金记录** 的沙箱 App；已绑定或已有活动记录的 App 不允许更换钱包，即使旧局已结束也不例外。需要另一个钱包时，创建另一个专用 App；不要删旧账务以绕过限制。

点击“检查钱包连接”。这是对 `demo_player` 的真实签名余额查询，校验方向、scope、用户、精度及响应结构，使用 GET 查询而不发出资金命令。钱包自身会登记防重放 nonce，也可能按正常规则释放已到期冻结。仅 `/health` 返回成功不代表钱包已接通。绑定请求若响应丢失，先刷新查看实际绑定状态，不要假定失败后更换 Key 重发。

余额探测成功后启用 App，打开三消授权供自动检查使用。若稍后要测试概率游戏，确认独立钱包已登记该 App 当前数学档位对应的版本和准备金责任。

## 5. 登记宿主来源，启动独立 Node BFF

在接入台“允许的宿主 Origin”加入 `http://127.0.0.1:8800` 并保存。必须精确匹配 scheme、hostname、port；`localhost` 与 `127.0.0.1` 是不同来源。不要填路径、通配符或 `null`。平台自身 origin 自动保留。

按[独立宿主 README](examples/partner-host/README.md)创建私有配置，例如 `.local/partner-host.json`：

```json
{
  "platform_base_url": "http://127.0.0.1:8795",
  "host_origin": "http://127.0.0.1:8800",
  "key_id": "REPLACE_PARTNER_TO_PLATFORM_KEY_ID",
  "secret_base64": "REPLACE_PRIVATE_PLATFORM_SECRET",
  "scope": {
    "partner_id": "REPLACE_PARTNER_ID",
    "app_id": "REPLACE_APP_ID",
    "environment": "sandbox",
    "wallet_scope_id": "REPLACE_WALLET_SCOPE_ID",
    "currency_id": "COIN"
  },
  "external_user_id": "demo_player"
}
```

```sh
chmod 600 .local/partner-host.json
node specs/examples/partner-host/server.mjs --config "$PWD/.local/partner-host.json"
```

配置必须是权限严格 `0600` 的普通文件，不能是符号链接，也不能放在 `specs/`、`public/` 或示例静态目录。访问 `http://127.0.0.1:8800` 后，游戏列表来自真实签名目录。

示例 BFF 是固定测试身份的本机应用，不是生产登录系统。其 `/api/host/launch` 只接收 `game_id`、稳定 `request_id`、可选 `resume_session_id`；使用配置里的可信用户与 scope，不接受浏览器自报用户。真实合作方应把此身份来源替换为自己已认证的后端用户，并保存启动意图的原请求号与正文。

## 6. 游戏启动、返回与恢复

链路为：宿主浏览器 → 自己的 Node BFF → 平台 HMAC `POST /v1/sessions` → 60 秒一次性启动码 → 平台域 iframe 兑换 → 游戏内存中的 15 分钟 Bearer → 权威游戏 API。启动码不进入 URL、localStorage 或日志；长期密钥永远不发给浏览器。

[浏览器 SDK](/sdk/oasis-h5.mjs) 在平台公共入口的下载地址为 `/sdk/oasis-h5.mjs`；[Node SDK](examples/sdk-node.mjs) 只在 BFF 运行。宿主 SDK 将通道绑定到准确的 iframe/popup Window、平台 origin、游戏 ID 和随机 nonce；启动码在消费前校验真实宿主来源与游戏绑定。

宿主可提供可见性、语音状态、静音和安全区，或请求返回；游戏自行处理已受理对局和退出确认。WebAudio 仍需真实手势解锁。`loaded`、`return_requested` 等消息只是展示状态，不能用于扣款、派奖或退款。

收到 401 时，现有 H5 SDK 通过 BFF 携带原 `session_id` 申请新码，在同一个游戏窗口里换取新 Bearer。不会自动重放失败写操作；概率 spin、房间动作和资金未知结果仍使用其原业务号与原会话恢复。关闭页面也不会撤销已受理责任。对接 SDK 的具体调用见[宿主说明](examples/partner-host/README.md#宿主-sdk-用法)。

竞技多人试玩需要分别映射不同的已认证测试用户。此固定单用户 BFF 不提供任意切用户入口；可使用另一份固定身份配置和不同宿主端口并登记对应 origin，或由合作方实现自己的测试登录。免费练习明确标识 BOT、无入场费；付费房间不放 BOT。

## 7. 运行八项真实检查

在专用 App 接入台点击“运行沙箱检查”。执行期间不要用这两个测试用户做其他游戏或消费。要求 App 启用、三消授权开启、两个测试用户均无活动房间且冻结额为零。每人使用 **100 测试币 = 10000 最小单位**，总奖池 200 币；第二位退出，由第一位获胜，平台按房间冻结费率结算。默认 5% 时费用 10 币，赢家毛派彩 190 币，赢家可用余额净增 90 币、第二位净减 100 币。

| 顺序 / 报告 key | 实际执行与通过条件 |
|---|---|
| 1 `catalog` | 签名读取游戏目录，核对 App/partner 范围，确认三消可用 |
| 2 `balances` | 签名查询两个用户，记录原余额，确认各至少 100 币可用且冻结为零 |
| 3 `launch` | 对每款授权可用游戏创建并兑换启动码，再次兑换必须被拒绝；保存逐游戏进度 |
| 4 `scope` | 用本 App 的签名请求伪造 App 范围，必须被拒绝 |
| 5 `cancel` | 创建未成局房间后取消，等原房间确认取消，两个余额保持原值；此项不是捕获后的退款测试 |
| 6 `settlement` | 两人入场、准备、真实冻结与捕获，第二人退出；等原局结算后核对冻结费用、派彩和双方可用余额 |
| 7 `replay` | 用原始正文和原操作号把 capture、settle 各重复 10 次，确认原凭据及余额不变；当前为顺序重发，不声称并发压测 |
| 8 `query` | 按原结算操作号分别向平台与钱包查单，核对成功状态、正文摘要和结果 hash |

这八项不会把十三款游戏都玩到终局：第 3 项验证十三款的启动授权，第 6 项资金样例仅使用三消，并明确通过第二人退出产生胜负。它也不等同于[完整目标验收十项](integration-guide.md#6-十条自动验收用例--acceptance-suite-specification)。

报告保存在平台数据库，可以刷新后查看并下载 JSON。状态含义：

- `QUEUED` / `RUNNING`：已受理或仍在检查/查单/退避；不是资金失败，也不是已通过。
- `PASSED`：八项实际断言均通过，仅证明这一轮本地接口链路。
- `FAILED`：明确拒绝或断言不符。先核对报告内原房间、原操作和钱包终态，再决定是否发起新检查。

超时、未知响应、5xx 和 429 保留 `RUNNING`、原任务号、原房间号和原资金操作号。服务重启后扫描恢复，网络重试退避逐步增加到 30 秒，429 等待 65 秒；逐游戏进度已持久化。UI 继续轮询并禁止同时新开检查。同一个检查请求号只对应原任务，不能通过重复提交绕过 `next_attempt_at`。

若页面提交响应丢失，先刷新读回任务；不要不断创建新 request ID。程序调用者应在 POST 前保存 `request_id`，未知时同号同正文重试。遇到长期 `RUNNING`，查看 `error_code`、`artifacts.current_step`、`next_attempt_at` 以及原局状态，不删除未决记录。长中断可能使原局依据游戏规则作废；检查会据真实终态判定，不能因此伪造通过。

## 8. 管理 API 与排障

合作方 Cookie 登录的 UI 端点如下；这些不是给 App 包保存管理密码后直接调用的游戏接口。所有写请求须来自平台管理台 origin，后端始终校验账号所属 `partner_id` 与 App。

| 路径 | 用途 |
|---|---|
| `POST /api/partner/login`、`GET /api/partner/session`、`POST /api/partner/logout` | 独立合作方登录会话 |
| `GET/POST /api/partner/apps`、`GET/PATCH /api/partner/apps/:id` | 自身 App 列表、创建、名称/启停/游戏开关 |
| `GET /api/partner/apps/:id/integration` | 公开 scope、origin、钱包绑定状态和检查记录，无 secret |
| `POST .../integration/origins` | `{allowed_origins:[...]}` |
| `POST .../integration/wallet` | `{wallet_url,wallet_key_id,wallet_secret_base64}`，一次性绑定 |
| `POST .../integration/probe` | `{external_user_id:"demo_player"}`，只读签名余额探测 |
| `POST .../integration/checks` | `{request_id,confirm_sandbox_wallet:true}`，真实测试账务 |
| `GET .../integration/checks` | 当前 App 的历史报告 |

常见错误：`WALLET_ORIGIN_NOT_ALLOWED` 先请部署方核对 API 进程允许列表；`WALLET_BINDING_REQUIRES_PAUSED_SANDBOX` 先暂停新 App；`WALLET_BINDING_HAS_ACTIVITY` 必须另建 App；`WALLET_ALREADY_BOUND` 刷新核对现有绑定；`TEST_USERS_BUSY` 先恢复原房间；`TEST_BALANCE_NOT_READY` 在独立测试钱包中核对余额与预约状态，不能仅以刷新网页代替账本处理；`HOST_ORIGIN_FORBIDDEN` 核对 BFF 的 host_origin 和 App 登记值是否逐字匹配。

资金查单从合作方后端使用 `client.match(matchId)`、`client.operation(operationId)`。余额由合作方自己的可信后端读取。所有金额按字符串最小单位处理；未知响应不换号补发，不根据胜利动画、宿主消息或 HTTP 接收成功自行再派奖。

## 9. 交付范围与后续验收

已提供可运行的独立账号、App 隔离、一次性钱包绑定、独立数据库参考钱包、Node BFF、跨来源 H5 SDK 和上述真实检查流程。原两款概率与十款竞技继续使用已有权威资金流程。独立钱包示例复用参考协议实现，不代表已对接合作方现有送礼、转赠或提现系统。

仍需分别完成：外部合作方人员按本文独立接入的实际记录；原生 Android/iOS WebView 桥与真机画质/性能/音频；公网 TLS、真实设施及区域链路；生产身份登录、细分组织权限、密码恢复、多因素认证与密钥轮换；事件投递、对账告警、容量/容灾与生产发布流程。现有本地测试和 H5 示例不能替代这些验收。

验证证据应附执行时间、代码版本、隔离数据库/环境、原 App/局单/操作号及脱敏报告。代码或文档更新、构建通过、浏览器截图均不单独构成生产准入结论。
