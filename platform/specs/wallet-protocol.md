# 主钱包协议 V1 · 阶段 A 契约候选

> 阶段 B 更新：本地平台 API 与参考钱包已实现部分契约，并接入两款概率游戏。可运行命令、接口实现矩阵和限制以 [本地沙箱接入教程](phase-b-local-integration.md) 为准。下文保留完整目标协议及生产验收要求，尚未实现部分不代表已上线。
日期：2026-09-18。状态：**目标契约；本地参考钱包、平台沙箱与 Node SDK 已实现，生产部署未开放**。本文的 MUST 为后续实现与验收要求，不代表现有演示游戏具备这些能力。机器契约：[openapi.json](openapi.json)；合作方教程：[integration-guide.md](integration-guide.md)。批准的产品范围为 10 款竞技游戏和 thunder、tiger 两款概率游戏。

## 1. 责任与范围

合作方 App 主钱包是唯一可花余额主账。游戏平台管理对局、固定结果、钱包操作、对账镜像和审计，不保存另一份可独立消费的余额。主钱包的送礼、转赠、游戏冻结必须使用同一原子余额约束。

资源完整范围为 `(partner_id, app_id, environment, wallet_scope_id, currency_id)`，用户再加 `external_user_id`。`environment` 为 sandbox 或 production。密钥记录决定可信 partner/app/environment，不能由客户端或请求正文覆盖；正文范围不一致返回 403。首期一局只能使用同一完整范围，不跨 App 组局、不混币。GET 的 partner/app/environment 来自已验证的密钥，其余范围在路径中给出。

平台端 API 由合作方服务端调用；合作方钱包端 API 由平台服务端调用。OpenAPI 各路径明确标注独立 server，`.invalid` 域名全部为文档占位。两方向分别使用不同 HMAC 密钥；沙箱与生产不共享任何密钥、余额或业务号空间。

## 2. 金额、费用与守恒

所有金额为**非负整数最小单位的十进制字符串**，格式 `0|[1-9][0-9]*`，最大 9223372036854775807；拒绝负数、浮点数、指数、前导零。每个币种固定 `currency_scale`，V1 示例为 2，即 `10000` 表示 100.00 币。API 中不得用 JavaScript Number 计算金额；使用 BigInt 或数据库整数/十进制。

费率用整数基点 `fee_bps`，5% = 500。`fee_minor = floor(total_entry_minor * fee_bps / 10000)`；`prize_pool_minor = total_entry_minor - fee_minor`。只做一次总奖池向下取整。进入前锁定 fee_bps、entry_minor、rule_version、payout_template_version 和参赛座位；赛中不得变更。

个人第一名获得全部可分配奖池；2v2 获胜队员均分。玩家加入该次成局尝试并发起首次冻结之前，由平台随机分配并冻结连续的 `seat_index`（0 到人数减 1；2v2 保持对座队伍约束）。并列均分相应奖项，仅对有奖者按已冻结的 `seat_index` 升序分配余数，每人至多额外一个最小单位，不另传独立排列字段。座位排序只分零头，不能把并列按用户 ID、座位或请求先后判成单独胜者。这个规则入场前展示，平台与钱包可独立复算。`SettleMatch` 按玩家和座位唯一列出全体捕获名单（失败者 payout 为 0，作废退款省略 rank）；费用进入该范围预配置的费用账户，调用者不能提供任意收款账户。

| 示例（scale=2） | 捕获总额 | 服务费 | 玩家奖励 |
|---|---:|---:|---:|
| 2 人各 100 币，5% | 20000 | 1000 | 胜者 19000，败者 0 |
| 4 人各 100 币，5% | 40000 | 2000 | 冠军 38000，或胜队每人 19000 |
| 比赛作废 | 原捕获总额 | 0 | 每人全额退回自己的入场额 |

**奖励含本金。** A/B 初始各 1000 币，A 胜后的余额为 A=1090、B=900、费用账户=10。正常局 `捕获总额 = 全体派奖 + 服务费`；作废局 `捕获总额 = 全体退款`。服务费金币不直接等于平台现金收入。

## 3. 标识与持久化幂等

- `request_id` 标识一次请求所承载的业务意图；有该正文字段的写 API 必须与签名头 X-GP-Request-Id 相同。对 Reserve、CaptureMatch、ReleaseMatch、SettleMatch、AuthorizeProbability、AcceptProbability、CancelProbability、SettleProbability 这八类钱包资金命令，`operation_id = request_id`，所有命令 MUST 含 request_id。事件通知另遵循 `request_id = event_id`，事件中的 `operation_id` 引用原资金命令，不能要求与事件 ID 相等。
- 钱包资金命令在独立命令表的唯一约束为 `(partner_id, app_id, environment, request_id)`，涵盖上述八类命令；同号换命令路径也冲突。事件通知使用独立接收表及 `(partner_id, app_id, environment, event_id)` 去重空间，不与命令表混用。相同业务号、方法、规范路径及原始 body 的 SHA-256 返回原结果；任何差异返回 `IDEMPOTENCY_CONFLICT`。重试保留原始 body 字节，重新生成传输 nonce/timestamp/signature。
- 业务幂等记录、余额分录及操作结果必须在同一数据库事务持久化；不得仅放 Redis 或短期缓存。记录不得因业务重试窗口结束而删除；归档仍须能识别业务号及返回最终凭据。
- 每个 `match_id` 只可捕获一次、最终结算一次；`reservation_id` 不可转移到别局；每个 `cycle_id` 只可授权、受理、最终结算一次。换 request_id 不能绕过这些第二层唯一约束。
- `round_id` 与 `cycle_id` 不混用：概率完整付费周期含一次投注及触发的全部免费转/重转；子转可有自己的动画/动作 ID，但不能重复投注或重新选择数学版本。
- 操作状态为 `PENDING → SUCCEEDED | REJECTED`。已确认的终态不回退。`UNKNOWN` 是调用方观察到超时后的本地状态，**不是“未发生”**；未知时用原 operation_id 查单。

## 4. PvP 冻结、捕获与结算

状态：`WAITING → RESERVING → READY → CAPTURE_PENDING → ACTIVE → RESULT_FIXED → SETTLEMENT_PENDING → SETTLED`；未开局可走 `CANCEL_PENDING → CANCELLED`，已捕获但无法有效开局/完成走 `VOID_PENDING → VOIDED`。断线或主动退出按玩法规则处理，不自动触发退款。

1. 平台固定比赛 ID、座位、规则、入场额、费率和预期过期时间。每次 `Reserve` 携带结构化 `terms`（游戏/规则/分奖版本、费率、入场额、人数、队伍大小）；首次写入比赛经济快照，其后按类型化字段逐项比较一致。在同一事务中验证范围、余额、比赛取消墓碑，冻结一个玩家的入场额；冻结后可用余额立即减少，送礼不能消费这部分金币。默认预约有效期 120 秒，capture 不得使用已过期预约。
2. 全员冻结后 `CaptureMatch` 提交完整预约清单、座位和规则/费用快照。钱包对比赛与全部预约加事务锁，检查均为有效 RESERVED，同范围且玩家/金额一致，然后**全部捕获或全部不捕获**，建立该比赛奖池。只有查询到捕获 SUCCEEDED 才进入 ACTIVE；不能先玩后补扣。
3. 平台服务端持久化胜负、排名、分奖明细和 `result_hash` 后发送 `SettleMatch`。钱包在一笔事务中校验比赛未结算、所有玩家属于捕获名单、总额守恒、费率及分奖模板一致，并同时写入全部奖励和费用。不能逐个玩家调用 credit。操作未确认期间显示“结果已确定，奖励到账中”。
4. `resolution=void` 时要求 `fee_minor=0`，每位捕获玩家 payout 等于原入场额；原因写入审计。结果已结算后不能用新的结算请求改写，财务纠错另建带审批的补偿分录，V1 普通合作方 API 不暴露任意调账。

`CaptureMatch` 与 `SettleMatch` 是同一合作方钱包内的数据库原子操作，不声称平台数据库与合作方数据库构成分布式原子事务。平台通过事务消息表、持久化操作、原号查单和对账恢复。

### 取消墓碑与乱序

`ReleaseMatch` 的语义为**关闭整场未捕获比赛并释放其中所有预约**，不是只释放请求已知的某一张预约。钱包先按 match_id 持久化 CANCELLED 墓碑，再释放全部冻结；即使原 Reserve 尚未到达，也返回成功墓碑。任何迟到 Reserve/Capture 对该 match_id 均返回 `CANCELLED_TOMBSTONE`，不得重新冻结或扣款。

Capture 与 Release 在同一比赛锁下竞争：Release 先成功则 capture 永不能成功；Capture 先成功则 release 返回 `ALREADY_CAPTURED` 且不能释放捕获资金，平台查明状态后按需要执行 void 结算。取消等待超时也必须查单，不能在客户端提前确认退款。

过期预约由钱包原子标记 EXPIRED 并释放，可查单；Capture 与过期也在同一锁定边界串行化。已捕获资金不存在预约 TTL 自动退款。退出一个待开局房间在 V1 关闭该次成局尝试，其余人重新匹配使用新 match_id。

## 5. 概率完整周期授权

概率资金不来自 PvP 奖池。合作方为范围配置独立派彩准备金账户和硬额度。每个发布数学版本必须有可证明的**完整付费周期最高总派奖**；含所有免费转、重转以及额外触发。没有有限且可信上限的版本不能发布。

状态：`AUTHORIZING → AUTHORIZED → ACCEPT_PENDING → ACCEPTED → RESULT_FIXED → SETTLEMENT_PENDING → SETTLED`。接受前可 `CANCELLED/EXPIRED`；ACCEPTED 后不得因额度、开奖结果、停用 App 或玩家退出而取消责任。

1. `AuthorizeProbability` 在一个钱包事务中冻结玩家 stake，并从准备金冻结 `max_payout_minor` 的**毛派奖责任**，不能只冻结净输赢或预期 RTP 差额。绑定 cycle_id、game_id、math_version、math_config_hash、stake 和最高派奖；授权默认 60 秒内受理有效。
2. 平台确认授权后调用 `AcceptProbability`。钱包对授权加锁并检查未过期、未取消，永久固定受理凭据，把冻结转为不自动过期的履约责任；ACCEPT 与取消/过期必须原子互斥。**在受理 SUCCEEDED 被确认之前，不得开奖、给出结果或启动可计费旋转。** 受理成功但响应丢失时查原 operation/authorization 恢复，不重发新周期。
3. 平台将受理凭据落库后由服务端随机源生成并持久化该周期结果/种子、数学版本及动作顺序。一个周期只固定一次；重试、重新连接与进程恢复读取已固定结果，不能重抽。客户端仅播放合法动作及演出。
4. `SettleProbability` 使用原 cycle_id、authorization_id、math_version、result_hash、stake 及整个周期 gross_payout，原子完成投注扣款、玩家派奖、准备金收支和剩余责任释放。玩家 `余额增量 = gross_payout - stake`；准备金 `增量 = stake - gross_payout`。gross_payout 包含返还本金，且必须 ≤ 已授权的 max_payout。
5. 已受理周期不能因为当时剩余“可用预算”不足而被拒赔，因为最大责任已经冻结。修改预算、RTP、上下架只影响新周期；冻结责任持续有效。协议结构错误须人工修复同一业务状态，不能重新开奖。钱包临时不可用进入处理中并持续恢复，既不按输局处理，也不擅自退款抹掉中奖。

`CancelProbabilityAuthorization` 只用于尚未 ACCEPTED 的授权，也以 cycle_id 创建取消墓碑，阻止迟到的 Authorize/Accept。已受理返回 `ALREADY_ACCEPTED`；不得提供“看过结果再取消”的接口。免费转/重转不需要新资金授权，也不能换数学版本。完整周期派彩结算与 UI 呈现可以分离，但客户端展示“到账/完成”前必须收到已结算凭据。

## 6. 超时、事件、恢复

建议单次请求超时 3 秒；这是候选 SLA，需要阶段 B 根据部署区域实测。网络超时、连接断开、502/503、不可解析响应都进入 UNKNOWN。首先查原 operation_id；PENDING 则退避查单，SUCCEEDED 使用原凭据，REJECTED 才处理明确拒绝。404 NOT_FOUND 仅表示此时没有记录，**不能证明仍在网络中的原请求不会到达**：仍按原号重试，若取消则使用上文墓碑屏障。

有限快速重试后转后台恢复队列，不给“换个业务号再试”的按钮。退避建议 1、2、4、8、16、30 秒并带抖动，之后每 60 秒查单；超 5 分钟告警并显示处理中，操作不自动丢弃。运维可暂停新局，不能删掉未决账务。

事件回调只通知展示与统计，**不能据此再扣款或派奖**。事件含 request_id、event_id、type、aggregate_id、aggregate_version、occurred_at、scope、operation_id、trace_id。事件的 `request_id = event_id = X-GP-Request-Id`；`operation_id` 引用原资金命令，不是本次通知的 ID，同一命令可产生多个不同 event_id 的状态通知。接收方使用独立事件接收表，按 `(partner_id, app_id, environment, event_id)` 原子保存后返回 204；同事件同原始 body 去重，同事件 ID 异 body 拒绝；乱序只采纳更高 aggregate_version；事件延迟或丢失时用 GET operation/match/authorization 查询权威状态。发送侧使用事务消息表并重试，超过告警阈值仍保留可查询记录。

对账至少逐日比较投注/捕获/派奖/退款/费用与未决操作，且持续扫描长时间 PENDING。必须能够按 scope、request_id、match_id/cycle_id、result_hash 定位。审计记录保存角色、原因、版本、时间和 trace_id；日志不写秘密密钥、完整启动码或访问令牌。

## 7. 接口责任表

| 平台提供（合作方调用） | 合作方提供（平台调用） |
|---|---|
| 创建会话、一次码兑换、游戏目录 | 余额查询 |
| 查询平台操作及比赛状态 | Reserve、CaptureMatch、ReleaseMatch、SettleMatch |
| 安全范围内的结果和对账凭据 | 概率授权、受理、接受前取消、完整周期结算 |
| SDK 宿主事件约定 | operation/match/authorization 查单与事件接收 |

精确路径、必填字段、枚举及示例见 [openapi.json](openapi.json)。数据库主键、持久化事务、隔离和公平性要求不能由 OpenAPI schema 独自保证，必须按接入验收用例验证。
