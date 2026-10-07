# OASIS Android 接入测试

这是用于 USB 真机验收的合作方 App Mock：大厅由原生 ScrollView、TextView、ImageView 和可点击卡片组成，不加载 HTML。APK 内的 `MockPartnerApi` 以确定性的本地方法提供用户身份、资料、展示余额和游戏选择，不发网络请求、不存密钥。点击游戏后才创建该游戏的全屏 WebView，13 款完整可玩流程由游戏平台的 HTTPS 单游戏宿主、真实游戏服务和独立沙箱测试钱包提供。大厅展示余额不会参与游戏或与平台钱包同步，不能把整款 APK 说成离线版或所有游戏接口都是 Mock。

## 1.3 独立在线 Mock 版本（内部真机验收中）

`1.3.0` 是新的构建目标：原生大厅仍由 `MockPartnerApi` 提供固定测试身份；游戏 WebView 必须访问[独立在线 Mock 栈](../deploy/mock-sandbox/README.md)的 HTTPS 域名，在独立 PostgreSQL、独立密钥和独立参考测试钱包中完成 13 款游戏的权威对局。该栈复用游戏规则与服务端引擎代码，但与当前公网试玩和未来真实三方数据隔离。它需要网络，不能宣称离线可玩。

先配置并运行独立栈的隔离 preflight，再把同一个精确 HTTPS Origin 显式传给构建脚本：

```sh
OASIS_ANDROID_MOCK_ORIGIN=https://YOUR_VERIFIED_MOCK_HOST ./build-mock.sh
```

缺少 `OASIS_ANDROID_MOCK_ORIGIN` 时，构建在打包前直接失败；HTTP、路径、查询参数、凭据、已知公网试玩域名以及另行给出的 `OASIS_LIVE_PUBLIC_ORIGIN` 均被拒绝。构建期生成 `MockOrigin` 常量，原生 WebView 导航白名单、返回脚本和包内宿主入口只使用该 Origin，不接受运行时 URL 覆盖。生成包名为 `com.tianyahuyu.oasis.mock`，版本 `1.3.0 (6)`，与历史 `1.2.0` 包可并存。签名私钥单独保存在被忽略的 `.local/signing/mock-debug.jks`；产物只写本地 `dist/oasis-android-mock-1.3.0-debug.apk`、`dist/mock-build-checks.json` 和 `dist/mock-SHA256SUMS`，不会自动复制到公开下载目录。

仅能在独立域名、TLS 证书、数据库、两把独立密钥、API/钱包/宿主服务都实际就绪后，把该 Origin 构建的 APK 安装到实体 Android 手机验收。需要逐款检查启动、触控、规则、完成/结算、返回、恢复、性能与加载速度。使用占位域名成功编译只证明源码、DEX、签名和元数据正确；占位域名 APK 无法联网试玩，不能发布。

2026-10-07 独立内部 QA Origin `https://oasis-mock.43.98.202.236.sslip.io` 已就绪并固定在 `20261007-04`，严格 TLS、独立数据/密钥、到 live 端口的拒绝、停止/重启恢复均已验证。它与 live 同机但有独立 UID、网络策略和资源限额，只供单人内部 QA，不能视为正式容量环境。绑定该 Origin 的 `1.3.0 (6)` 已安装到实体 Xiaomi / Android 16；从手机读回的 APK SHA-256 为 `8e283af9ccbd7d336c18d1a4259ac2c2d4694cea0647a4ef009555174b290cee`，与本地候选一致。13 款均已有原生进入、受信任触控单次操作/概率周期、返回和原会话清理成功记录，首轮脚本失败及复验边界详见[本轮验收记录](../specs/third-party-launch-readiness-2026-10-07.md)。完整局与性能验收尚未完成，公开下载仍为历史 `1.2.0`；不要把它的公网试玩连接或旧验收结果当成 1.3 的证据。

## 1.2 历史公网试玩包

- 包名：`com.tianyahuyu.oasis.smoke`
- 应用名：OASIS 接入测试
- APK 版本：`1.2.0`，versionCode `5`
- 最低 Android：8.0 / API 26；编译 API 35；target API 34
- 单游戏入口：`https://game.tianyahuyu.com/demo/native/<gameId>`
- 原生返回地址：精确匹配 `https://game.tianyahuyu.com/demo/native-return`

复用已部署的平台沙箱宿主与其测试币、启动、钱包和返回流程，因此 APK 不需要自行部署业务服务器。APK 内没有合作方签名密钥、管理员账号、长期登录凭证或 JavaScript 原生桥。`MockPartnerApi` 不签发平台会话，不模拟平台资金操作；其启动选择只校验并返回 13 个已发布游戏 ID，随后 WebView 访问平台真实服务。

真机测试可验证指定手机和 Android System WebView 上的 HTTPS 加载、Cookie、H5 启动、画面、交互、音频、前后台切换、返回和平台沙箱响应。它不能证明一个尚未存在的合作方真实登录、用户映射、主钱包扣款/返奖、幂等实现或生产接入已通过验收。本地构建和纯 Java Mock 合约测试也不能代替真机逐款验收。

## 构建

本项目不使用 Gradle、不下载依赖。使用本机已有 Android SDK 和 Android Studio JBR：

```sh
cd /Users/tyym/Documents/codes/game/platform/android-smoke
./build.sh
```

默认路径为 `/Users/tyym/Library/Android/sdk` 和 `/Applications/Android Studio.app/Contents/jbr/Contents/Home`；可通过 `OASIS_ANDROID_SDK`、`OASIS_JAVA_HOME` 覆盖。需要 build-tools `35.0.1` 和 `platforms/android-35/android.jar`。

流程为 `aapt2 → javac → 纯 Java Mock 合约测试 → d8 → zipalign → apksigner`，每次构建验证 APK 签名并写出 SHA256。输出：

```text
dist/oasis-android-smoke-1.2.0-debug.apk
dist/SHA256SUMS
dist/build-checks.json
```

首次构建自动生成 `.local/signing/debug.jks` 及随机口令，均为 `0600`，仅用于本地测试安装升级。不要把 `.local/`、签名私钥或口令加入接入包/公开下载；分享 APK 即可。同一台机器重复构建复用同一证书，但构建时间和 ZIP 元数据可能改变 APK 哈希，哈希以本次 `dist/SHA256SUMS` 为准。

## 安装与检查

由操作者确认 USB 设备序列号后安装，不自动选择或操作其他设备：

```sh
adb -s DEVICE_SERIAL install -r dist/oasis-android-smoke-1.2.0-debug.apk
adb -s DEVICE_SERIAL shell am start -n com.tianyahuyu.oasis.smoke/.MainActivity
```

原生大厅显示 Mock 用户、仅供展示的 Mock 余额和数据边界。深色金色两列卡片中的 13 款图标由 APK 内原生 Drawable 绘制，不依赖 HTML、网络图片或位图资源。每张卡片具有精确的 `contentDescription="game:<id>"`，中文名由原生 TextView 显示，可用 UIAutomator 定位。全部 ID：`thunder`、`tiger`、`match`、`golf`、`carrom`、`darts`、`ludo`、`jackaroo`、`domino`、`pool`、`bowling`、`run`、`towerlink`。大厅原生滚动，以保持图标和点击区域大小。

游戏态没有原生工具栏、诊断栏、网页大厅或网页导航栏。系统状态栏和导航栏沉浸式隐藏，用户仍可通过边缘手势临时唤出。系统返回键在受信任的单游戏宿主页调用 `window.OasisNativeHost.requestBack()`，由宿主发 SDK 返回意图、游戏处理确认；仅当宿主随后导航到精确的固定返回地址时才销毁 WebView 并回原生大厅。玩家取消游戏内退出会保留原页面，不设置计时强制退出。宿主不存在或渲染器退出时，原生返回提供明确确认，不能把关闭当成退赛、退款或结算。原生大厅的系统返回正常退出 Activity。

Android 11+ 显式处理 insets：大厅避开系统栏、刘海和键盘；全屏游戏仅保留刘海与键盘安全区，临时系统栏不改变游戏布局，再消费 insets，避免 H5 重复留白。Android 8–10 使用对应的沉浸式 flags 与窗口/刘海安全区。Activity 固定竖屏并处理屏幕尺寸配置变化，前后台继续调用 WebView 正常生命周期，不中断 Cookie 持久化。实际一屏完整显示必须结合各款游戏 H5 响应式布局和真机截图验证，APK 构建本身不证明该验收已通过。

诊断只在原生大厅提供一个按钮，可查看版本、最近 Mock 启动选择、最近游戏、最近错误和当前系统安全区。URL 查询参数与 fragment 不显示，控制台原文不复制到原生日志，以免暴露启动凭证。

仅此调试 APK 开启 WebView 远程调试，可通过 ADB 转发对应的 `webview_devtools_remote_*` socket 使用 Chrome DevTools 协议记录网络和画面；正式宿主应关闭 `android:debuggable`，代码也会随之关闭 WebView 调试。

## 网络和权限边界

仅申请 Internet 权限，禁止明文、混合内容、文件访问、内容 URI、弹出新窗口和运行时网页权限请求。导航限定平台 HTTPS Origin 下的当前单游戏宿主、当前 `/play/<id>` 及游戏静态资源路径；固定返回地址只接受顶层精确匹配。TLS 错误直接取消，不绕过证书校验。启用 JavaScript、DOM Storage、正常第一方 Cookie 与硬件加速；第三方 Cookie 关闭（当前游戏为同源 iframe），音频保持用户手势要求。外部 Intent 不能注入自定义启动 URL，没有 deep link 入口，不暴露 JS 原生桥。回大厅会销毁所选 WebView；再次点击时创建新的同源 WebView，Cookie 保留。

未实机运行前，APK 构建成功只能证明打包和签名，不等于 13 款游戏已在物理设备通过。

版本 1.2.0 增加了原生合作方 App 的确定性 Mock 数据和接口，保留第 13 张连线夺塔卡片、全部游戏入口及原有返回安全协议。构建验证 APK 内的 Mock API 合约、DEX、签名、目录、返回协议及哈希；物理手机的完整 13 款试玩结果以另行记录的真机报告为准。
