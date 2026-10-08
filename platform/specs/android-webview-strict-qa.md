# 严格 Android APK 验证

`scripts/verify-android-webview.mjs` 验证显式选定的 **isolated Mock APK**。默认覆盖全部 13 款：原生入口、真实 WebView 中一次 UI 操作、对应权威 ACK、Android 返回、原 session 业务清理及最终读回。它不验证真人付费、游戏完整品质、完整关卡、GPU FPS 或第三方生产接入。

## 必需配置

沿用 artifact 校验参数：

- `OASIS_ANDROID_ARTIFACT`：本地审核过的 APK 元数据文件；同目录必须有哈希匹配的 APK。
- `OASIS_ANDROID_SERIAL`、`OASIS_ANDROID_ADB_PORT`：明确设备及本机 ADB server。
- `OASIS_ANDROID_ORIGIN`、`OASIS_ANDROID_PACKAGE`、`OASIS_ANDROID_APK_SHA256`：必须与元数据、设备上的包完全一致。
- `OASIS_ANDROID_RELEASE`、`OASIS_ANDROID_RELEASE_SSH_HOST`、`OASIS_ANDROID_RELEASE_SSH_KEY`：精确 Mock release 与已授权 SSH 通道。SSH 必须通过已有 host-key 校验。
- **新增 `OASIS_ANDROID_RELEASE_MANIFEST_SHA256`**：当前 Mock immutable release 的 `RELEASE-MANIFEST.json` 字节 SHA256。
- **新增 `OASIS_ANDROID_APP_ID`**：已核验的 Mock demo app ID；必须与 SDK exchange、原 session 和只读数据库结果一致。

配置好上述变量后运行：

```sh
env -u NODE_TLS_REJECT_UNAUTHORIZED OASIS_ANDROID_LIFECYCLE=0 \
  node scripts/verify-android-webview.mjs
```

默认必须是有 USB 标记的明确设备。仅当明确授权云手机时设置 `OASIS_ANDROID_ALLOW_REMOTE=1`；报告仍标记为 remote，不能当实体手机证明。不会安装、卸载 APK 或清除应用数据。显式 `OASIS_ANDROID_GAMES` 子集只能产生分项诊断，不能取得整体验收 PASS。

旧脚本的恢复、断网、后台及负向 API 测试不在此模式执行。`OASIS_ANDROID_LIFECYCLE=1` 会被拒绝；不能将这些阶段的错误批量列为“预期”来取得严格 PASS。

## 启动观察边界

APK 首次创建 WebView 后才能连接 CDP。脚本先以 Match 进行无操作的身份/仪器 bootstrap。进入初始页面后必须完成 SDK 初始化并达到真实 network-idle；无法闭合时失败，不用固定等待猜测完成。

测量页在安装 observer/probe 后重新加载，并绑定 reload 返回的原始 navigation request。只有实际观察到在该导航之前发起的请求可列入初始边界；其晚到 exchange 不能进入新 session。未知请求来源的响应保留为错误。所有 page/console 错误仍留证，不因重载而清空。

因此这是 **warm/reloaded APK smoke**。bootstrap 和首次未观察导航不算首次冷启动或性能证据。每款图像和尺寸检查来自实际选定 Android WebView，不是桌面 mobile viewport，但部分竞技拖动沿用浏览器可信 mouse 输入，不据此宣称全部手机手势品质通过。

## 持久 guest 与只读 inventory

APK Cookie/guest 保持原样。新开 session 为空不能证明旧 session 已无业务。脚本在 bootstrap 停止 UI 后、每次实际操作前、每游戏清理后，通过已配置 SSH 执行内存中的只读查询：

- 绑定 Mock origin、release pin、manifest、审核 app、精确 guest 和当前 session；校验 Mock 专用数据库/钱包地址。
- 使用 `REPEATABLE READ READ ONLY`，SQL 参数绑定 app/guest，5 秒 statement timeout 和 1 秒 lock timeout。
- 检查旧 active/nonterminal room、pending/unacknowledged round、剩余 cycle、未决 operation 及未知/不完整状态。
- 记录执行体/reader、服务端源文件与 schema SHA；输出计数和绑定证明，不输出 token、数据库密码、钱包余额或完整私人行。

这是 **额外只读 SSH/数据库依赖**，不是平台公开 API 能力证明。reader 不写远端文件、不启动服务器、不调用 recovery，不枚举其他用户；历史 live APK/生产数据库不支持此模式。发现旧业务或身份不确定即失败，绝不接管、leave、ACK 或消耗旧免费转。

## 单次操作与清理

竞技输入不自动重试。Run V2.3 要同时满足单个原始 `/inputs` POST 的精确回执校验和独立网络观察；GET、任意 2xx、多个批次或后续隐藏重试不能代替该证明。

概率游戏要求一个新付费测试 cycle、已结算轮次及对应 ACK。清理只允许本轮原 session 的已知 cycle 中剩余的已结算呈现/免费转，不发起新付费 cycle。未知创建或 spin 回执不能由随后“空状态”洗成成功。

每款均先停止游戏 UI，再 drain，核对 original-session ownership 后清理，读回房间终态/session 指针及 `pendingRound=null/freeSpins=0`，最后重新检查全部错误。失败清理可以 force-stop **选定的自有测试 APK**，不会对继承业务按“确认离开”。清理失败、观察缺失和首个业务失败均保留，后续游戏不会继续掩盖失败。

脚本使用 `tcp:0` 分配独占 forward，只有精确 serial/local/remote 读回一致才移除；从不覆盖原 `19220/19222`。UI XML 使用随机自有文件名并核验删除。最终核对原 forward 清单、恢复原前台 Activity，并再次校验安装的 APK 和部署 pin。恢复的是前台 Activity，不承诺恢复任意原应用页面内部状态。

每次输出使用全新目录 `review/android/<variant>-<release>-strict-*`，默认 owner-only。只有全部 13 款、业务读回和资源归还都成功，最终 `passed` 才为 true。报告中的 SSH inventory、APK/WebView smoke 与真正手机完整局性能证据必须分别说明。
