# AGENTS.md — OASIS 游戏平台

## 产品与线上形态（2026-10-15）

- 正式入口：`https://game.tianyahuyu.com`（管理台/合作方工作台 `/`，游戏 `/play/<id>`，原生启动页 `/launch/`，H5 SDK `/sdk/oasis-h5.mjs`，文档 `/specs/*.md`）。
- 旧域名 `oasis-player.43.98.202.236.sslip.io`、`oasis.43.98.202.236.sslip.io` 均 301 到正式入口。
- 第三方 App 接入模式：**接入方账号 + 接入方自有钱包**。接入方后端 HMAC 调 `POST /v1/sessions`，客户端打开 `/launch/?game=<id>&lang=..#code=..&session=..`。钱包只有一种协议 **simple-v1**：接入方实现 查余额 / 扣款 / 加款 3 个接口（按 request_id 幂等）。指南：`platform/specs/partner-integration-production.md`。
- 第一方 App（`app_e091fb5daf135660d39ce89fc23760ab`，平台账号+平台内部金币）仍保留，供 `platform/android-player` 的 APK 使用。
- 演示合作方：`https://partner-demo.43.98.202.236.sslip.io`（`platform/examples/partner-demo/server.mjs` + `simple-wallet.mjs`：simple-v1 参考钱包 + 签名后端，独立数据库 `oasis_demo_partner_wallet`）。合作方账号 `demo.partner`，当前 App `app_5728f902c7950b3460706f9971141217`（旧的完整协议 App 已停用）；凭据在被忽略的 `platform/.local/demo-partner/`。
- 管理员：`tyym`（另有原 `operator`）。

## 代码结构要点

- `platform/server/production-admission.mjs`：生产准入。`OASIS_PARTNER_ADMISSION=1` 时，非第一方的生产 App（已绑定 HTTPS 外部钱包且启用）可用 HMAC 会话、付费房与概率游戏（`partner-external-v1`）。第一方 App 走 `firstparty-*` profile。
- `platform/server/platform.mjs#createSession`：`hosted`（第一方 BFF 玩家）与合作方 HMAC 会话两条路径。
- `platform/server/wallet-binding.mjs`：外部钱包调用（单次 DNS、只允许公网地址、3s 超时）。测试可用 `setWalletTransportForTests`。生产绑定外部钱包即 `provider='simple'`。
- `platform/server/simple-wallet.mjs`：simple-v1 适配层。平台内部账本承担冻结/扣款/释放/结算/概率责任；入场或投注先向接入方扣款（in 腿）再进内部账本，退款/派奖从内部账本经接入方加款（out 腿）返还；后台每 3 秒补查不确定的扣款、重试加款、回收滞留中转余额。表 `gp_simple_wallet_legs`。不变量：接入方 App 的内部 `wallet_users` 可用+冻结在对局结束后应归零。
- 前端：`platform/arena`（11 款竞技，React + Three/Canvas），`src/` + `platform/legacy`（雷霆/虎虎）。管理台 `platform/src`。
- 多语言（zh/en/ar）：竞技游戏界面文案以中文为源，用 `$t('中文')`（`arena/shared/i18n.mjs`）翻译，词典 `arena/shared/i18n-dict.mjs`（[英文, 阿语]）。新增中文文案后运行 `node scripts/i18n-codemod.mjs --write` 自动包裹、补词典，再跑 `node scripts/i18n-check.mjs`（防止局部变量遮蔽 `$t`）。语言来源：`/v1/sessions` 的 `locale` → 会话 → 游戏；`/launch/?lang=` 写入 `localStorage.oasis-locale`。阿语只对大厅/结果/弹窗设 RTL。雷霆/虎虎沿用各自词典，换码后按会话语言写入其偏好。
- 快速匹配：`POST /api/pvp/matchmaking`（同 App/游戏/人数/入场费撮合，`pvp_rooms.matchmaking`，等待 120 秒）；匹配房客户端自动就绪，未满员离开只释放座位。
- 线上冒烟：`node platform/scripts/i18n-smoke.mjs all zh,en,ar`（经演示合作方开每款免费练习，检查报错与残留中文）。

## 娱乐场游戏（复刻百顺/小游的概率游戏）

- 定义：`platform/shared/casino-games.mjs`（`family`：wheel 转盘 / crash 爆点 / cards3 三家比牌 / slot 老虎机；`kind:'instant'` 为单人即时游戏）。新增游戏还要加到 `specs/openapi.json` 的 `GameId`/`ProbabilityGameId` 与 `public/launch/index.html` 的 `GAMES`（`tests/casino-games.test.mjs` 会检查）。
- 街机射击（Monster、MoleStar）：`server/casino/arcade.mjs`，一次开局 = 一个钱包周期（买弹 → 服务端逐发判定 → 结束时结算赢得 + 退回未用弹药，闲置 2 分钟自动结算）；每发返还率固定，瞄准哪个目标只影响波动。
- 参考资料补抓：手机游戏页有防截屏，可直接解析 Cocos 资源包的 `text/<语言>` 文本（见 `.local/reference/rules/<游戏>/*.json`）。
- 服务端：`server/casino/`。`rounds.mjs` 共享回合（每个 App 每款游戏一条连续回合，承诺/揭示种子；每注一个钱包概率周期：下注时 authorize+accept，开奖后 settle）；`instant.mjs` 单人旋转（一次付费旋转含全部免费旋转 = 一个周期）。数学：`wheel.mjs`、`crash.mjs`、`cards3.mjs`、`slots.mjs`。接口：`GET /api/casino/state`、`POST /api/casino/bets|cashout|spin`。
- 只对三方 App 与沙箱开放（`ALL_GAME_IDS`）；第一方 13 款（`RELEASED_IDS`）不变；生产启动时自动给三方 App 补上新游戏。
- 命名：游戏名与 ID 沿用参考游戏（如 `greedylion` GreedyLion、`rocketstar2` RocketStar2、`teenpatti` TeenPatti、`olympus` Olympus）；改名后服务启动会自动从各 App 的 `game_ids` 去掉已不存在的 ID。
- 界面标准（用户要求）：**原样还原效果图**。做法：效果图放 `.local/concepts/`，用 `codex exec "<编辑说明>" -i concept.png` 生成去掉动态内容（数字、头像、卡牌、符号等）的干净底图 `.local/art/<game>-plate/plate.png`（尺寸 941x1672），前端用 `casino/shared/Stage.jsx` 按设计像素把实时数据/热区/动效叠加在底图空位上；需要单独动的元素（火箭等）同样用编辑从效果图里抠出。
- 转盘类（Greedy 系列）共用 `casino/games/wheel/WheelGame.jsx`：每款只需在 `layouts.mjs` 写底图上的设计像素坐标（下注区、计时、余额、榜单、筹码、记录条等），`node scripts/casino-icons.mjs <game>` 从底图生成 `plate.webp` 与各选项图标，`casino/main.jsx` 注册到 `Wheel`；规则文字由 `casino/shared/rules.mjs` 按游戏定义自动生成（新选项要补 `NAMES` 中/阿译名）。
- 其他前端：牌桌 `casino/games/table/`（轮盘号码圈由 SVG 按欧式真实顺序绘制，骰盅抠图）、爆点单面板 `casino/games/crash/`、街机 `casino/games/arcade/`（`shared/useArcade.js`：首发按 50 发买弹，打完/换注/离开结算）、连线/路数老虎机 `casino/games/slot/`（`layouts.mjs` 只需写盘面窗口和按钮坐标）。
- 老虎机美术流水线：`.local/slots/gen.sh <game> "<效果图提示>" "<底图去除项>" "<符号列表>"` 生成 效果图 + 空盘面底图 + 透明符号表；符号表用 `.local/slots/slicer2.py`（`DIL=0|1|2` 调连通距离）连通域切图（按权重 key 顺序命名到 `casino/public/<game>/<symbol>.webp`）。稀有特色玩法用真实引擎结果做前端验证（用种子搜索出触发特色的结果，Playwright 拦截 `/api/casino/spin|choose` 返回）。
- 音频：`node scripts/casino-audio.mjs`（CC0 来源见 `casino/public/audio/LICENSES.md`，原始文件在 `.local/audio/`）；前端 `casino/shared/audio.mjs` 的 `useAudio(game)`。每款都要有背景音乐和音效。
- 前端：`platform/casino/`（React，`/play/<id>` → `casino/dist`），`npm run build:casino`。界面按 `.local/concepts/` 效果图还原，按钮/Logo/柱子等界面素材也用生图生成（如 `.local/art/olympus-ui/`，手动 `cwebp` 到 `casino/public/olympus/`）。
- 美术：`scripts/casino-art.sh <输出目录> <名称> <提示词>` 调本机 Codex CLI 生图（ChatGPT 账号），原图放 `.local/art/<game>/`；`node scripts/casino-assets.mjs <game> [名称:宽度]` 转 WebP 到 `casino/public/<game>/`。
- 老虎机返还率：`node scripts/casino-slot-sim.mjs <game> 1000000`（anywhere 消除类，高波动需多次百万局取均值）；连线/路数类用 `node scripts/casino-lines-sim.mjs <game> 500000`，按输出的 `pay_scale_for_target` 调 `slot.payScale`。
- 新游戏先以 `released` 缺省（不发布）加入定义，服务端/数学/测试先做，界面完成后再设 `released:true`；测试里用 `process.env.OASIS_CASINO_PREVIEW='test'` 可玩未发布游戏。新增定义后运行 `node scripts/sync-casino-enums.mjs` 同步 OpenAPI 枚举。
- 参考资料（本地、不入库）：`.local/reference/`（`urls.json` 来自 withu 日志；`extract_all.py` 从公开资源提取规则文本/规则图集到 `rules/<游戏>/`；`shots/` 主界面截图）。
- 本地走查：`npm run db:start && npm run server && npm run dev`，然后 `node scripts/casino-local-e2e.mjs <game> zh`。

## 真机与压测（2026-10-18）

- 真机：手机 Chrome 打开演示合作方，`adb forward tcp:9334 localabstract:chrome_devtools_remote` 后用 Playwright `connectOverCDP` 逐款测加载、iframe 内帧率、背景音乐（`window.__casinoMusic`）。38 款加载 1.7–2.9 秒，游戏中 57–60 fps。
- 压测：`npx tsx scripts/casino-load-provision.mjs 320 && node scripts/casino-load.mjs <玩家数> <秒>`（本地沙箱，服务端需 `OASIS_RATE_EXCHANGE_IP_PER_MINUTE` 调大）。
- 容量：每个 App 的钱包账本按作用域串行（咨询锁 + 作用域行锁），simple-v1 下单个 App 约 35 次概率周期/秒（单次约 40ms）；约 150 名同时在玩的玩家/App 体验正常，300 名开始排队。不同 App 之间并行。
- 演示钱包测试账户余额可在 `oasis_demo_partner_wallet.demo_simple_accounts` 调整（记 `MANUAL_TOPUP` 交易），只影响演示合作方。

## 本地开发与验证

```sh
cd platform
npm run db:start                 # 本地 PG 127.0.0.1:5487
npm run test:release             # 全量后端测试（隔离临时库），应全部通过；run-practice-protocol-v2 在高负载下偶发超时，单独复跑即可
npx tsx --test tests/simple-wallet.integration.test.mjs   # 三方接入 + simple-v1 钱包端到端
npm run build:release            # 构建全部前端 + release-build-manifest.json
```

## 部署（务实流程）

服务器 `root@43.98.202.236`，密钥 `~/.ssh/hame_deploy.pem`。**同机还有其他业务（chatnaapp 等），只动 oasis 相关文件。**

1. 本地 `npm run build:release`，提交代码。
2. 服务器新建版本目录：`cp -a /opt/oasis/releases/<当前> /opt/oasis/releases/<YYYYMMDD-NN>`，再从本地 rsync `platform/{server,shared}`（--delete）以及 `legacy dist public specs scripts deploy examples casino` 与根 `src/`；`arena` 只同步 `dist/` 和代码文件（`--delete --delete-excluded --include 'dist/***' --include '*/' --include '*.mjs' --include '*.js' --include '*.jsx' --include '*.json' --exclude '*' --prune-empty-dirs`，原始美术约 650MB 不上线，否则磁盘告警）；部署后删除自己更早的版本，只保留上一版回滚；`chmod -R u=rwX,go=rX`。
3. 切换：改 `/etc/systemd/system/oasis-production-api.service` 的 `WorkingDirectory`，`ln -sfn` 更新 `/opt/oasis/production-current`，`systemctl daemon-reload && systemctl restart oasis-production-api oasis-partner-demo`。
4. 验证：`curl https://game.tianyahuyu.com/health`；`systemctl start oasis-production-instance-monitor` 后查看 `/opt/oasis/production-instance-private/monitor/status.json` 全部 ok。
5. 回滚：WorkingDirectory/软链指回上一版本目录并重启。

- 私有配置：`/opt/oasis/production-instance-private/runtime.env`（含 `OASIS_PUBLIC_ORIGIN`、`OASIS_PARTNER_ADMISSION=1`）。数据库容器 `oasis-production-postgres`（127.0.0.1:18893）。
- nginx/systemd 线上配置副本：`platform/deploy/production-game/`。改线上配置后同步回该目录。
- 备份：`/opt/oasis/production-backup.sh`（每日 timer，输出 `/opt/oasis/production-backups/<UTC>`；恢复需同时用 `database.dump` 和私有归档中的 `master.key`）。
- 证书：`oasis-certificate.timer` 运行 certbot renew（覆盖 `oasis-game`、`oasis-partner-demo`、`oasis-production-player` 等；原 `oasis-production-player-certificate.timer` 已停用）。partner-demo 的 80 端口 ACME 规则在共享容器 `proxy-nginx` 内（`/etc/nginx/conf.d/oasis-partner-demo-acme.conf`），容器重建后需从 `platform/deploy/production-game/proxy-nginx-oasis-partner-demo-acme.conf` 恢复。

## Android 真机测试

- 实体机 `46dcfd25`（Xiaomi，Android 16）。QA 包 `com.tianyahuyu.oasis.player.qa` 可 WebView 调试：
  `adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof com.tianyahuyu.oasis.player.qa)`，再用 CDP `Runtime.evaluate`。游戏在同源 iframe 内（`document.querySelector('iframe').contentDocument`）。
- 测 iframe 帧率时用 iframe 自己的 `w.performance.now()`（父页面与 iframe 时间原点不同）。
- 重建 APK：`./platform/android-player/build.sh --variant qa|release --origin https://game.tianyahuyu.com --app-id app_e091fb5daf135660d39ce89fc23760ab`（签名在被 git 忽略的 `.local/signing`，务必保留）。
- Chrome 调试：`adb forward tcp:9334 localabstract:chrome_devtools_remote`。

## 历史

`HANDOFF.md`、`ENGINE_AUDIT.md` 等为前任的详细证据记录，结论以本文件与线上实测为准。旧的 master 未提交改动保存在 `git stash`（`master-uncommitted-before-launch-20261015`）。
