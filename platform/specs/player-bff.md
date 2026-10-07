# 正式玩家身份与启动 BFF（候选实现，尚未开放）

当前公网 `/demo/` 和合作方 HMAC 联调属于沙箱。正式运行实例的 `OASIS_PRODUCTION_ADMISSION_ENABLED` 默认关闭；这里描述的是服务端已实现、尚未完成第三方上线验收的接口边界。正式环境的 `POST /v1/sessions` 对所有合作方签名请求返回 `403 PLAYER_BFF_REQUIRED`，包括带 `resume_session_id` 的请求。合作方签名仅证明 App，不能证明玩家。

正式玩家账号、登录凭证和 App 内用户 ID 由平台持久保存。平台为每个“玩家 × App”生成稳定且不同的 `external_user_id`，启动请求不能自行指定它。浏览器登录使用 `__Host-oasis_player` Cookie（`Secure; HttpOnly; SameSite=Strict; Path=/`，8 小时）；数据库仅存会话凭证的 SHA-256 哈希。长期登录凭证不返回给 JavaScript。状态变更要求精确的 `Origin` 与 `x-oasis-csrf`，CSRF 值由当前登录会话派生，可从登录或会话响应读取。

| 平台同源接口 | 当前服务端行为 |
| --- | --- |
| `POST /api/player/register` | 请求 `{app_id, username, password}`。只有正式准入已开放、App 活跃、宿主 Origin 和外部 HTTPS 钱包已配置时才可新建账号；暂停或未准入时拒绝。尚无面向玩家的自助注册页面、验证与找回流程。 |
| `POST /api/player/login` | 请求 `{app_id, username, password}`。符合新玩家准入条件时可登录；准入关闭或 App 暂停后，仅已有该 App 已受理游戏会话的玩家可重新登录以履行恢复义务。响应设置 HttpOnly Cookie，返回玩家、App 内 ID 和 CSRF 值，不返回登录 bearer。 |
| `GET /api/player/session` | 使用 Cookie 读取当前登录玩家及 CSRF 值；过期返回 `401 LOGIN_REQUIRED`。 |
| `POST /api/player/launch` | 带 Cookie、精确 `Origin`、`x-oasis-csrf`，正文包含 `app_id`、`request_id`、已发布 `game_id` 等，不接受 `external_user_id`。新会话须通过准入、App、宿主与只读外部钱包余额探针；失败不创建游戏会话或发放测试币。已有会话以 `resume_session_id` 恢复时，仍校验同一玩家、App、游戏，可在新会话准入关闭后完成受理义务。成功返回一次性启动码。 |
| `POST /api/player/logout` | 使用 Cookie、精确 `Origin` 与 CSRF 值撤销该登录会话。 |

外部钱包余额探针复用现有签名客户端、App scope 校验、HTTPS/地址允许列表及 3 秒超时。钱包必须事先拥有该 App 内用户账户，并按 `wallet-protocol.md` 返回正确的余额响应；平台不会自动开户、迁移参考钱包余额或发币。查无用户、响应无效、超时和网络错误都阻断新游戏会话。游戏内后续扣款与结算仍以钱包原子协议为准。

这些接口只面向平台自身 HTTPS Origin 的浏览器页面。第三方站点不能直接用跨站 Cookie 调用玩家 BFF，也不能用 HMAC 替代玩家登录。目前**没有托管的玩家登录/注册页面、合作方跳转与回跳协议，也没有首发合作方的真实钱包玩家预建与验收**。上线前还需补齐账号验证/找回与滥用控制、合作方跳转协议、真实手机 WebView 验收、钱包账户与账务验收，并由运维明确开启正式准入。以上候选接口不表示生产服务已经对第三方开放。
