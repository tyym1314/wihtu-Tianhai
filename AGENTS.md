# AGENTS.md — OASIS 游戏平台

## 产品与线上形态（2026-10-15）

- 平台名称：**Tianhai 游戏平台**（管理台、合作方工作台、接入文档）。游戏内不显示任何平台或 App 品牌（通用中性设计，竞技大厅为 “PLAY TOGETHER”；绿洲高尔夫改名“迷你高尔夫 / MINI GOLF”）。对外桥接名：Android `TianhaiApp`、iOS `tianhai`、返回 `window.TianhaiLauncher.requestBack()`、H5 SDK `/sdk/tianhai-h5.mjs`（`TianhaiHost`）；旧名 `OasisApp`/`oasis`/`OasisLauncher`/`oasis-h5.mjs` 仍兼容。内部代码、环境变量、服务名中的 oasis 不改。
- 加载页（`public/launch/index.html`，样式 B）：游戏图标 + 环形真实进度 + 三语提示，全屏/半屏自适应。数据 `public/launch/meta.json` 与图标 `public/launch/icons/<id>.webp` 由 `node scripts/launch-meta.mjs` 从 `.local/art/icons/<id>.png`（`node .local/art/icons/gen.mjs [id...]` 用各游戏效果图生成）生成。游戏经桥接发 `oasis.progress`（0–1）与 `oasis.shown`（第一帧已显示）驱动进度与淡出；雷霆/虎虎没有 shown，收到 loaded 后 1.2 秒淡出。新增游戏要补图标和 meta。
- 娱乐场图片/音频带内容版本号 `?v=<casino/dist/asset-version.txt>`，与当前版本一致时服务端返回一年 immutable 缓存。
- simple-v1 钱包地址可带基础路径（如 `https://api.x.com/callback/tianhai`）：平台请求 `基础路径 + /wallet/simple/v1/...`，签名覆盖完整路径（`walletBase()`）。
- 发布时被 `retained-assets.lock.json` 锁定的未带版本号的旧资源（如 `public/assets/*.png`）不能原地替换，新图要用新文件名。

- 正式入口：`https://game.tianyahuyu.com`（管理台/合作方工作台 `/`，游戏 `/play/<id>`，原生启动页 `/launch/`，H5 SDK `/sdk/oasis-h5.mjs`，文档 `/specs/*.md`）。
- 旧域名 `oasis-player.43.98.202.236.sslip.io`、`oasis.43.98.202.236.sslip.io` 均 301 到正式入口。
- 第三方 App 接入模式：**接入方账号 + 接入方自有钱包**。接入方后端 HMAC 调 `POST /v1/sessions`，客户端打开 `/launch/?game=<id>&lang=..#code=..&session=..`。钱包只有一种协议 **simple-v1**：接入方实现 查余额 / 扣款 / 加款 3 个接口（按 request_id 幂等）。指南：`platform/specs/partner-integration-production.md`。
- 第一方 App（平台账号、内部金币、`platform/android-player` APK、签名、玩家域名 `oasis-player…sslip.io`、旧转账协议）已于 2026-10-18 全部删除；生产 `OASIS_ADMISSION_PROFILE=closed` + `OASIS_PARTNER_ADMISSION=1`，只服务三方 App。
- 演示合作方已于 2026-10-18 彻底删除（账号、App、数据、演示站、证书、演示钱包库）。第三方真实接入（WithU）待添加。`platform/examples/partner-demo/` 仅作为接入示例代码保留在仓库。
- 管理员：`tyym`（另有原 `operator`）。

## 代码结构要点

- `platform/server/production-admission.mjs`：生产准入。只有三方 App（已绑定 HTTPS simple-v1 钱包且启用）可用 HMAC 会话、付费房与概率游戏（`partner-external-v1`）；配置里出现旧的第一方变量会拒绝启动（`FIRSTPARTY_CONFIG_REMOVED`）。
- `platform/server/platform.mjs#createSession`：只有合作方 HMAC 会话一条路径（平台托管玩家已删除）。
- `platform/server/wallet-binding.mjs`：外部钱包调用（单次 DNS、只允许公网地址、3s 超时）。测试可用 `setWalletTransportForTests`。生产绑定外部钱包即 `provider='simple'`。
- `platform/server/simple-wallet.mjs`：simple-v1 适配层。平台内部账本承担冻结/扣款/释放/结算/概率责任；入场或投注先向接入方扣款（in 腿）再进内部账本，退款/派奖从内部账本经接入方加款（out 腿）返还；后台每 3 秒补查不确定的扣款、重试加款、回收滞留中转余额。表 `gp_simple_wallet_legs`。不变量：接入方 App 的内部 `wallet_users` 可用+冻结在对局结束后应归零。
- 前端：`platform/arena`（11 款竞技，React + Three/Canvas），`src/` + `platform/legacy`（雷霆/虎虎）。管理台 `platform/src`。
- 多语言（zh/en/ar）：竞技游戏界面文案以中文为源，用 `$t('中文')`（`arena/shared/i18n.mjs`）翻译，词典 `arena/shared/i18n-dict.mjs`（[英文, 阿语]）。新增中文文案后运行 `node scripts/i18n-codemod.mjs --write` 自动包裹、补词典，再跑 `node scripts/i18n-check.mjs`（防止局部变量遮蔽 `$t`）。语言来源：`/v1/sessions` 的 `locale` → 会话 → 游戏；`/launch/?lang=` 写入 `localStorage.oasis-locale`。阿语只对大厅/结果/弹窗设 RTL。雷霆/虎虎沿用各自词典，换码后按会话语言写入其偏好。
- 快速匹配：`POST /api/pvp/matchmaking`（同 App/游戏/人数/入场费撮合，`pvp_rooms.matchmaking`，等待 120 秒）；匹配房客户端自动就绪，未满员离开只释放座位。
- 线上冒烟：`node platform/scripts/i18n-smoke.mjs all zh,en,ar`（原经演示合作方；现需先有一个已接入的三方 App）。

## 娱乐场游戏（复刻百顺/小游的概率游戏）

- 定义：`platform/shared/casino-games.mjs`（`family`：wheel 转盘 / crash 爆点 / cards3 三家比牌 / slot 老虎机；`kind:'instant'` 为单人即时游戏）。新增游戏还要加到 `specs/openapi.json` 的 `GameId`/`ProbabilityGameId` 与 `public/launch/index.html` 的 `GAMES`（`tests/casino-games.test.mjs` 会检查）。
- 街机射击（Monster、MoleStar）：`server/casino/arcade.mjs`，一次开局 = 一个钱包周期（买弹 → 服务端逐发判定 → 结束时结算赢得 + 退回未用弹药，闲置 2 分钟自动结算）；每发返还率固定，瞄准哪个目标只影响波动。
- 参考资料补抓：手机游戏页有防截屏，可直接解析 Cocos 资源包的 `text/<语言>` 文本（见 `.local/reference/rules/<游戏>/*.json`）。
- 服务端：`server/casino/`。`rounds.mjs` 共享回合（每个 App 每款游戏一条连续回合，承诺/揭示种子；每注一个钱包概率周期：下注时 authorize+accept，开奖后 settle）；`instant.mjs` 单人旋转（一次付费旋转含全部免费旋转 = 一个周期）。数学：`wheel.mjs`、`crash.mjs`、`cards3.mjs`、`slots.mjs`。接口：`GET /api/casino/state`、`POST /api/casino/bets|cashout|spin`。
- 只对三方 App 与沙箱开放（`ALL_GAME_IDS`）；生产启动时自动给三方 App 补上新游戏。
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

- 真机：手机 Chrome 打开三方 App 的游戏页（原用演示合作方），`adb forward tcp:9334 localabstract:chrome_devtools_remote` 后用 Playwright `connectOverCDP` 逐款测加载、iframe 内帧率、背景音乐（`window.__casinoMusic`）。38 款加载 1.7–2.9 秒，游戏中 57–60 fps。
- 压测：`npx tsx scripts/casino-load-provision.mjs 2100 && node scripts/casino-load.mjs <玩家数> <秒>`（多个进程用 `LOAD_OFFSET` 错开玩家号）。本地按生产方式跑：`OASIS_REFERENCE_WALLET_FAST=1 OASIS_REFERENCE_WALLET_ALL_WORKERS=1 OASIS_WORKERS=4 OASIS_LEADER_HTTP=0 OASIS_RATE_EXCHANGE_IP_PER_MINUTE=100000 node --import tsx server/cluster.mjs`（本地 PG 已设 `max_connections=300`、开 `pg_stat_statements`）。钱包吞吐基准：`.local/load/bench.sh`（simple-v1 + 模拟三方钱包）。
- 钱包账本两条路径：simple-v1 三方 App 的概率命令走“按玩家并行”热路径（锁玩家行，App 汇总写入 `wallet_scope_shards` 16 个分片，逻辑总额 = `wallet_scopes` + 分片之和，后台每 10 秒折叠回主行，过期冻结按玩家释放）；PvP 仍走 App 级串行路径。审计 App 总额时要把分片加上。
- 资金流程：simple-v1 App 的娱乐场周期用合并命令 `/wallet/v1/probability/authorize-accept` 一步完成授权+确认（操作 id `accept_<周期>`，见 `server/casino/funding.mjs`）；其他钱包和升级前已用两步开始的周期仍走 `authorize_` + `accept_`。作废时先重放未决的合并操作再退款。
- 进程：生产用 `server/cluster.mjs`（systemd ExecStart），runtime.env 里 `OASIS_WORKERS=3 OASIS_LEADER_HTTP=0`（1 个后台 leader 跑迁移/开奖/恢复，2 个 HTTP 进程），连接预算 `OASIS_DB_POOL_MAX=12 OASIS_WALLET_POOL_MAX=8 OASIS_DB_LOCK_POOL_MAX=5`（3×37≈111，生产 PG `max_connections=128`），`OASIS_CASINO_SETTLE_CONCURRENCY=6`。加机器时按核数加 workers 并同步调大 PG 连接数。
- 容量（2026-10-18）：优化前单 App 约 150 人；优化后不再有单 App 上限，只受机器限制。现有生产机（4 核共享、PG 限 2 核/1G）估算约 550–600 名高强度在玩玩家稳定（峰值约 850）；本机 14 核测 1000 人 p95 旋转 0.25s / 下注 0.34s，2000 人零错误。

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
3. 切换：改 `/etc/systemd/system/oasis-production-api.service` 的 `WorkingDirectory`，`ln -sfn` 更新 `/opt/oasis/production-current`，`systemctl daemon-reload && systemctl restart oasis-production-api`。
4. 验证：`curl https://game.tianyahuyu.com/health`；`systemctl start oasis-production-instance-monitor` 后查看 `/opt/oasis/production-instance-private/monitor/status.json` 全部 ok。
5. 回滚：WorkingDirectory/软链指回上一版本目录并重启。

- 私有配置：`/opt/oasis/production-instance-private/runtime.env`（含 `OASIS_PUBLIC_ORIGIN`、`OASIS_PARTNER_ADMISSION=1`）。数据库容器 `oasis-production-postgres`（127.0.0.1:18893）。
- nginx/systemd 线上配置副本：`platform/deploy/production-game/`。改线上配置后同步回该目录。
- 备份：`/opt/oasis/production-backup.sh`（每日 timer，输出 `/opt/oasis/production-backups/<UTC>`；恢复需同时用 `database.dump` 和私有归档中的 `master.key`）。
- 证书：`oasis-certificate.timer` 运行 certbot renew（覆盖 `oasis-game`、`oasis-production-player` 等；原 `oasis-production-player-certificate.timer` 已停用）。

## Android 真机测试

- 实体机 `46dcfd25`（Xiaomi）。第一方 APK 已删除，真机验证改在接入方 App（WithU）的 WebView 里做：`adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof <包名>)`，再用 CDP `Runtime.evaluate`；测 iframe 帧率用 iframe 自己的 `performance.now()`。
- Chrome 调试：`adb forward tcp:9334 localabstract:chrome_devtools_remote`。

## 历史

`HANDOFF.md`、`ENGINE_AUDIT.md` 等为前任的详细证据记录，结论以本文件与线上实测为准。旧的 master 未提交改动保存在 `git stash`（`master-uncommitted-before-launch-20261015`）。


## WithU 接入（2026-10-19，代码在 WithU 各仓库的本地分支，未推送）

- 只替换概率游戏（40 款），Sud 不动；WithU 后台“游戏管理”里的“概率游戏新老切换”开关控制，开时 Android ≥ 1.6.5 看到 Tianhai 游戏、隐藏其他概率游戏。
- 服务端 `feature/tianhai-games`（worktree `/Users/tyym/Documents/codes/withu-tianhai/server`，基于 master）：渠道 `tianhai`，游戏 ID `th_<平台ID>`；入口 `/callback/tianhai/launch`（校验票据→服务端签名建会话→302 到 `/launch/`）；钱包 `/callback/tianhai/wallet/simple/v1/*`（表 `t_tianhai_wallet_txn`，request_id 唯一、与钻石变动同事务）；配置全部来自 `TIANHAI_*` 环境变量；SQL 在 `withu-server/src/main/resources/script/tianhai165/`。平台绑定的钱包地址 = `https://<WithU API 域名>/callback/tianhai`。
- 后台前端 `feature/tianhai-games`（worktree `/Users/tyym/Documents/codes/withu-tianhai/halla-operation-manager-platform`，基于 withu-master）；node_modules 是指向主检出的软链，**不要在 worktree 里跑 pnpm install/verify**，直接用 `node_modules/.bin/vue-tsc` 与 `node --test tests/*.test.mjs`。
- Android `with/release/1.6.5_20261019`（worktree `/Users/tyym/Documents/codes/withu/android-1.6.4`）：`MKWebView` 的 `TianhaiApp` 桥、返回键交给 `TianhaiLauncher.requestBack()`、Tianhai 页面允许自动播放。构建用 JDK 17（`JAVA_HOME=~/Library/Java/JavaVirtualMachines/jbr-17.0.14/Contents/Home`），`./gradlew :app:assembleGoogleDebug`。
