# OASIS 真实玩家 Android 壳

此模块只提供 Android WebView 容器。账号、余额、游戏目录、游戏会话和游戏结果均来自配置的真实平台后端。没有内置玩家身份、初始余额、模拟接口、合作方 HMAC 或钱包 Secret。

## 入口与返回契约

构建必须显式提供 HTTPS origin、公开 App ID 和 `release` / `qa` 变体；没有默认入口。入口固定为 `/player?app_id=<公开 App ID>`，不接受 Intent 参数改变。

- 顶层导航仅允许构建指定的完整玩家入口；不能跳入管理后台、Demo、外部网站或直接用游戏页面替换玩家宿主。
- 子框架导航仅允许同 origin 的 13 个已发布 `/play/<game_id>` 地址。游戏授权仍由服务器上的 App 授权目录决定，这个路径白名单不能开放被服务器禁止的游戏。
- 本地系统返回在验证当前顶层入口后调用 `window.OasisPlayerHost.requestBack()`。此函数必须同步返回 `true` 表示 H5 已处理／委托游戏返回，`false` 表示关闭本机 Activity。已加载游戏应委托 `OasisHost.requestBack()`，继续等游戏的 `return_requested`；本机不调用 `goBack()`、离房、退款或结算接口。
- 若画面线程在 2.5 秒内没有返回桥接结果，只关闭本机 Activity；迟到回调不会影响后来页面。正常返回 `true` 仍由 H5／游戏确认返回。
- 没有有效玩家页面／桥接方法时，只关闭本机 Activity。关闭页面不表示服务器上的对局已退出或已结算。
- 服务器需要提供 `/player`、真实 `/api/player/*` 和同 origin 的游戏资源。此模块不提供后端模拟服务，也不绕过服务器的生产准入。

生产玩家开户为零余额；第三方应用划转和双方账本对账由后端完成。APK 不主动充值。玩家大厅的真实余额接口与展示、H5 返回桥由平台模块负责。

## 构建

已支持本机 Android SDK build-tools 35.0.1 / android-35 与 Android Studio JBR。可以用公开环境变量 `OASIS_ANDROID_SDK`、`OASIS_JAVA_HOME` 覆盖工具目录。

使用实际已经配置好的公开值：

```sh
./platform/android-player/build.sh --variant release \
  --origin "$OASIS_PLAYER_ORIGIN" --app-id "$OASIS_PLAYER_APP_ID"
./platform/android-player/build.sh --variant qa \
  --origin "$OASIS_PLAYER_ORIGIN" --app-id "$OASIS_PLAYER_APP_ID"
```

两项公开值为空时构建失败。origin 必须是规范 HTTPS origin，不带末尾 `/`、路径、用户信息、查询或片段；App ID 为 1–128 位字母、数字、下划线或横线。拒绝本地地址、IP 和保留示例域名，避免把占位包当成联网成品。

正式包为 `com.tianyahuyu.oasis.player`，`debuggable=false`，不允许 WebView 远程调试。仅 QA 包为 `com.tianyahuyu.oasis.player.qa`，名称和产物明确标记 QA，可用于后续授权 ADB/CDP 检查。二者使用不同签名密钥与输出目录。

首次构建按变体生成随机本地签名密码与 RSA 密钥，只写入 ignored `.local/signing/{release,qa}/`，权限 0600。更新同一正式包必须保留其签名身份；丢失或不完整签名状态会拒绝自动覆盖。应将该目录按团队的私钥管理流程安全备份，不提交到 Git。构建不读取其他模块的旧签名材料。

产物输出到 `dist/{release,qa}/`，包括 APK、`build-metadata.json` 与 `SHA256SUMS`。元数据记录实际 APK SHA、公开证书 SHA、构建基础 Git SHA、逐文件源码 SHA 和生成配置 SHA；源码构建期间改变则拒绝生成验收元数据。这些信息只证明本地原生构建和契约，不能代替真实后端或实体手机验收。

构建使用模块独占锁，防止并发覆盖配置或签名身份；正常退出会释放锁。若构建被强制终止，应先确认没有本模块构建进程，再移除 `.local/build.lock` 空目录。重新构建会先使旧元数据失效，构建失败时不得使用残留 APK。

## 无后端合约验证

当正式公开配置尚未提供时，可以验证纯 Java 导航和返回边界，并构建明确不可联网的 QA 合约包：

```sh
./platform/android-player/test.sh
./platform/android-player/build.sh --variant qa \
  --origin https://apk-contract.invalid --app-id fixture_app_01 --contract-fixture
```

合约包使用保留、不可解析的 `.invalid` 域名，标题、文件名和元数据明确标注无真实后端，只输出 `dist/qa-contract/`。正式变体拒绝 `--contract-fixture`。不得把这个包安装后当作真实玩家接入已经完成。

测试检查精确 origin／App ID、跨域和本地方案拒绝、顶层与子框架分离、13 个游戏路径、重复查询／附加令牌拒绝、真实 Java 生成的返回脚本，以及正式与 QA 的安全属性。另用 JVM Android API 替身与虚拟时钟驱动真实 `MainActivity` 的加载、后台、重试、迟到回调和返回行为；这些检查只证明原生控制流，不代替系统 WebView 或真机验收。

TLS 失败一律取消，第三方 Cookie、文件／内容访问、自动弹窗、权限请求和明文均禁用。大厅在前台加载超过 30 秒显示重试，切后台取消计时，恢复前台重新给完整 30 秒；已加载页面不自动刷新。重试先停止并移除旧 WebView，再通过新 WebView 重新读取服务器状态；旧加载回调不能影响新页面。WebView 崩溃后同样显示重试。

发布前仍须用实际生产 App 完成登录、真实余额、进入游戏、退出确认、断网重试、后台恢复、会话过期恢复和实体 Android 触控／性能验证。当前服务端明确禁止 thunder/tiger 的生产准入；APK 不解除该限制，也不应宣称 13 款均已达到生产开放标准。
