# 独立合作方 H5 示例 · Phase F

此目录提供一个可运行的独立 Node 后端和移动 H5 宿主。默认宿主为 `http://127.0.0.1:8800`，平台为 `http://127.0.0.1:8795`，游戏在平台域 iframe 内运行。页面使用 Majlis 示例品牌，与任何已上线 App 无关。

本地示例使用后端配置的固定测试身份；它不是生产用户登录方案。仅接入沙箱测试币，不能用浏览器参数任意选择用户，也不提供充值、发币、修改余额或结算接口。

## 启动前准备

1. 按平台本地启动文档启动数据库、参考钱包、平台 API 和 H5 资源；构建 arena 与 legacy 游戏资源。
2. 在管理后台为专用测试 App 开通需要验证的游戏，配置可用的参考钱包测试用户。固定测试身份必须与该 App 钱包作用域内的用户一致。
3. 将 `http://127.0.0.1:8800` 加入此 App 的 `allowed_origins`。origin 必须精确匹配；`localhost` 与 `127.0.0.1` 不等价。跨域 HTTPS 集成需要逐项登记完整 origin，不允许通配符、路径或 `null` origin。
4. 将仅显示一次的 App `key_id` / Base64 密钥保存到私有配置文件。此示例不附带真实密钥。不要把文件放在本目录、`platform/specs` 或 `platform/public`，不要提交版本库。

示例配置（全部占位值需替换）：

```json
{
  "platform_base_url": "http://127.0.0.1:8795",
  "host_origin": "http://127.0.0.1:8800",
  "key_id": "REPLACE_WITH_APP_KEY_ID",
  "secret_base64": "REPLACE_WITH_BASE64_SECRET",
  "scope": {
    "partner_id": "REPLACE_PARTNER_ID",
    "app_id": "REPLACE_APP_ID",
    "environment": "sandbox",
    "wallet_scope_id": "main",
    "currency_id": "REPLACE_CURRENCY_ID"
  },
  "external_user_id": "REPLACE_FIXED_TEST_USER"
}
```

```sh
chmod 600 /absolute/private/partner-host.json
cd /Users/tyym/Documents/codes/game/platform
node specs/examples/partner-host/server.mjs --config /absolute/private/partner-host.json
```

然后访问 `http://127.0.0.1:8800`。配置必须为普通文件、非符号链接，权限严格为 `0600`。示例服务仅绑定 loopback；生产接入应由合作方自己的已认证后端完成用户映射、会话授权和限流，不能直接公开此单用户示例。

## 实际链路与权限边界

```text
宿主浏览器 → 宿主 Node BFF → 平台 POST /v1/sessions（HMAC）
                                  ↓ 一次 launch_code / session_id / entry_url
宿主 H5 SDK → 平台域 iframe（source + origin + 每窗口 nonce）
                                  ↓ 游戏发送实际 MessageEvent.origin
                      POST /v1/launch/exchange
                                  ↓ Bearer 仅保存在游戏内存
                      平台域游戏 API / 房间 / 权威结算
```

- `public/sdk/oasis-h5.mjs` 是宿主浏览器 SDK；`specs/examples/sdk-node.mjs` 只运行在合作方后端。不要将 Node SDK、App 密钥或 HMAC 请求打包到 H5。
- BFF `/api/host/launch` 仅接受 `game_id`、`request_id`、可选 `resume_session_id`。它使用配置内固定用户和作用域，强制浏览器 Origin 与 CSRF 校验，不接受浏览器身份覆盖。
- Node SDK 将 `zh` 规范为 `zh-CN`，并发送登记的 `host_origin`。重试保持同一业务请求 ID 与正文；新的启动意图使用新请求 ID。
- iframe 游戏的 `ready` 广播不含秘密。SDK 将接收消息绑定到创建的 iframe/popup Window、平台精确 origin、游戏 ID、协议版本和随机 nonce；只向固定平台 origin 发送一次启动码。一次码不进入 URL、localStorage 或日志。
- 兑换提交真实 `MessageEvent.origin`；平台在消费启动码前验证该码的宿主和游戏绑定。跨域 `oasis.launch` 必须使用 V1 nonce 协议。旧管理后台同源窗口保留无 nonce 的启动兼容，但仍验证 exact parent/opener source 与同源 origin。
- 宿主无法读取跨域游戏 Bearer。游戏通过同平台域请求访问 API；宿主不需要 CORS 访问游戏 API。
- `oasis.loaded` 只表示授权加载完成；`return_requested` 是展示层返回信号。二者都不是扣款、派奖或退款凭证。合作方需要通过后端 `client.match(matchId)` / `client.operation(operationId)` 查单，不得根据宿主消息修改余额。

## 宿主 SDK 用法

```js
import { TianhaiHost } from '/sdk/tianhai-h5.mjs';
const game = new TianhaiHost({
  platformOrigin: 'http://127.0.0.1:8795',
  gameId: 'match',
  requestLaunch: async ({ gameId, resumeSessionId }) => {
    // 调用自己已认证的后端；该后端保存 request_id 后调用平台。
    // 返回 {entry_url, launch_code, session_id, expires_at}。
    return requestYourBackend(gameId, resumeSessionId);
  },
  onEvent(event) {
    if (event.type === 'return_requested') game.destroy();
    if (event.type === 'error') showError(event.message);
  }
});
await game.mount(document.querySelector('#mount'));
// 或在同步用户点击回调中调用 game.open()，先创建 popup 再请求一次码。
game.setHostState({ voiceActive: true, muted: false, safeArea: { bottom: 16 } });
game.requestBack(); // 游戏负责处理退出确认；收到 return_requested 后再销毁。
```

`requestLaunch` 属于合作方自己的授权逻辑；SDK 不内置登录、密钥或用户映射。每个实例只挂载一个窗口。iframe 重新加载或超时后，应销毁旧实例并从宿主创建新的启动意图。

SDK 可报告 `loaded`、`reauthorizing`、`host_state_applied`、`return_requested`、`error`、`destroyed`。事件只包含展示元数据和公开 session/room 标识，不包含 Bearer、密钥、金额授权或可用于结算的结果。

## 返回、音频与安全区

- `requestBack()` 发送经过同一通道校验的返回意图。PvP 游戏由公共壳确认退出并等待权威状态；概率游戏停止自动转、显示确认，并提醒已接受结果不会因关闭而撤销。直接关闭 tab 不等于已退款。
- `muted` 是宿主强制静音，`voiceActive` 把游戏音量压低到正常的 25%，`visible:false` 静音。恢复宿主状态不会覆盖玩家自己关闭音乐/音效的选择。浏览器 WebAudio 仍需真实用户手势解锁。
- SDK 监听宿主页面可见性变化。游戏层保留原有可见性处理。
- 安全区输入按四边像素取整，限制 `0..160`，写入游戏 CSS 变量 `--oasis-host-inset-top/right/bottom/left`。此值用于布局，不代表已读取原生设备 inset；原生容器需显式提供真实值。iframe 外已有工具栏占用的空间不要重复传入。
- 游戏按自身状态决定何时返回。宿主发送分数、奖金、余额或胜负字段会被忽略。

## 过期与未知结果恢复

游戏收到 401 后通知宿主 SDK，以原 `session_id` 通过 BFF 申请新的启动码，再由原游戏窗口内存兑换并替换 Bearer。会话继续绑定相同 App / 用户 / 游戏，不创建新的游戏身份。续期和初次启动都有超时；错误必须展示并允许用户返回后重开。

**不会自动重放失败的写操作。** 房间 action 或概率 spin 的未知结果继续由现有稳定业务 ID、查单和原会话恢复流程处理。宿主不能在重试时生成新 user/session 来绕过未完成局。

## 已执行的隔离验收

从 `platform` 目录执行：

```sh
node --test tests/host-sdk.test.mjs
node tests/host-sdk-ui.mjs
```

第二条使用随机 loopback 端口的模拟平台 API、实际 Node HMAC SDK、实际独立 BFF、实际浏览器 H5 SDK、实际 arena client 和 legacy bridge；不调用 8795/8797/8798，也不操作主钱包。Chrome 路径可通过 `CHROME_PATH` 指定。

覆盖：origin 白名单、私有配置权限、12 款菜单、390/360 布局、cross-origin iframe 启动、只在游戏域使用 Bearer、错误 source/nonce 拒绝、host mute / voice duck / 玩家声音设置保留、安全区限幅、401 同 session 恢复、失败写操作不自动重放、返回清理、旧游戏路由桥接。

结果及页面截图：`review/ui-validation.json`、`review/host-390.png`、`review/host-360.png`。截图中的游戏菜单数据来自隔离 API fixture；不应把该报告当作真实合作方钱包、原生 Android/iOS WebView、公网部署或生产接入验收。真实平台端到端验收由 Phase F 主集成脚本另行记录。

浏览器安全依据：[postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)、[CSP frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)、[CSS env 安全区](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env)。
