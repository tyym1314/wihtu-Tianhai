# 正式玩家身份与启动 BFF（候选实现，尚未开放）

当前公网 `/demo/` 和合作方 HMAC 联调属于沙箱。正式运行实例的 `OASIS_PRODUCTION_ADMISSION_ENABLED` 默认关闭；这里描述的是服务端已实现、尚未完成第三方上线验收的接口边界。正式环境的 `POST /v1/sessions` 对所有合作方签名请求返回 `403 PLAYER_BFF_REQUIRED`，包括带 `resume_session_id` 的请求。合作方签名仅证明 App，不能证明玩家。

正式玩家账号、登录凭证和 App 内用户 ID 由平台持久保存。平台为每个“玩家 × App”生成稳定且不同的 `external_user_id`，启动请求不能自行指定它。浏览器登录使用 `__Host-oasis_player` Cookie（`Secure; HttpOnly; SameSite=Strict; Path=/`，8 小时）；数据库仅存会话凭证的 SHA-256 哈希。长期登录凭证不返回给 JavaScript。状态变更要求精确的 `Origin` 与 `x-oasis-csrf`，CSRF 值由当前登录会话派生，可从登录或会话响应读取。

| 平台同源接口 | 当前服务端行为 |
| --- | --- |
| `GET /api/player/app?app_id=…` | 无登录的只读入口信息，仅返回应用名称、已发布且有权限的 `game_ids` 和 `admission_open`；不返回钱包、密钥或玩家信息。只有正式准入、App、同源宿主与钱包绑定均就绪时才允许新玩家进入。 |
| `POST /api/player/register` | 请求 `{app_id, username, password}`。只有正式准入已开放、App 活跃、宿主 Origin 和钱包提供方已配置时才可新建账号；暂停或未准入时拒绝。平台自有钱包在同一事务创建 App 内身份与零余额账户；外部钱包不自动开户。 |
| `POST /api/player/login` | 请求 `{app_id, username, password}`。符合新玩家准入条件时可登录；准入关闭或 App 暂停后，仅已有该 App 已受理游戏会话的玩家可重新登录以履行恢复义务。响应设置 HttpOnly Cookie，返回玩家、App 内 ID 和 CSRF 值，不返回登录 bearer。 |
| `GET /api/player/session` | 使用 Cookie 读取当前登录玩家及 CSRF 值；过期返回 `401 LOGIN_REQUIRED`。 |
| `GET /api/player/recovery?app_id=…` | 使用 Cookie 按当前平台玩家、App、App 内身份和仍未结束的竞技房间查找已受理的游戏会话，仅返回 `session_id` 与 `game_id`。不接受客户端玩家或会话参数，不返回 token、钱包或房间内容。准入关闭、App 暂停或游戏被移出新游戏目录后仍可查回自己的未完成对局。 |
| `POST /api/player/launch` | 带 Cookie、精确 `Origin`、`x-oasis-csrf`，正文包含 `app_id`、`request_id`、已发布 `game_id` 等，不接受 `external_user_id`。新会话须通过准入、App、宿主与只读钱包余额探针；失败不创建游戏会话或发放测试币。已有会话以 `resume_session_id` 恢复时，仍校验同一玩家、App、游戏，可在新会话准入关闭后完成受理义务。成功返回一次性启动码。 |
| `POST /api/player/logout` | 使用 Cookie、精确 `Origin` 与 CSRF 值撤销该登录会话。 |

生产新建 App 默认使用[平台自有钱包](platform-wallet.md)，注册时持久开户且余额为零，免费游戏不生成测试资金。显式选择外部钱包时，余额探针复用现有签名客户端、App scope 校验、HTTPS/地址允许列表及 3 秒超时；外部钱包必须事先拥有该 App 内用户账户，并按 `wallet-protocol.md` 返回正确的余额响应。平台不会自动为外部钱包开户、迁移参考钱包余额或发币。查无用户、响应无效、超时和网络错误都阻断新游戏会话。游戏内后续扣款与结算仍以钱包原子协议为准。

这些接口只面向平台自身 HTTPS Origin 的浏览器页面。第三方站点不能直接用跨站 Cookie 调用玩家 BFF，也不能用 HMAC 替代玩家登录。

## 托管玩家入口

稳定地址为正式平台 HTTPS Origin 下的 `/player?app_id=<应用编号>`。页面提供真实注册、登录、会话读取、登出与应用允许的游戏目录；注册和登录要求精确 Origin，登录后的状态变更额外带当前会话的 CSRF 值。账号密码仅用于本次提交，登录 Cookie 不对 JavaScript 可见，不写入浏览器存储。页面不提供演示身份或测试资金。沙箱的玩家 BFF 返回 404，页面明确显示入口不可用，不跳往试玩或 mock。

选中游戏后通过同源 `/api/player/launch` 和现有 `OasisHost` SDK 加载游戏。网络结果不确定时自动和手动重试沿用原 `request_id` 与请求正文；SDK 重新授权、登录过期后重新登录都携带原 `resume_session_id`，不得换新游戏会话。刷新、关闭页面或换设备后，登录原账号可从服务端读取未完成竞技对局；“恢复”按钮独立于新游戏准入开关，并复用已受理会话进入同一房间。恢复期间登录表单锁定原账号，服务端也校验玩家所有权。游戏加载后独占视口，返回须由游戏完成自身退出/恢复流程，再回到玩家自己的大厅。页面忽略外部 `return_url`，不接受任意回跳地址。准入关闭时禁用新注册和新游戏，已有义务的登录和恢复仍由服务端校验。

当前托管页面、只读目录与竞技对局找回已实现，并有隔离生产 BFF、真实持久账号/零余额钱包、原房间恢复与浏览器验证；**合作方外部跳转/回跳协议、账号验证/密码找回仍是单独的上线缺口**。概率游戏仍受正式数学准入限制，未开放其托管恢复目录。首发合作方、真实手机 WebView、钱包账户与账务仍需验收，并由运维明确开启正式准入。以上实现不表示生产服务已经对第三方开放。
