# Android 原生入口与全屏游戏

推荐结构是「App 原生游戏列表 → 单款游戏 WebView → 返回原生 App」。游戏图标、用户信息和业务入口由 App 自己实现，不需要把 OASIS 网页试玩大厅嵌入 App。

## 历史公网试玩 APK 与独立 Mock 候选

[下载历史公网试玩包 1.2.0](/downloads/oasis-android-smoke-1.2.0-debug.apk)。这是明确标为 `historical-live` 的旧 QA 包，连接公网试玩沙箱；不是独立 Mock 候选，也不代表当前实体手机验收通过。保留原文件 URL 供历史记录核对，不将其标为最新版。

`OASIS 接入测试 1.2.0` 使用原生 Android 卡片展示 13 款游戏。原生大厅的固定用户、资料、展示余额和游戏选择由 APK 内的 `MockPartnerApi` 返回。点击卡片后打开对应的 `https://game.tianyahuyu.com/demo/native/<game_id>`，游戏期间没有网页大厅和宿主工具栏。游戏内账号、操作、余额、对局和结算仍使用平台的真实沙箱接口与测试钱包；原生大厅展示余额不会同步到游戏。

历史包的包名为 `com.tianyahuyu.oasis.smoke`。独立 Mock 候选 `1.3.0 (6)` 的包名为 `com.tianyahuyu.oasis.mock`，固定访问 `https://oasis-mock.43.98.202.236.sslip.io`，可与历史包共存。候选已安装实体 Android，13 款完整验收尚未闭合；目前仅限内部 QA，不提供默认公开下载。它与 1.2 的身份、测试钱包和验收报告必须分开，详见 [Android 测试说明](../android-smoke/README.md)。

`build:release` 只校验并原样保留已经审核的公开 APK，不运行 Android 重打包，不复制本地候选，也不改写公开元数据。`/downloads/android-smoke-build.json` 保留 `version`、`version_code`、`apk`、`sha256`、`game_count` 等旧字段，并明确版别、包名、Origin 与源码指纹。原生源码或构建输入变化时，发布构建以 `ANDROID_REVIEWED_APK_STALE` 阻断；需要显式构建、审核并登记新产物，不能只改摘要绕过审核。后续分发必须使用验收过的同一 APK 字节，不能在验收后重新打包同一版本覆盖原 URL。

历史 APK 的 Mock 范围只覆盖合作方原生 App 层，**未覆盖 13 款游戏的全部接口模拟**。该路径仅用于沙箱测试，不能代表合作方正式登录、用户映射或主钱包已经接通。正式 App 应由自己的服务端完成签名授权；长期 API 密钥不得打包进 APK 或 H5。正式启动、签名和钱包流程见平台标准接入文档与合作方接入包。

## 宿主实现要点

1. 原生按钮选择 `game_id`，拿到短期启动授权后，通过平台 `OasisHost` SDK 加载单款游戏。启动授权只用于指定玩家和游戏，不拼接长期凭证。
2. WebView 占满游戏容器。隐藏 App 原生导航、状态栏与系统导航栏，允许用户用系统手势临时唤出。对刘海、挖孔、键盘安全区只处理一次，避免 native padding 与网页安全区重复叠加。
3. 页面使用 `width=device-width,initial-scale=1,viewport-fit=cover`；宿主 iframe 宽高为可用视口的 100%。游戏主玩法、计分区和主要操作应在一屏内完成，不通过缩小整张页面、裁掉按钮或隐藏溢出来伪造适配。玩法说明、历史记录和房间配置可以单独滚动。
4. Android 系统返回键调用 SDK 的 `requestBack()`。由游戏确认是否离开、处理原请求及结果状态，收到合法的 `return_requested` 后再关闭 WebView；不要直接销毁活跃对局。
5. 当前测试宿主暴露 `window.OasisNativeHost.requestBack()`，完成返回后导航到同源固定路径 `/demo/native-return`。测试 APK 拦截这个精确地址并回原生大厅；不暴露任意 JavaScript 原生接口。
6. 进入后台暂停 WebView 生命周期，回前台恢复并读取服务器最新状态；进程重启通过原用户恢复对局，不能重新发币、重新扣款或把旧动作当作新动作重放。
7. 保持 HTTPS 证书校验，禁用明文、混合内容、文件访问及任意外部导航。启用 JavaScript、DOM Storage 和必要的第一方 Cookie；音频按用户手势启动。正式构建关闭 WebView 远程调试。

## 验收范围

逐款检查原生点击、授权兑换、一个合法操作的实际 HTTP 返回、系统返回、横纵向溢出和按钮位置。另外检查断网恢复、前后台恢复、进程重启、无效会话与跨游戏会话拒绝。

单台 Android 通过只能证明该设备和对应已部署版本的基础接入。它不替代真实合作方钱包、多人整局结算、全机型/iPhone、声音听感和持续帧率验收。完整 13 款真机报告必须与当前发布版本一致，并逐款记录。

## 显式选择验收目标

`scripts/verify-android-webview.mjs` 不再默认选择手机、5037 ADB server、历史包或 live 发布。操作者必须显式提供 APK 元数据、设备序列号、ADB server 端口、Origin、包名、APK SHA-256、发布版本与只读发布核验的 SSH 主机/密钥路径。脚本先核对本地产物，再读取指定手机上已安装 APK 的 SHA-256、versionName 和 versionCode，全部一致后才启动界面；不会安装或重建 APK。结束时再次核对 APK 和服务器版本。

独立 Mock 使用自己的 `android-mock-current` pin 和安装器 `status` 的隔离/健康证据，历史包仅在明确选择后读取 live 发布记录；两者不互相代替。每轮报告新建独立目录，包含版别、包名、Origin、安装包摘要和发布读回，不覆盖以前的报告。当前内部 QA 的示例参数如下，设备操作只能由持有该设备的验收者执行：

```sh
OASIS_ANDROID_ARTIFACT=/absolute/path/platform/android-smoke/dist/mock-build-checks.json \
OASIS_ANDROID_SERIAL=EXPLICIT_DEVICE_SERIAL \
OASIS_ANDROID_ADB_PORT=5038 \
OASIS_ANDROID_ORIGIN=https://oasis-mock.43.98.202.236.sslip.io \
OASIS_ANDROID_PACKAGE=com.tianyahuyu.oasis.mock \
OASIS_ANDROID_APK_SHA256=8e283af9ccbd7d336c18d1a4259ac2c2d4694cea0647a4ef009555174b290cee \
OASIS_ANDROID_RELEASE=20261007-04 \
OASIS_ANDROID_RELEASE_SSH_HOST=root@43.98.202.236 \
OASIS_ANDROID_RELEASE_SSH_KEY=/absolute/path/to/ssh-key \
node scripts/verify-android-webview.mjs
```
