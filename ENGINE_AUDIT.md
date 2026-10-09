# 13 款游戏引擎与移动性能审计

初始审计日期：2026-10-09。以下保留优化前的审计基线；后续已实施变更与验证以 [PERFORMANCE_OPTIMIZATION.md](PERFORMANCE_OPTIMIZATION.md) 和 [SYNC_DESIGN.md](SYNC_DESIGN.md) 为准。源码基线：`master / e1f6ead1e8fe6301878b40909061daa14b877ec1`；应用源码对应已发布 `1a567d3`、Public `20261009-02`。本次检查当前代码、构建依赖、运行资源、Blender 源模型及隔离渲染；不把旧报告中的测试通过替代当前手机验收。本文供其他电脑上的同事接手。

## 技术判断

**现有引擎组合基本适合手机网页，当前实现仍有明显优化空间，不能称为性能最优或已达到手机上线标准。** 保留 Three.js 的三款实时 3D、Canvas2D 的桌面物理与占塔、DOM/SVG 的小棋盘和概率游戏。先处理状态同步、首局资源、每帧绘制与重复 UI 更新；没有证据支持现在整体迁移到另一个引擎。

“渲染引擎、规则/物理、状态同步”是三个不同职责。前端显示应独立于权威规则；正式投球由服务端物理工作线程算出轨迹，网页插值播放，这个方向合理。自研规则需要版本固定、确定性回放与完整局验证。采用知名引擎不会自动解决规则、接口延迟或关卡质量。

已有标准继续采用 `platform/specs/mobile-quality-v1.md` / `.json`：冷入口 P95≤5s、热入口≤2.5s、关键静态 encoded bytes≤3MiB；至少60s活动帧间隔 P95≤20ms、P99≤34ms、最大≤100ms；必须同时检查持续位移。每款冷热各5次，主设备 iPhone 15 Pro/Safari 真机至少15分钟或3完整局中较长者及30次操作。**本次工程诊断不改变这些门槛。** 当前 ADB 5038 没检测到实体 Android，iPhone 的“全程卡”仍未验收。

## 逐款结论

13 款注册来源为 `platform/shared/games.mjs`：11款 Arena + Thunder/Tiger。以下风险来自当前源码；只有后文明确标为实测的项目才有本轮性能样本。

| 游戏 | 实际运行方案 / 判断 | 优先检查或优化的具体点 | 源码位置 |
| --- | --- | --- | --- |
| 沙丘竞速 Run | Three.js + 自研运动/权威输入协议；保留 | P0：120tick/2秒预测边界耗尽时运动停走，必须联动服务端提交、协议协商、输入与呈现。已有DPR1.2、关手机阴影/AA、裁剪、实例合批和分帧纹理上传。运行角色是atlas，不能用保留的骨骼GLB体积归因当前卡顿 | `arena/run/practice-controller.mjs:9`、`scene.mjs:78,193,200`、`characters.mjs:57` |
| 保龄球 Bowling | Three.js + 服务端 Cannon 刚体；保留 | P1：每帧平面反射 + Bloom多级后处理；10瓶约89,600三角面。对照手机低模瓶、低频反射和简化Bloom。球GLB中161,036B的内嵌PNG在运行中被外部材质替换，可做去冗余候选 | `arena/bowling/scene.mjs:28,54,62`、`art.mjs:36`、`physics.mjs:14` |
| 高尔夫 Golf | Three.js + 自研确定性平面物理；保留 | P1：首入口等全部3球场和8纹理解码；手机仍有1024²动态阴影及Water镜面pass。按首洞准备/下一洞预取；烘焙环境阴影、保留球接触阴影。拖瞄准时同步物理预测与重建Line/Ring，应合并采样、复用几何后测量 | `arena/golf/art.mjs:6,41`、`scene.mjs:51,61,68,143` |
| 消消乐 Match | React DOM 6×6棋盘 + CSS/精灵图；规模适用 | P1：相同棋盘快照仍产生新数组；每波`flushSync`后读布局。保留必要动画初态，测连锁大消除的布局/raster，隔离静态Gem与HUD。已有时钟可见边界门控 | `arena/match/MatchGame.jsx:24,34,51` |
| 连线占塔 TowerLink | Canvas2D独立RAF + React HUD/hitbox；保留 | P0：最新权威时间+1400ms后停止外推，需区分士兵停走和掉帧。P1：100ms全组件时钟、每pointermove更新React；用边界时钟与每帧一次手势预览。已具备地形缓存、投影缓存、后台停帧和渐进资源 | `arena/towerlink/TowerLinkGame.jsx:47,61`、`tower-scene.js:56,82`、`troop-presentation.mjs:53` |
| 飞镖 Darts | React/SVG靶面 + RAF直写飞镖；保留 | P1：全游戏50ms时钟；拖动读矩形并setAim。隔离倒计时/准星，缓存有效布局、保留完整输入轨迹。静态靶已memo，飞行不需搬到React每帧状态 | `arena/darts/DartsGame.jsx:15,53,63,73`、`DartVisuals.jsx:16` |
| Ludo | React/SVG棋盘 + CSS动画；保留 | P1：100ms共享时钟让未memo棋盘重复遍历；每次新legal对象及callback削弱memo。静态格子、动态棋子和HUD分层；骰子/吃子期间保留动效 | `arena/boardkit/ui.jsx:8`、`arena/ludo/LudoGame.jsx:15,17` |
| Jackaroo | React/SVG + 自研合法牌/路线；保留 | P1：已有Board memo/派生计划memo，但轮询players新引用仍更新display。用规则状态版本保留相同状态引用，不截断合法拆七选项 | `arena/jackaroo/JackarooGame.jsx:18,24`、`arena/boardkit/ui.jsx:16` |
| 多米诺 Domino | React/SVG牌链 + CSS飞牌；保留 | P1：时钟已门控，但新server_now仍提交、重复牌链布局及多牌SVG阴影。隔离HUD、memo牌面与牌链，只在事件/尺寸变化读几何；复杂中盘测raster | `arena/domino/DominoGame.jsx:17,20,26` |
| 八球 Pool | Canvas2D + 服务端自研平面物理；保留 | P1：静态桌面缓存正确；闲时仍清屏/全绘、球渐变与轨迹filter/find。静态/动态层、闲时降频、缓存球阴影、时间索引轨迹；出杆/碰撞保持完整帧率 | `arena/pool/table.mjs:23,31` |
| Carrom | Canvas2D + 服务端自研平面物理；保留 | P1：棋盘缓存/预渲染素材正确；闲时重绘和逐帧数组构造仍可减。按变化重绘，移动轨迹用游标索引；不要新增无必要实时3D | `arena/carrom/board.mjs:45,58` |
| Thunder | 原生TS DOM/WAAPI + Canvas2D粒子；保留 | P1：空闲仍有环境粒子、闪电与绘制，演出阶段innerHTML更新；已有200粒子和DPR1.75上限。分idle/首转/连消/大赢测量，缓存重复渐变与预渲染光效 | 根目录 `src/main.ts:117`、`src/ui/motion.ts:13,95,296` |
| Tiger | 原生TS DOM卷轴/WAAPI + Canvas2D粒子；保留 | P1：长卷轴filler重建和blur raster；无粒子仍清Canvas/RAF；burst无统一总粒子限额。空粒子停帧/事件唤醒，统一上限，再测strip复用和blur成本 | 根目录 `src/tiger/effects.ts:33,75,80` |

表中 `arena/` 路径均在 `platform/` 下。所有逐帧或降频调整都要保留权威结果、输入取消/过期校验、完整合法动作和演出含义。若未来大规模2D粒子或精灵需求证明DOM/Canvas超过预算，可对单款场景层做PixiJS原型A/B；当前无必要全项目统一迁移。早期 `architecture-decisions.md` 的“2D采用PixiJS”是方案描述，当前发布实际并没有该依赖，不能作为已落地事实。

## 本轮与既有运行证据

### 当前 Run 隔离渲染

本轮实际运行当前RunGame/WebGL/资源，Chrome Metal、390×844/DPR3、CPU×4；CDP网络20Mbps下行/5Mbps上行/50ms。生产渲染会选择手机DPR1.2。真实规则引擎在loopback Node服务端运行，19次合法服务端autopilot动作、4次hit，约475.73m，观察62.333秒。

| 指标 | 本轮结果 | 解释 |
| --- | --- | --- |
| RAF帧间隔 | 3,719样本，P95 16.7ms，最大16.8ms，>50ms为0 | 回调节奏；不是GPU完成或显示合成FPS |
| 主线程长任务 | 0 | 有支持的PerformanceObserver；活动窗口 |
| 活动场景CPU | P95 2.4ms，最大4.6ms | 含准备和WebGL提交；未测GPU执行时间 |
| 每帧draw calls | P95 133，最大152 | 实际可见场景，不能拿GLB唯一网格数代替 |
| 每帧三角形 | P95 169,776，最大184,016 | 场景复用使其高于19,152的模型唯一面数 |
| GPU对象计数 | textures始终10；geometry 21→58、峰58 | 对象数，非GPU内存字节，非进出10次泄漏验收 |
| 首帧 / 首个可输入观察 | 2,900.5ms / 4,694.7ms | 一次冷隔离样本，含本地夹具产物加载；不构成公网LOAD-01 P95 |

范围限制：使用`pvp-run-v2.1.0` scene-ready公平开局夹具，**不包含公网v2.3免费练习输入权威协议**；动作不是手机可信手势。测试只支持当前渲染路径在此工程环境平稳，不宣称用户手机问题解决。旧QA probe与当前scene插入点不匹配，首次构建失败已保留；只在被忽略的审计副本适配采样hook后重跑，未修改生产源码。约106ms初始render位于加载阶段，活动窗口最大4.6ms，不混在一起算。

### 当前 Golf / Bowling 隔离出球

另用未修改的当前真实组件与scene串行测量，Chrome/Apple M4 Pro Metal、CPU×4、390×844/DPR3，生产手机画布分别为487×1055（Golf）和468×518（Bowling）。规则`createState/tick/act`在loopback Node端执行；保留Golf网页中真实的瞄准物理预览。模型与纹理实际解码后、第5秒各一次可信UI按钮投球，两款各60秒前台。静音、局域loopback、夹具100ms快照而非生产500ms；不覆盖公网、声音、手机GPU/温控与多种关卡。测量的大部分是投球前后等待，已分别保存出球阶段，不能称为60秒连续出球压测。

| 指标 | Golf | Bowling |
| --- | ---: | ---: |
| 前台观察时长 | 60.014s | 60.004s |
| 全窗口RAF P95 / P99 | 16.7 / 16.8ms | 16.8 / 16.8ms |
| 等待状态draw calls P95 | 320 | 165 |
| 等待状态三角形P95 | 821,428 | 251,684 |
| 已受理运动阶段draw calls P95 | 314 | 127 |
| 已受理运动阶段三角形P95 | 821,172 | 248,644 |
| 全窗口最大RAF间隔 | 366.7ms | 183.3ms |
| 活动窗口主线程长任务 | 0 | 0 |

两款最大间隔均与诊断工具的中途截图窗口重叠，原始样本/截图时间均保留，不能直接归因引擎，也不能删掉之后宣布FRAME通过。没有GPU完成耗时；GPU预算判断来自实测绘制量与当前pass结构。两款真实动作各恰好1次被权威引擎接受，页面无异常、关键资源无错误，独立浏览器/上下文/Node服务均完成清理。`diagnostic-complete`只表示诊断数据完整，`performancePass`仍为null。结果进一步支持先减少多pass/LOD/闲时重绘的工作量，再做真机配对验证。

### 公网 Run 的运动证据必须独立保留

既有Public01捕获过333.3ms位置/RunnerZ/CameraZ停顿，精确达到head+120预测上限，同期帧间隔仍平稳。Public02 Android真机60.163秒有9条准确输入回执，RAF P95 16.8ms/最大66.6ms，但运动分析仍`review-required`、整体测试因退出iframe观察失败为false。最大权威更新间隔811.3ms；若干0.765s/1.481s停顿与回退没有精确事件绑定，可能包含合法碰撞/复活，不能全部算网络卡顿。

因此Run先修复并验证同步协议边界，不应只抬客户端常量、无限外推或平滑掉合法落水，也不能用本地渲染样本抵消公网失败。

## Blender 与资源复杂度

已从官方源安装Apple Silicon **Blender 4.5.14 LTS** 到本机 `/Users/tyym/Applications/Blender.app`；SHA256与官方清单一致、应用代码签名验证成功。实际在`--background --factory-startup --disable-autoexec`下读取7个原始`.blend`，包括modifier求值后的三角面统计。未保存或覆盖源模型，检查后原始文件SHA保持一致。Blender用于离线模型、LOD、烘焙和素材制作，不是网页运行引擎。

| 当前运行资源 | GLB文件字节 | 唯一三角形 / 重要乘数 |
| --- | ---: | --- |
| Run runtime环境 | 933,776 | 19,152；完整原始源28,988，已裁掉未使用Palace |
| Bowling场馆 | 211,260 | 24,816 |
| Bowling单瓶 | 17,856 | 8,960；10瓶89,600，源文件实查完全对应 |
| Bowling球 | 204,732 | 9,626；其中161,036B内嵌PNG的运行材质已替换 |
| Golf球场1 / 2 / 3 | 571,528 / 596,684 / 567,300 | 97,276 / 100,624 / 96,520；3份可编辑源实查对应 |
| Golf植物库 | 77,388 | 12,710，运行场景还会重复实例 |

这些是GLB定义中的原始accessor计数，不是可见帧总量。Draco能减少下载字节，解码后仍有同样几何工作。优先制作保龄球手机瓶/球LOD候选，保留轮廓、红圈、孔与材质；对远景细分和隐藏面做减法。Golf用分层LOD和静态光照/AO烘焙。**视觉LOD不得修改权威碰撞/得分参数；候选必须在浏览器真实相机下与原画质逐场景A/B之后才可发布。** 当前源模型本身没有隐藏modifier再放大的问题。

Three r180的[Reflector](https://raw.githubusercontent.com/mrdoob/three.js/r180/examples/jsm/objects/Reflector.js)与[Water](https://raw.githubusercontent.com/mrdoob/three.js/r180/examples/jsm/objects/Water.js)会再render一次场景；缩小反射纹理不消除遍历/顶点工作。[UnrealBloomPass](https://raw.githubusercontent.com/mrdoob/three.js/r180/examples/jsm/postprocessing/UnrealBloomPass.js)仍做多级模糊，低strength不等于没有成本。可对照低频镜面捕获、近景提高更新率、保留波纹/霓虹局部光效；不能凭去效果后的帧数宣布品质更好。

## 构建、加载与缓存

11款Arena已经`React.lazy/import()`分款加载（`platform/arena/main.jsx:4-31`）；Three只有Run/Golf/Bowling依赖，无初始Three modulepreload。Thunder/Tiger独立boot。`dist/assets`约51.9MB包含回滚兼容旧指纹资源，不是首屏全部下载量；不能删除旧URL来假装加速。

当前主要机会：Golf首洞/下一洞分级；Match庆祝图、概率游戏免费转/胜利图按演出阶段准备；在首帧与第一次特效之间明确安排decode/GPU预热。公共Image Map会去重并移除失败项，但成功decode对象保留至模块寿命，缺字节预算及演出优先级。它不是已证明内存泄漏；重复进出与真实页面生命周期需要实测。

本地显式图集集合：Match 1,659,100B / 单份RGBA理论约30MiB；Tower 1,912,148B / 约30MiB。Darts/Ludo/Jackaroo/Domino分别932,586/605,626/752,426/809,990B（这些后四集合另有223,600B共用头像）。压缩文件小不等于解码或多份raster内存小，应按实际CSS尺寸和atlas使用率控制，不能拿RGBA理论值声称进程/GPU实测。

本轮严格TLS、默认DNS、禁代理的6个公网静态GET确认：HTML no-store；哈希JS/GLB/atlas immutable一年；非哈希`gems-v2.webp` must-revalidate。index JS线上gzip body126,485B、Three180,992B、runtime GLB271,585B。条件GET可以304/0body，但gems一次验证仍花约312ms。这是桌面单连接观测，不是受控手机入口延迟或服务器定罪。

缓存方向合理；没有发现Service Worker并不代表没有缓存。逐步把非哈希运行素材内容指纹化，保留旧URL/回滚。构建时预生成高等级gzip，按可用服务模块评估Brotli；验证Content-Encoding/Vary/ETag/304和实际encoded bytes。本地gzip6估算比线上明显小，[Nginx默认gzip等级是1](https://nginx.org/en/docs/http/ngx_http_gzip_module.html)，不能用Vite压缩估算冒充线上达标。HTML、会话、钱包及权威房间仍保持原实时策略。

## 同事执行顺序与验收

1. **P0 Run与Tower运动连续性**：同步记录实际显示坐标、权威tick、请求/服务处理时长与合法碰撞事件。解决权威停滞及预测窗口策略；Run方案需同时处理版本兼容、历史提交和每帧CPU预算。先隔离延迟/恢复回放，再当前公网与真机。
2. **P1 Golf/Bowling资源与GPU**：首局分级、LOD/烘焙、反射/后处理A/B；真实拖瞄准、出球、碰撞、近景和大演出分开比较。保持原画质基线；至少三次同机同场景配对，记录CPU、GPU可用指标、draw calls、encoded bytes、温度/持续时间。
3. **P1全游戏UI与闲时调度**：倒计时边界提交、同状态稳定引用、棋盘/牌面/HUD分层、手势预览每帧一次；粒子和闲时Canvas做事件唤醒/预算。保持触控反馈≤100ms和取消0请求/有效操作恰好1请求。
4. **P1热冷缓存与运行资源所有权**：指纹/预压缩、首帧与演出分级；进入退出10次检查RAF/worker/texture对象和可测内存趋势。不能只看到dispose就认定无泄漏；Three资源需[明确释放](https://threejs.org/manual/pages/how-to-dispose-of-objects.html)。
5. **移动上线验证**：逐款完整局、最复杂中盘、首次特效、弱网/断网/切后台；冷热5次与主设备长测。逐款记pass/fail/insufficient/unmeasured，不用总体平均掩盖单款问题。另保留内容、人类试玩和服务容量上线关口，不能把引擎审计等同上线批准。

## 本机原始证据

被忽略的 `platform/review/engine-audit-20261009/` 保存本轮Run原始帧/场景/资源采样、首次probe失败、适配后的QA副本、Blender下载验证及7源文件求值结果；`two-scenes-2026-10-09T14-20-23.799Z/`保存Golf/Bowling源与资源哈希、完整帧序列、阶段、截图及独立Node请求。此目录不随Git上传；本文保留跨机器可用结论。既有公网/实体手机证据索引见根目录 `HANDOFF.md`。初始审计阶段未修改或发布游戏运行代码；本日后续实现和部署另见上述优化报告。
