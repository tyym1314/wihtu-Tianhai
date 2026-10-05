# OASIS Game Platform

移动社交 App 的独立游戏平台。本地沙箱已接真实 PostgreSQL、管理 API、合作方参考钱包，目前共 10 款竞技 + 2 款概率游戏。阶段 F（v0.6）加入独立合作方账号、受限自助接入台、独立钱包绑定、Node BFF、H5 SDK 与八项真实接口检查。当前尚未作为生产产品发布；外部合作方人员独立接入、原生真机及生产环境仍需分别验收。

## 本地运行

```sh
cd platform
npm ci
npm run db:start
npm run build:legacy
npm run build:arena
npm run server
# 另一个终端
npm run dev
```

- 管理端：http://127.0.0.1:8795
- 平台 API：8797；参考合作方钱包：8798
- 新建的独立 PostgreSQL：127.0.0.1:5487；不修改已有 5432 服务
- 账号：首次启动生成到 `.local/development-credentials.json`，不要提交或发布
- 原演示 8787 / 8790 保留；跑酷技术灰盒在 `spikes/`，8796

管理端可实际创建沙箱 App、保存游戏授权/启停/数学档位、保存竞技服务费、通过一次性会话启动十二款游戏、查看持久化局单/操作/审计。浏览器只拿游戏会话，不持有钱包密钥。每个概率游戏付费周期先冻结毛派彩责任、受理、固定完整结果，再原子结算；免费转演出和 ack 不再次入账。

`.local/master.key` 与数据库一起备份。本地数据库默认仅 loopback trust；它不是生产部署配置。阶段 F 已实现管理员与合作方两类账号、partner/App 数据隔离和精确允许列表内的钱包一次性绑定；组织内细分 RBAC、生产入口、完整发布、密钥轮换及事件投递/告警仍待建设。不能因为 OpenAPI 列出某接口就认定已实现。

合作方从[阶段 F 自接入教程](specs/phase-f-self-integration.md)开始：创建全新专用 App 后先暂停，在产生任何会话或账务记录前绑定独立钱包。部署方先配置 `OASIS_WALLET_ALLOWED_ORIGINS`；独立钱包使用不同 PostgreSQL 数据库和权限 `0600` 的私有配置，钱包与平台调用方向使用不同密钥。不要直接迁移已有 App 的钱包或演示余额。

## 文档

- [阶段 F 合作方自接入教程](specs/phase-f-self-integration.md)
- [阶段 F 交付与验证](specs/phase-f-delivery.md) / [本机运行与恢复](specs/phase-f-operations.md)
- [可独立运行的合作方示例包](public/downloads/oasis-partner-sandbox-kit.zip)（`npm run build:partner-kit` 可重建）
- [独立钱包示例](examples/partner-wallet/README.md) / [独立 H5 宿主与 Node BFF](specs/examples/partner-host/README.md)
- [阶段 E 运动与竞速接入](specs/phase-e-local-integration.md)
- [阶段 E 交付与验证](specs/phase-e-delivery.md)
- [阶段 D 桌游与2v2接入](specs/phase-d-local-integration.md)
- [阶段 D 交付与验证](specs/phase-d-delivery.md)
- [阶段 C 多人游戏接入与试玩](specs/phase-c-local-integration.md)
- [阶段 C 交付与验证](specs/phase-c-delivery.md)

- [阶段 B 概率游戏接入与实现矩阵](specs/phase-b-local-integration.md)
- [阶段 B 本地联调交付](specs/phase-b-delivery.md)
- [数学统计报告](specs/math-validation.md)
- [钱包目标协议](specs/wallet-protocol.md) / [参考钱包说明](specs/reference-wallet-notes.md)
- [OpenAPI 3.1](specs/openapi.json) / [无依赖 Node SDK](specs/examples/sdk-node.mjs)
- [10款竞技规则](specs/game-rules-v1.md) / [美术制作计划](specs/asset-production-plan.md)
- [阶段 A 历史交付](specs/phase-a-delivery.md) / [跑酷技术灰盒](spikes/README.md)

## 验证

```sh
npm run test:backend
npm run check:contracts
npm run partner:smoke
npm run build
node scripts/review-phase-b-ui.mjs
node scripts/review-phase-c-ui.mjs
node scripts/review-phase-c-practice.mjs
node scripts/review-phase-d-ui.mjs
node scripts/review-phase-d-gallery.mjs
node scripts/review-phase-e-ui.mjs
node scripts/review-phase-e-gallery.mjs
```

`test:backend` 包含数学边界、真实 PostgreSQL 钱包并发和 HTTP/重启恢复测试。平台 API 与 PvP 集成测试建立临时隔离数据库，并在结束后删除测试库。钱包单项测试使用独立随机 partner/scope，默认在本机开发库写入并保留测试记录；可通过 `DATABASE_URL` 指定其他数据库，不重置已有演示用户。UI 检查使用本机 Chrome，覆盖登录、持久化、移动布局、实际 spin/ack 与错误呈现。

98/99 是带版本的沙箱数学目标。各1000万完整周期报告见 `review/math-*.json`；不是第三方认证。Thunder 平台版本新增100免费转、10000倍完整周期上限；原独立演示数学不改。旧资源通过 `build:legacy` 拷贝到 `.local/legacy-src` 再做平台适配，不编辑原游戏源码。

十款竞技游戏使用服务端动作与结果，竞技钱款按 reserve → capture → settle 执行；不允许客户端提交分数。免费练习明确标识 BOT，入场和服务费为零，离开立即结束练习。付费房间没有 BOT，对局条款在创建房间时冻结。三消角色为分层图片动画；高尔夫、保龄球、竞速使用实际 Three.js 3D；其余桌游与飞镖采用 Canvas/SVG/CSS 表现。保龄球的服务端刚体物理使用根目录锁定的 cannon-es 0.20.0，正常 `npm ci` 即可安装，无嵌套依赖目录。

阶段 E UI 脚本使用专用 `QA UI` 沙箱应用及其中四个演示账号；会产生练习、入场和结算记录。准备步骤见阶段 E 接入文档，不应指向生产环境。录像不包含音轨，音频信号和静音状态另外检查。

阶段 F 接入台的八项检查会用 `demo_player` 与 `demo_player_2` 各 100 测试币完成一局三消，并按冻结费率实际结算；只对专用沙箱 App 运行。网络超时与限流保留 `RUNNING` 和原业务号，服务恢复后继续查单，不等于通过或失败。报告只描述本次本地接口检查；开发者中心另外保留的“五场景流程”仍是浏览器演示。
