# OASIS POOL — Phase E local playable sample

The two-player eight-ball sample uses an authoritative, serializable server engine and a mobile Canvas 2.5D table. It is registered by the parent platform, which owns authentication, room membership, request deduplication, fees, wallets and settlement. This directory does not issue wallet commands. Practice bots use the same legal action interface as players; the platform must not insert bots in paid rooms.

## Versions and source boundaries

- Rules: `pvp-pool-v1.0.0` (`engine.mjs`). This is the project's explicit casual eight-ball variant, not a claim of tournament certification.
- Shared geometry: `oasis-pool-six-pocket-v1` (`geometry.mjs`). The physics and renderer share the same six pocket coordinates and table/ball dimensions.
- Physics: `oasis-pool-fixed240-v1` (`physics.mjs`). Server fixed-step simulation; the browser interpolates recorded trajectories.
- UI: `PoolGame.jsx`, `table.mjs`, `pool.css`, `club.svg`.
- `preview.*` is a separate, zero-value QA harness. Its fixture controls are not imported by the platform entry and are not a production API.

## Server contract

The engine exports `createState(seedHex, now, {players})`, `act(state, playerKey, action, now)`, `tick(state, now)`, `forfeit(state, keys, now)`, `shiftTime(state, deltaMs)`, `view(state, playerKey)`, `rank(state)` and `botAction(state, playerKey, now)`. Mutations operate on the supplied state and return `{state, event?}`. `shiftTime` returns the state directly. Store the complete JSON state, including pending simulation and absolute timestamps, before acknowledging an action.

Two unique players must have frozen `seatIndex` values 0 and 1. The server supplies a 64-character hexadecimal seed; it deterministically chooses the rack and first player. The seed is absent from public views. The platform supplies monotonically increasing server milliseconds and performs request-id/sequence deduplication outside the engine.

Accepted client actions are exactly:

```js
{ type: 'place', x, y }                  // safe full-table placement, ball-in-hand only
{ type: 'call', pocketId }               // integer 0..5, own group already cleared
{ type: 'shot', angle, power, spinX, spinY }
```

`angle` is radians in `[-π, π]`; zero points toward the top of the table. `power` is `[0.02, 1]`; both spin components are `[-1, 1]` and required. Positive `spinY` is follow; negative is draw. Extra fields, positions supplied on a shot, scores, collision results, invalid numbers and out-of-turn or busy actions are rejected. Placement and calling never reset the turn clock or consecutive-timeout counter. All outcomes and collisions come from server simulation.

Public view includes balls, player groups/scores, current turn, deadlines, ball-in-hand placement state, called pocket, eligibility, global `lastAction`/`lastEvent`, `shotId`, `shotStartedAt`, `busyUntil`, `trajectory` and collision/pocket events. Preserve the global latest shot so opponents and practice bots animate for all viewers. A pending shot resolves only at `busyUntil`; refreshing or sending more actions cannot fast-forward it. `rank` returns `playerKey`, `rank`, `score`, `scoreLabel`, `forfeited`; a legal called-eight winner scores eight (seven group balls plus black eight).

## Rules fixed for this candidate version

1. A rack contains 1–15 once each, black eight in the third-row center and opposite groups at the two back corners. The break never assigns groups. A legal break pots any object ball or makes at least four **distinct** object balls reach a rail, after valid first contact. A frozen ball must leave its rail before its later return counts. A potted/ejected break eight is respotted; it does not decide the match. A break foul grants the opponent full-table ball in hand. A legal break with an object pot retains the turn; a dry legal break changes it.
2. On an open table after the break, first contact must be a colored object ball, not eight. The first legal colored pot assigns that group to the shooter and the other group to the opponent. If several balls enter, earliest simulated entry wins assignment, with ball number resolving exactly simultaneous entry. This is an event-order convention, not a player-id tiebreak. A foul does not assign groups.
3. Once assigned, first contact must hit the shooter's group; after it is cleared, first contact must be eight. After valid first contact, a ball must enter a pocket or reach a rail. Own legal pots retain the turn. A miss or only an opponent's pot switches turns. Opponent pots remain down, including on a foul.
4. Cue scratch/ejection, wrong or missing first contact, no valid post-contact rail/pot, object ejection and an authority-reported double hit are fouls. They grant full-table ball in hand, with explicit legal placement required before shooting. A non-eight object ejected from the table is respotted, first at the foot spot, then deterministic safe locations along the long axis and rings. Cue placement cannot overlap balls, pockets or bounds; a ball legitimately frozen to a rail can still be struck.
5. The shooter must clear all seven group balls **before** the black-eight shot and publicly call a pocket. A legal eight in that called pocket wins. An early eight, wrong-pocket eight, eight with a scratch/other foul, or an ejected eight loses. Clearing the last group ball and eight in the same shot is an early-eight loss. The eight is the only ball requiring a called pocket.
6. Aiming/placement/calling share a 20-second turn. Timeout is a foul; three consecutive timeouts forfeit. Only an accepted physical shot resets that player's streak. After 10 minutes or 100 accepted shots, an already accepted moving shot finishes; fewer remaining group balls wins. Equal remaining counts or a still-open table tie. No player-id winner is manufactured.
7. Batch `forfeit` advances due simulation and timeout state without deciding survivor victory first, then applies the entire quitting/disconnected roster once. Both players forfeiting yields `outcome: 'void'` and no winners. A completed legitimate black-eight outcome remains fixed even if quit processing arrives at the same time. Room-level disconnect windows, full refunds and tie economics belong to the platform contract.
8. A non-finite result, an unresolved 12-second simulation, or an impossible respot enters `phase: 'fault'`; it is not silently converted into a win or loss. The parent platform's fault pause/void policy applies.

## Physics, replay and payload budget

The solver uses 240 Hz equal-mass discs, two collision passes, friction, ball/cushion restitution and bounded spin energy. Replay samples at 30 Hz and records only changed balls. Each frame is `{t, positions:[[number,x,y,active,roll], ...]}`; omitted balls retain the preceding sample. The renderer expands this sparse data locally once per new shot and interpolates motion. The authoritative final coordinates retain more precision than visual samples.

Spin is an arcade approximation: one decaying follow/draw impulse on the first cue/object collision and one decaying English impulse on the first cue/cushion hit. The table has planar cushions and circular pocket capture regions. This is not a full three-dimensional rigid-body model: no jump shots, masse, cloth deformation, cue elevation, pocket-jaw meshes or continuous cue-stick double-contact simulation. Ejection/double-hit adjudication is covered by authority-side rule fixtures; ordinary planar actions do not generate cue jumps or held-stick double hits. These limitations are explicit rather than presenting those fixtures as physical feature proof.

Local Node 22.22.3 / macOS arm64 measurements over eight complete deterministic bot games (246 shots) are stored in `qa/physics-budget.json`: maximum full public view 22,163 bytes, mean 6,757 bytes, median shot computation 4.76 ms, p95 11.32 ms, observed maximum 33.99 ms, and longest simulated roll 4,096 ms. These are observed sample bounds, not production load or device performance guarantees.

## Mobile interaction and visual provenance

The reference was inspected at `output/design/pvp-arena-concepts-v1/06-pool.png`: teal cloth, walnut/metal six-pocket table, gold detailing, numbered balls, cue/aim geometry, player HUD, horizontal power, spin ball and gold shoot control. The playable table is drawn from geometry; the reference is not used as an interactive background.

All shipped Pool artwork is original source-authored Canvas/CSS/SVG: table grain and cloth pattern, brass collars, rails, ball/stripe/number rendering, cue, portraits, club arch, lamps and filigree. `club.svg` is a small environment illustration, not a screenshot, licensed third-party image or generated bitmap. No raster artwork download or external font is required. Lighting sweeps, drifting dust, rolling ball texture, collision flashes, pocket particles and called-eight effects are time-dependent. Shot/hit/rail/pot/win callbacks use the platform AudioBus. The local QA audio mock verifies callback delivery/control only; it does not prove audible device playback or background music quality.

- Tap the table to aim. Drag backward from the cue ball to adjust angle and power, or use the horizontal power slider. Two small controls provide angle adjustment.
- Tap/drag the white spin control to choose follow/draw and English; double-tap/double-click resets it.
- With ball in hand and no confirmed placement, tap and release an empty table point to place the cue. The move-cue control or dragging near the placed cue permits repositioning within the same turn. The server validates the point.
- Once the group is cleared, tap a real pocket to call it; shooting stays disabled until a pocket is selected.
- Stable selectors: `pool-board`, `pool-shoot`, `pool-power`, `pool-spin`, `pool-exit`, `pool-audio`. The first header button exits; the last toggles audio. Both have localized accessible labels.
- Board coordinate to pointer ratio is `xRatio = 0.5 + x / 8.1`, `yRatio = 0.5 + y / 14.8`. Pockets 0–5 run top-left, top-right, middle-right, bottom-right, bottom-left, middle-left. RTL chrome preserves this physical world orientation.

## Verification and reproducibility

From the repository root:

```sh
node --test platform/tests/pool-engine.test.mjs
node platform/node_modules/vite/bin/vite.js --config platform/arena/pool/preview.config.mjs
# In another terminal, with the isolated preview running:
node platform/tests/pool-ui-qa.mjs
```

The isolated preview uses port 18108 and its own Vite cache. Stop it after review. It does not start or replace any platform service on 8795/8797/8798.

- `qa/engine-report.tap`: 22 passing tests covering physical determinism/persistence, illegal inputs, distinct break rails, break-eight respot, group assignment, fouls, explicit free placement, frozen rail behavior, called/early/wrong-pocket/ejected/scratched eight, actual physics-driven called-eight victory, deadlines, 100-shot limits/ties, batch forfeits, completed result preservation, sparse trajectories and finite bot completion.
- `qa/browser-report.json`: actual Chrome pointer/touch interactions in 390×844 Chinese, 360×800 English and 390×844 Arabic desktop mobile emulation. It verifies aiming, power, spin, accepted shot/busy state, real pocket calling, physics-driven called-eight win, free-ball placement, mute and exit, no horizontal/vertical overflow and no page errors.
- `qa/*-motion.png`, `qa/*-eight.png`, `qa/*-win.png`: rendered gameplay evidence. The late-rack fixture removes the shooter's seven group balls before an actual physical called-eight shot; it is explicitly a zero-value local rule/UI fixture, not a real wallet settlement.

Physical iOS/Android WebViews, audible sound quality, hardware frame time, reconnect over a real network, partner wallets and paid settlement require the parent platform/device acceptance path. The local preview is not evidence that those gates have passed.
# 2026-09-19 视觉恢复 v2 补充

以 `06-pool.png` 为基准，PLAY/MOMENT 已换为独立生成的午夜胡桃木会所场景、共享原创人物头像，并压紧标题/比赛信息以扩大球桌舞台。桌面仍逐帧 Canvas 绘制：定向木纹、袋口黄铜角板、枱呢边缘压痕与遮蔽、精细球面高光、锥形镶嵌球杆及握把。球杆瞄准和出杆短跟进仍取真实输入；球体拖尾、进袋圈和粒子只播放权威轨迹及 pocket 事件。视觉投影 y=0.80；世界坐标、触摸逆映射、六个真实袋口和所有碰撞规则不变。

新背景 `assets/midnight-club.png` 来自内置 imagegen，完整提示词在 `assets/midnight-club-prompt.txt`，原图在 `/Users/tyym/.codex/generated_images/01a0b06a-2b67-73d2-8819-3164d148773c/exec-17ad8309-6ee3-4d0f-96bf-e8bf5769ac10.png`。背景不含球桌/球/文字/按钮；交互玩法全部保留为动态代码。

最新 UI 证据以 `review-v2/` 为准：390×844、360×800 无横向/纵向溢出，无 pageerror。显式零价值黑八测试盘面中，真实触摸叫右上袋、瞄准和 .64 力度出杆，得到 40 帧轨迹，黑八于 t=975ms 入指定袋，真实结果为 `called-eight`；附 aim/motion/pocket 截图和 JSON。该测试盘面是公开标注的局部情景，不冒充付费整局或平台钱包证明。脚本在 `../carrom/qa/visual-restoration.mjs`。

已保留金额修复，既有 `tests/pool-money-ui.test.mjs` 三项全部通过：10000→100、19000→190、小数币及 FREE，冻结 room 不变。三款引擎 60 项保持通过。本轮没改 engine/physics/geometry。素材 PNG 尚未做发布压缩；实体设备性能、完整弱网和最终美术验收另行进行。共用胜利页由平台负责。

## Fixed-view restoration V3

See [RESTORATION-V3.md](RESTORATION-V3.md) for independent asset layers, exact geometry boundaries, original source/prompts, screenshots and actual local-engine UI validation.
