# AGENTS.md — OASIS 游戏平台

## 产品与线上形态（2026-10-15）

- 正式入口：`https://game.tianyahuyu.com`（管理台/合作方工作台 `/`，游戏 `/play/<id>`，原生启动页 `/launch/`，H5 SDK `/sdk/oasis-h5.mjs`，文档 `/specs/*.md`）。
- 旧域名 `oasis-player.43.98.202.236.sslip.io`、`oasis.43.98.202.236.sslip.io` 均 301 到正式入口。
- 第三方 App 接入模式：**接入方账号 + 接入方自有钱包**。接入方后端 HMAC 调 `POST /v1/sessions`，客户端打开 `/launch/?game=<id>#code=..&session=..`；入场/派奖/概率周期都签名调用接入方钱包。指南：`platform/specs/partner-integration-production.md`。
- 第一方 App（`app_e091fb5daf135660d39ce89fc23760ab`，平台账号+平台内部金币）仍保留，供 `platform/android-player` 的 APK 使用。
- 演示合作方：`https://partner-demo.43.98.202.236.sslip.io`（`platform/examples/partner-demo/server.mjs`，独立数据库的参考钱包 + 签名后端）。合作方账号 `demo.partner`。
- 管理员：`tyym`（另有原 `operator`）。

## 代码结构要点

- `platform/server/production-admission.mjs`：生产准入。`OASIS_PARTNER_ADMISSION=1` 时，非第一方的生产 App（已绑定 HTTPS 外部钱包且启用）可用 HMAC 会话、付费房与概率游戏（`partner-external-v1`）。第一方 App 走 `firstparty-*` profile。
- `platform/server/platform.mjs#createSession`：`hosted`（第一方 BFF 玩家）与合作方 HMAC 会话两条路径。
- `platform/server/wallet-binding.mjs`：外部钱包调用（单次 DNS、只允许公网地址、3s 超时）。测试可用 `setWalletTransportForTests`。
- 前端：`platform/arena`（11 款竞技，React + Three/Canvas），`src/` + `platform/legacy`（雷霆/虎虎）。管理台 `platform/src`。
- 多语言（zh/en/ar）：竞技游戏界面文案以中文为源，用 `$t('中文')`（`arena/shared/i18n.mjs`）翻译，词典 `arena/shared/i18n-dict.mjs`（[英文, 阿语]）。新增中文文案后运行 `node scripts/i18n-codemod.mjs --write` 自动包裹、补词典，再跑 `node scripts/i18n-check.mjs`（防止局部变量遮蔽 `$t`）。语言来源：`/v1/sessions` 的 `locale` → 会话 → 游戏；`/launch/?lang=` 写入 `localStorage.oasis-locale`。阿语只对大厅/结果/弹窗设 RTL。雷霆/虎虎沿用各自词典，换码后按会话语言写入其偏好。
- 快速匹配：`POST /api/pvp/matchmaking`（同 App/游戏/人数/入场费撮合，`pvp_rooms.matchmaking`，等待 120 秒）；匹配房客户端自动就绪，未满员离开只释放座位。
- 线上冒烟：`node platform/scripts/i18n-smoke.mjs all zh,en,ar`（经演示合作方开每款免费练习，检查报错与残留中文）。

## 本地开发与验证

```sh
cd platform
npm run db:start                 # 本地 PG 127.0.0.1:5487
npm run test:release             # 全量后端测试（隔离临时库）；基线有 5 个 QA 采集器旧测试失败（#127/#156-158/#625），与产品无关
npx tsx --test tests/partner-external-admission.integration.test.mjs   # 三方接入端到端
npm run build:release            # 构建全部前端 + release-build-manifest.json
```

## 部署（务实流程）

服务器 `root@43.98.202.236`，密钥 `~/.ssh/hame_deploy.pem`。**同机还有其他业务（chatnaapp 等），只动 oasis 相关文件。**

1. 本地 `npm run build:release`，提交代码。
2. 服务器新建版本目录：`cp -a /opt/oasis/releases/<当前> /opt/oasis/releases/<YYYYMMDD-NN>`，再从本地 rsync `platform/{server,shared}`（--delete）以及 `arena legacy dist public specs scripts deploy examples` 与根 `src/`；`chmod -R u=rwX,go=rX`。
3. 切换：改 `/etc/systemd/system/oasis-production-api.service` 的 `WorkingDirectory`，`ln -sfn` 更新 `/opt/oasis/production-current`，`systemctl daemon-reload && systemctl restart oasis-production-api oasis-partner-demo`。
4. 验证：`curl https://game.tianyahuyu.com/health`；`systemctl start oasis-production-instance-monitor` 后查看 `/opt/oasis/production-instance-private/monitor/status.json` 全部 ok。
5. 回滚：WorkingDirectory/软链指回上一版本目录并重启。

- 私有配置：`/opt/oasis/production-instance-private/runtime.env`（含 `OASIS_PUBLIC_ORIGIN`、`OASIS_PARTNER_ADMISSION=1`）。数据库容器 `oasis-production-postgres`（127.0.0.1:18893）。
- nginx/systemd 线上配置副本：`platform/deploy/production-game/`。改线上配置后同步回该目录。
- 备份：`/opt/oasis/production-backup.sh`（每日 timer，输出 `/opt/oasis/production-backups/<UTC>`；恢复需同时用 `database.dump` 和私有归档中的 `master.key`）。
- 证书：`oasis-certificate.timer` 运行 certbot renew（覆盖 `oasis-game`、`oasis-partner-demo` 等）。partner-demo 的 80 端口 ACME 规则在共享容器 `proxy-nginx` 内（`/etc/nginx/conf.d/oasis-partner-demo-acme.conf`），容器重建后需从 `platform/deploy/production-game/proxy-nginx-oasis-partner-demo-acme.conf` 恢复。

## Android 真机测试

- 实体机 `46dcfd25`（Xiaomi，Android 16）。QA 包 `com.tianyahuyu.oasis.player.qa` 可 WebView 调试：
  `adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof com.tianyahuyu.oasis.player.qa)`，再用 CDP `Runtime.evaluate`。游戏在同源 iframe 内（`document.querySelector('iframe').contentDocument`）。
- 测 iframe 帧率时用 iframe 自己的 `w.performance.now()`（父页面与 iframe 时间原点不同）。
- 重建 APK：`./platform/android-player/build.sh --variant qa|release --origin https://game.tianyahuyu.com --app-id app_e091fb5daf135660d39ce89fc23760ab`（签名在被 git 忽略的 `.local/signing`，务必保留）。
- Chrome 调试：`adb forward tcp:9334 localabstract:chrome_devtools_remote`。

## 历史

`HANDOFF.md`、`ENGINE_AUDIT.md` 等为前任的详细证据记录，结论以本文件与线上实测为准。旧的 master 未提交改动保存在 `git stash`（`master-uncommitted-before-launch-20261015`）。
