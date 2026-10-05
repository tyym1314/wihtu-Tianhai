# Darts 301 · local integration

This module is a playable mobile browser implementation with an authoritative deterministic rule engine. It is not a standalone authenticated launcher or production release. The platform owns admission, player identity, wallets, heartbeat, persistence, settlement and immutable results. No funds are handled here.

## Integration

```jsx
import DartsGame from './darts/DartsGame.jsx';
<DartsGame room={room} me={externalUserId} onAction={sendAction}
  audio={sharedAudio} onExit={leaveRoom} locale="zh" />
```

`room.game` is `engine.view(state, me)`. `room.server_now` is Unix milliseconds; `room.status` is lowercase. `room.practice`, `entry_minor` and `prize_minor` supply the HUD. `onAction(action)` resolves `{room,event}`. The shared audio object supplies `unlock()`, `play(kind)` and `setEnabled(boolean)`. The UI emits shot/hit/win/click hooks and uses global `view.lastEvent` to animate other players' throws as well as the caller's response.

### Input and geometry

```json
{"type":"throw","gesture":[{"t":0,"x":0,"y":0.3},{"t":100,"x":0,"y":0.2},{"t":200,"x":0,"y":0.1}]}
```

The UI records an actual pointer hold/drag/release. Coordinates use the double ring's outer radius as 1; y points down. A request needs 3–128 strictly ordered samples, 80–2000 ms, meaningful travel and bounded movement speed. A click or a requested sector/score/landing is rejected. `geometry.mjs` is shared by the SVG target, aiming preview and authoritative engine; the documented release mapping adds 10% of total displacement and 15 ms of recent release velocity to the final sample. It contains no hidden random dispersion. The cosmetic release-control strip is not a calibrated force gauge.

Rules: two players, 301 straight-out, three darts within one 20-second turn, entire-turn rollback on a negative remainder, a legal remainder of 1, equal-round checkout and a maximum of 10 equal rounds. A valid zero-point miss resets the timeout streak. Three personal turns without any valid throw cause forfeiture. Batch forfeiture is resolved atomically before choosing a survivor; a previously finished outcome cannot change.

Exports: `RULE_VERSION`, `createState`, `act`, `tick`, `forfeit`, `shiftTime`, `rank`, `view`, `botAction`. Functions mutate the supplied state; complete state is JSON serializable. BOT actions are ordinary legal gestures; the platform may only use them in explicitly free practice.

## Verification

From `platform/`:

```sh
npx tsx --test tests/darts-engine.test.mjs tests/domino-engine.test.mjs
node tests/darts-domino-ui.mjs
```

The browser script builds its own temporary assets and binds an ephemeral `127.0.0.1` HTTP port. It uses installed Google Chrome (`CHROME_PATH` may override it), does not touch the running Vite/API processes and removes temporary files when complete. `review-harness.jsx` is test-only and deliberately has no session/wallet integration.

- [Rule TAP evidence](rules-validation.tap): 15 darts + 15 domino tests.
- [Browser report](review/ui-validation.json) and [QA notes](review/QA.md).
- [390 px bull impact](review/darts-390-hit.png), [360 px triple 20](review/darts-360-triple20.png), [390 px in-flight frame](review/darts-390-flight.png).

The delivered arena is code-rendered SVG/CSS with pointer input, aiming preview, flight, impact, score celebration and ambient lighting. The engine, desktop browser emulation and audio-call wiring have been checked locally; real Android/iOS WebViews, real devices, audibility on hardware, regional networking and production fair-play review remain outside this evidence. It does not establish visual superiority to an external commercial game.
# 2026-09-19 视觉恢复 v2 补充

依据 `04-darts.png` 的 PLAY/MOMENT，替换几何城市剪影为独立生成的蓝紫夜宫室内场景（雕金拱门、火盆、灯笼、大理石反射），复用共享原创人物头像。SVG 靶盘增加金属包边、固定螺钉与纤维材质，靶区几何仍来自原 `geometry.mjs`。新 `DartVisuals.jsx` 绘制金属针尖、车削镖身、轴与黑蓝金边尾翼，包含待投、飞行和入靶形态。

修复了原先“箭头始终飞向圆心”的可见错误：新飞行按实际 `event.hit.x/y` 插值，针尖落点与权威结果一致；时长读取 `at/busyUntil`（当前规则650ms），迟到事件只补剩余演出，不重新完整播放。入靶保留当前回合已投飞镖；冲击粒子围绕真实命中点。分数/爆分/归零全部读取服务器事件，不在客户端重新计算判分。

背景 `assets/night-room.png` 由内置 imagegen 生成，完整提示词在 `assets/night-room-prompt.txt`；原图 `/Users/tyym/.codex/generated_images/01a0b06a-2b67-73d2-8819-3164d148773c/exec-c0980f5e-4e33-4d2b-ab16-0126670d9f57.png`。背景没有靶盘、飞镖或界面，玩法并非截图。

独立 Vite 预览：`platform/node_modules/.bin/vite --config platform/arena/darts/preview.config.mjs`，端口18111、专有缓存，URL `/preview.html`。本轮综合脚本 `../carrom/qa/visual-restoration.mjs` 提供偏心命中的恢复专项验证；原跨游戏 `platform/tests/darts-domino-ui.mjs` 也已升级素材路由与动画时序，可继续独立运行。最新证据在 `review-v2/`：390×844、360×800 均无横向/纵向溢出和 pageerror；实际录制手势命中偏心位置 x=.3、y≈-.43，18分，301→283；飞行层目标与最终针尖 data 坐标精确等于权威 hit，并保存 before/flight/hit 截图。没有直接伪造分数或命中结果。

本轮未改引擎或手势映射、未请求钱包。三款规则测试60项通过。独立 Chrome 移动视口证据不是原生真机或生产网络验收；当前使用 SVG 的2.5D飞镖，没有声称已经制作 Blender GLB。共用胜利页由平台负责。

### 跨游戏原测试兼容性

原 `tests/darts-domino-ui.mjs` 现直接处理 PNG/WebP file-loader 产物和静态 `new URL(..., import.meta.url).href`，并为 `/arena/assets/` 提供限制于真实 public 素材目录的路由。截屏前对实际 CSS 图片调用 `Image.decode()`；所有图片响应需 HTTP 200 和正确 image MIME，包含共享肖像 WebP。飞镖选择器从已删除的文字箭头改为 `data-testid=darts-flight` 的金属镖，同时断言其目标坐标和最终入靶坐标；完成时间取实际650ms事件并等入靶层，避免旧620ms固定等待造成假失败。

Domino 保留原合法出牌、手牌减1、牌链加1、同伴事件、连续抽2停下、牌堆余1和28牌全链匹配断言。恢复版先播放手牌飞行，原 `do-land` 被推迟到飞行结束，因此测试增加 `do-hand-flight` 运行断言，等飞行层消失后再验证 `do-land`，没有移除或放松落地动画断言。390/360两宽、Domino 2/4人都已通过；结果与截图仍在两游戏原 `review/` 目录。

## Fixed-view restoration V3

See [RESTORATION-V3.md](RESTORATION-V3.md) for independent asset layers, exact geometry boundaries, original source/prompts, screenshots and actual local-engine UI validation.

## First-person ready pose V4

See [RESTORATION-V4.md](RESTORATION-V4.md) for the larger Blender-baked ready dart, its separation from authoritative hit anchors, three-width touch/flight/score verification and before/after recordings.
