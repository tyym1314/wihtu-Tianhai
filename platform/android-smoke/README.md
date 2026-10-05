# OASIS Android 接入测试

这是用于 USB 真机验收的原生 Android 游戏大厅：大厅由原生 ScrollView、TextView、ImageView 和可点击卡片组成，不加载 HTML；点击某款游戏后才创建该游戏的全屏 WebView。它适配平台专用单游戏沙箱宿主，不是完整合作方 App 或通用原生 SDK。

- 包名：`com.tianyahuyu.oasis.smoke`
- 应用名：OASIS 接入测试
- APK 版本：`1.1.1`，versionCode `4`
- 最低 Android：8.0 / API 26；编译 API 35；target API 34
- 单游戏入口：`https://game.tianyahuyu.com/demo/native/<gameId>`
- 原生返回地址：精确匹配 `https://game.tianyahuyu.com/demo/native-return`

复用已部署的平台沙箱宿主与其测试币、启动、钱包和返回流程，因此 APK 不需要自行部署业务服务器。APK 内没有合作方签名密钥、管理员账号、长期登录凭证或 JavaScript 原生桥。

这个测试可以证明指定手机和 Android System WebView 上的 HTTPS 加载、Cookie、H5 启动、画面、交互、音频、前后台切换、返回和平台沙箱响应。它不能证明一个尚未存在的合作方真实登录、用户映射、主钱包扣款/返奖、幂等实现或生产接入已通过验收。

## 构建

本项目不使用 Gradle、不下载依赖。使用本机已有 Android SDK 和 Android Studio JBR：

```sh
cd /Users/tyym/Documents/codes/game/platform/android-smoke
./build.sh
```

默认路径为 `/Users/tyym/Library/Android/sdk` 和 `/Applications/Android Studio.app/Contents/jbr/Contents/Home`；可通过 `OASIS_ANDROID_SDK`、`OASIS_JAVA_HOME` 覆盖。需要 build-tools `35.0.1` 和 `platforms/android-35/android.jar`。

流程为 `aapt2 → javac → d8 → zipalign → apksigner`，每次构建验证 APK 签名并写出 SHA256。输出：

```text
dist/oasis-android-smoke-1.1.1-debug.apk
dist/SHA256SUMS
dist/build-checks.json
```

首次构建自动生成 `.local/signing/debug.jks` 及随机口令，均为 `0600`，仅用于本地测试安装升级。不要把 `.local/`、签名私钥或口令加入接入包/公开下载；分享 APK 即可。同一台机器重复构建复用同一证书，但构建时间和 ZIP 元数据可能改变 APK 哈希，哈希以本次 `dist/SHA256SUMS` 为准。

## 安装与检查

由操作者确认 USB 设备序列号后安装，不自动选择或操作其他设备：

```sh
adb -s DEVICE_SERIAL install -r dist/oasis-android-smoke-1.1.1-debug.apk
adb -s DEVICE_SERIAL shell am start -n com.tianyahuyu.oasis.smoke/.MainActivity
```

原生大厅为深色金色两列卡片，13 款图标由 APK 内原生 Drawable 绘制，不依赖 HTML、网络图片或位图资源。每张卡片具有精确的 `contentDescription="game:<id>"`，中文名由原生 TextView 显示，可用 UIAutomator 定位。全部 ID：`thunder`、`tiger`、`match`、`golf`、`carrom`、`darts`、`ludo`、`jackaroo`、`domino`、`pool`、`bowling`、`run`、`towerlink`。大厅原生滚动，以保持图标和点击区域大小。

游戏态没有原生工具栏、诊断栏、网页大厅或网页导航栏。系统状态栏和导航栏沉浸式隐藏，用户仍可通过边缘手势临时唤出。系统返回键在受信任的单游戏宿主页调用 `window.OasisNativeHost.requestBack()`，由宿主发 SDK 返回意图、游戏处理确认；仅当宿主随后导航到精确的固定返回地址时才销毁 WebView 并回原生大厅。玩家取消游戏内退出会保留原页面，不设置计时强制退出。宿主不存在或渲染器退出时，原生返回提供明确确认，不能把关闭当成退赛、退款或结算。原生大厅的系统返回正常退出 Activity。

Android 11+ 显式处理 insets：大厅避开系统栏、刘海和键盘；全屏游戏仅保留刘海与键盘安全区，临时系统栏不改变游戏布局，再消费 insets，避免 H5 重复留白。Android 8–10 使用对应的沉浸式 flags 与窗口/刘海安全区。Activity 固定竖屏并处理屏幕尺寸配置变化，前后台继续调用 WebView 正常生命周期，不中断 Cookie 持久化。实际一屏完整显示必须结合各款游戏 H5 响应式布局和真机截图验证，APK 构建本身不证明该验收已通过。

诊断只在原生大厅提供一个按钮，可查看版本、最近游戏、最近错误和当前系统安全区。URL 查询参数与 fragment 不显示，控制台原文不复制到原生日志，以免暴露启动凭证。

仅此调试 APK 开启 WebView 远程调试，可通过 ADB 转发对应的 `webview_devtools_remote_*` socket 使用 Chrome DevTools 协议记录网络和画面；正式宿主应关闭 `android:debuggable`，代码也会随之关闭 WebView 调试。

## 网络和权限边界

仅申请 Internet 权限，禁止明文、混合内容、文件访问、内容 URI、弹出新窗口和运行时网页权限请求。导航限定平台 HTTPS Origin 下的当前单游戏宿主、当前 `/play/<id>` 及游戏静态资源路径；固定返回地址只接受顶层精确匹配。TLS 错误直接取消，不绕过证书校验。启用 JavaScript、DOM Storage、正常第一方 Cookie 与硬件加速；第三方 Cookie 关闭（当前游戏为同源 iframe），音频保持用户手势要求。外部 Intent 不能注入自定义启动 URL，没有 deep link 入口，不暴露 JS 原生桥。回大厅会销毁所选 WebView；再次点击时创建新的同源 WebView，Cookie 保留。

未实机运行前，APK 构建成功只能证明打包和签名，不等于 13 款游戏已在物理设备通过。

版本 1.1.1 修复第 13 张卡片导致的原生大厅越界，新增连线夺塔入口。当前构建只完成本地签名、DEX、目录、返回协议及哈希校验；未连接手机、未安装、未产生新的真机验收报告。
