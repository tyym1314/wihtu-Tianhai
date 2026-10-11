# 游戏平台交接 — 2026-10-11

用户要求：界面和游戏流畅、达到上线标准；提供最简 APK；删除其他 Mock 应用及数据；使用真实数据和接口，已连接本机 Android 手机。工作仍在进行，尚未达到完整第三方接入上线标准。

## 当前部署

- 发布分支 master；source08 运行时提交 `877ede391fab75dfd7293c9e3f6dc3e8aae9bdd8`，继承 source07 游戏优化与采集器提交 `1ceb2dfa23e2ccd3f74001c2491a020d0dbaf8b7`，已推送并核对远端。当前提交与未提交修改仍须重新读回 git。
- 真实 Player：`https://oasis-player.43.98.202.236.sslip.io/player?app_id=app_e091fb5daf135660d39ce89fc23760ab`。
- 独立生产实例：`/opt/oasis/production-current` 已指向 `20261011-01`，API 18891、数据库 18893；2026-10-11 实际 API-only 恢复通过，API PID1618408 active、三个生产定时器 inactive、数据库 active，旧证书任务仍 failed。真实注册账号、持久化会话、真实房间及生产账本保留，测试账号初始余额 0；完整恢复和上线验收尚未完成。
- 原第一方免费练习范围为 11 款竞技游戏；source08 切换实际提交 revision10 closed，尚未重新开放。概率游戏、资金转入转出、第三方资金接入均关闭。免费练习通过不代表 13 款和资金上线通过。
- 当前生产 release manifest SHA256 `960c380ac39a2083edbce269467ec497af70146e99f555a909a9a769e3b3f708`；游戏 build stamp `3d5bd2cb91a9439ff0fd2314eb0560e04b70254c231f12879faad32562b65d10`。以下06/07记录为保留的历史证据。
- source06 发布时 HTML 权限 0600 导致游戏入口 404，已在锁内核对完整 manifest 后将公开运行文件权限规范化，字节/inode/mtime不变，11 个入口读回 200。打包和 delta staging 已修复此权限继承问题，24 项聚焦测试通过。
- source07 已实际 staging，尚未切换。v1 切换工具在业务修改前因共享对象比较误判拒绝；v2 新链在停止定时器前遇 `ADMISSION_ONESHOT_TRANSITION`，其失败处理停止了原 API 和三个定时器，未写策略或源码。原 partial SHA `ad23267dc5f2ecfa8a9dc527ebb237d6dbbe935c01ee9b6c1e9a5118a5c1141c` 保留，不重放。
- 已仅恢复原 API 和三个定时器；2026-10-10 12:20 UTC 独立完整只读读回通过，SHA `6ebe18d675da5c342bc46ad61f34936e6f827f808dbe209ea6cbcb9c4704b225`。API 实际 PID 1005937、定时器 active/jobs idle、原配置及生产指针全 pin 不变、策略 revision8 open；47 表图完全一致、28 项完整性计数为零，HTTPS/静态资源/retired410及player302通过。候选切换工具正在修复有界任务等待及当前06资源检查误用候选成员的问题；恢复不能当作07发布完成。
- v3 实际关闭阶段于 2026-10-10 提交 revision9 closed，随后在定时器恢复后的最终读回遇到 `ADMISSION_ONESHOT_TRANSITION`。失败处理再次停止 API 和三个定时器；当前指针仍为06，没有切源或追加静态资源。原 partial SHA `2d6743697a2028afb27cc4e9c1d05658acca72567295799e76f99aa753a6db56`、已提交策略及七步原历史保留，不能重放 close SQL 或把失败收据改成成功。
- 2026-10-11 恢复前发现三组精确保护差异：主证书 renewal.conf 仅 ARI 下次重试时间改变；12 条原监听输出各增加4个尾部空格，端口/进程/正文不变；DB RequiredBy 两个原成员顺序互换。原配置通过完整历史 SHA 重建，明确不是原文件备份，当前文件改写时间与实际主证书任务成功日志同秒。新恢复证明只采纳这些已审差异，不增加通用忽略规则或改历史保护文件。
- 2026-10-11 实际 API 恢复通过，原始收据 SHA `c824d610cd915725adf8a03963367630aebd218d5a6c945e6abd69fb1273ca3e`：仅执行一次 `systemctl start oasis-production-api.service`，API 实际 PID1545089；current06、revision9 closed、47表图及28项零计数保持一致，已提交 marker 的新 fullpin 绑定原 partial。当时三个定时器 inactive，后续状态如下。
- v4 关闭验收接续的实际 fresh audit/check 通过，47 表及28项零计数一致；仅启动三个生产定时器，未重复 SQL、停止 API 或切源。随后 `SOURCE07_AUTHORED_STATIC_CHANGED` 拒绝，原始 partial SHA `e992d5e5920ec58fee46deb5969bfe201f1ecf83c098f1fa113d7257df5b5a6f`。2026-10-11 11:03 UTC 现场回读：API PID1545089 active、current06/revision9 closed、三个 timer active；证书 service 实际 FAILED/exit1，监控正确报告该故障。没有 source07 开放或新真机性能样本。
- 原 BASIS 完整静态只读 snapshot SHA `dd8d8ad62b035d103febfa2516b1eb278cfac1ceae07dde74f1e7fd2ba6f9735`：1,002 静态文件、25 registry receipt、11目录、head、其他祖先全部一致，仅 `/opt/oasis` 的 ctime/mtime 改变。实际 job/journal 读回 SHA `d7844eeb7c0310ffa5bdbc5720c42c0766e2f087c252a96f2212d6bec437c861`：生产证书 renew 的旧 `https://game.tianyahuyu.com/health` 依赖收到合法退役的410，其 finally 删除 `.production-ingress-lock`，时间与祖先变化一致。不能只忽略时间戳或清除 failed 状态来声称通过。
- 新 immutable source08 的入口修复已通过本地及独立复核，两轮各115项：续期前后检查真实公网 production ready，操作锁移至已有 root700 私有目录；首装仅在 TLS 尚不存在时使用明确标记的 loopback production ready，完成后仍验证 HTTPS。继承 source07 游戏优化，06/07 冻结文件保持原字节。source08 已实际切换源码并完成备份恢复演练，整体刷新验收失败；修复后的实际续期、监控、重新开放及新真机性能验收尚未完成。
- source08 源提交 `877ede391fab75dfd7293c9e3f6dc3e8aae9bdd8`，服务器候选目录 `/opt/oasis/releases/20261011-01`，manifest SHA `960c380ac39a2083edbce269467ec497af70146e99f555a909a9a769e3b3f708`。06→08 为41项变更、22项删除；07→08 仅两个 ingress 文件变更，游戏 build stamp 仍 `3d5bd2cb91a9439ff0fd2314eb0560e04b70254c231f12879faad32562b65d10`。实际 stage a2 原始回执 SHA `d0519116c297590127b658a054518e481100b4e37f58c27f2559d64989010dff`，1208文件验证及可读性通过，独立复核通过；前后47表、28零计数、运行状态和静态资源一致，未写 current/SQL/服务/静态发布，`healthy=false`、`source_admission=false`。
- 2026-10-11 11:17 UTC 完整只读前置诊断 SHA `1915db0d6f76624467704ea8e468d09b50d000dea5d2304c3f75462461688a64`：current06/revision9 closed/API1545089及47表/28零计数保持，静态精确匹配上述诊断，两次 raw runtime/protection 一致。明确 healthy close completion/source admission 均 false；这是观察基线，不能当作上线验收。
- source08 控制器 `d988172d480f1687320b3be6160a0b85caa7953db25b784214b12b2d5a38e0bf` 经40项聚焦测试及两位独立复核后实际执行。原 audit/check 及独立现场审核通过；refresh 在 `target_units_loaded` 后被 `RETIRED_PUBLIC_UNIT_CHANGED` 中止，原始失败回执 SHA `d7a770605c41f484cdb183ac047f218b52a4739f8974939bd675a3e4193f7393`。回执保留真实备份及隔离恢复通过/临时库清理、47表和28零计数、22项静态追加（1002→1024）、原history保留、06→08指针切换、revision10 closed实际提交。原回执终身 failed，不能重放 SQL10、静态追加或伪造完成。
- 失败后完整只读诊断已实际完成，原始 SHA `b6bfecdc211844e7978464b40c0821d7dab07da80d971f261f2c6ecabce79f78`，真实执行证明 SHA `a65a4b5fc8e0dd5921e534972bb769d6b3665b5b904659c42da6054f99c026a5`，helper/SSH 均 exit0、stderr0。1208源码成员、source08 marker/env/5段历史、47表图/28零计数及静态树全部精确，16单位的原始日志同一真实boot；两次保护捕获一致。相对原partial的22项作者变更和9项原有Requires成员顺序均独立重算，无未解释外部采纳。采集完成仅代表诊断完整，健康/准入/关闭验收标志均 false；先前不完整日志采集及外层保存失败保留原字节。
- source08 API-only 新 helper `f76563a61ecbfe176846d1e912cbd36c281db25a943d975bb3c8d058b4fad5ea` 经20项聚焦测试及独立审查后实际通过。原收据 SHA `cc69978e91471fc511fe036907b54ff24d2240cc71962c73bac7d996fb7d9950`、真实执行证明 SHA `ce87228255100af307951af2935afaa7d55016e4e8542fddcbca9766e64f5547`：仅一次 `systemctl start oasis-production-api.service`，API PID1618408/UID997/Node/source08 cwd，生产 HTTPS ready 通过。策略10 closed、app paused、23项source检查、47表图/28零检查及全部静态/保护保持，三timer仍 inactive，原CERT失败保持。健康关闭验收/源码健康授权/准入标志全部 false。剩余步骤为新链真实CERT→三个timer→真实MONITOR→完整closed10验收→另行open11，不能把可用性恢复当作上线通过。
- 失败后原只读单位读回 SHA `c72f8e02c14768d0981194fb922346d95bc4088f9fa8da9f96caab5056127206`：六个退役服务其余字段精确一致，仅 Requires 成员顺序；原比较器只允许四个服务的顺序变化，新出现 `/oasis-backup.timer/Requires` 的两个原成员互换，原比较器拒绝。此证据是失败后的现场观察，未保存失败瞬间的 actual，不能倒填历史。临时引用全部六单位所观察到的 RequiredBy/TriggeredBy 变化未采用。后续先核对完整 source08/策略10/数据及保护，再仅恢复 API；续期与监控验收须从实际已提交状态接续。

## 最简 APK 和设备

- `platform/android-player/` 为固定 HTTPS/AppID 的 WebView，包含返回桥、失败重试及生命周期处理。
- 已加原生 2.5 秒返回 watchdog、前台 30 秒加载 watchdog；重试创建新 WebView，保留实际登录 Cookie，旧回调不影响新页面。
- APK 配置 5 组、Java 导航 98 项、返回桥 12 项及真实 Activity 生命周期 14 场景/26 断言通过；QA/release v2/v3 签名验证通过。
- QA APK 20,883 B，SHA256 `18575df7fda675f721850313df73ce405c3492e236bd2dd01cdcc4d755b99f01`，已安装，安装后 SHA 一致。
- release APK 20,883 B，SHA256 `92f40b68ae6223e4fbdb0462a8dff32f5589fc33aa030fe68e27364abf92ac2e`，已完成 release 包真机原生启动/返回、真实登录零余额及重启 Cookie 保持；尚未完成完整游戏/性能验收和外部交付。
- 实体手机 `46dcfd25`，Xiaomi `24053PY09C` / Android 16，USB ADB 5037。云机 `localhost:49342` 及其已有 forward 保留。旧文档的实体 ADB 5038 已过时。
- 实际 HTTPS 主脚本 GET 阻塞后，原生超时和重试恢复同一账号、零余额及空 recovery；8 秒 JS 阻塞时原生返回约 2.64 秒关闭 Activity，重新打开读回真实身份。负向诊断与失败报告保留。

## 真机验收进度

- `current06-native-basic-a5`：消消乐真实操作/返回/零余额和空 recovery 通过；高尔夫击球真实 200、序号 0→1、返回和自有房间清理通过，但严格资源观察失败。
- 高尔夫当前失败涉及 Draco worker 生成 Blob 的来源证据和退出时两张场景图片 `net::ERR_ABORTED`，正在修复证据分类与加载/退出衔接；不能忽略错误或把操作成功当整体通过。
- `current06-native-run-perf-a1`：跑酷冷启动约 9.7 秒，超过 5 秒标准；8 次真实输入和运动画面已有证据，后续第 9 次输入前控件变 disabled 导致诊断退出，房间清理通过。报告仍失败。
- `current06-native-run-perf-a2`：实际可玩 17,446ms；10 个权威受理输入，35,272.9ms 前台/活动运动、3,884 帧。后续可信 click 未产生下一次 inputs 请求，8 秒超时；真实房间 active→cancelled、active_room_id=null、清理通过。15 分钟、3 完整局及冷热各 5 次未完成，报告仍 fail。
- 该轮 10 个 >50ms 帧间隔全部位于 5 组截图窗口内；原始最大 366.1ms 保留，不扣除重判。下一轮采集器将分离截图观测和不中断的连续采样，保留实际输入/运动/原始边界证明。
- `current06-native-run-perf-a3`：分离截图后连续实际 45,555.1ms / 5,472 帧，p95/p99 8.4ms、最大 16.7ms、>50ms 为 0；前置截图的四个 282.7–316ms 停顿另行保留。冷启动实际可玩 10,296ms，16 次权威受理输入；最后一次可信 click 未产生第 17 个 POST，仍失败。失败现场为正常 provisional 落水恢复，但比点击晚约 7.4 秒，不能追认点击当时的拒绝分支。自有房间取消、账号无活动房间、forward/前台恢复均通过。
- 已改输入前归属/状态核对，明确记录未发输入的自然状态变化；失败前也保留 probe。性能阈值没有降低。
- 正在优化 Run 模块导入与真实资产下载的串行等待；候选 runtime 变化需要重新构建、发布并建立新证明。
- source07 候选已完成真实素材并行下载/模块导入、默认大厅头像复用原始 atlas Blob、宿主确认返回时避免临时结果资源加载。21 文件冻结、168 单元测试及真实 DOM/素材检查通过；canonical build 已完成（1,761 输入 / 740 输出），尚未部署，真机性能仍需新证明。
- source07 候选 build stamp SHA `3d5bd2cb91a9439ff0fd2314eb0560e04b70254c231f12879faad32562b65d10`，release manifest SHA `4e6ac604068a797110553b5784e3fd7468e5b9caf66ca17196381235e89bc9b5`（1,208 文件）；06→07 增量 552,455 B。实际 dist 的 Run WebGL/丢 ACK/授权恢复 3 检查及 onboarding 9 检查通过、源文件不变，均为独立本地 HTTP/PG 检查，不是手机或公开网络性能证明。
- 新可见反馈采集器已推送，116 项验证通过：固定 WebView 150 原始 Chromium 源码与协议、保留原始 PNG/元数据和账号/iframe/页面身份、记录实际控件状态与原始权威请求，并将截图证明与连续性能采样分开。首次变化 PNG 时间仅是捕获内容的保守上界，不能代表屏幕呈现或物理输入延迟；真实07采样尚未执行。
- 100 会话/900 秒的独立真实 HTTP/Postgres 容量工具 v2 已冻结，41 项验证通过，修复清理证据失败及进程组残留误判，绑定真实07开放收据。尚未执行负载；不得把工具准备或合成会话当作手机/真实资金验收。
- 标准见 `platform/specs/mobile-quality-v1.md/json`：完整冷热入口各 5 次、逐款至少 15 分钟/3 完整局/30 操作、帧间隔、延迟、生命周期、内容和服务端容量等。当前尚未完成这些门槛；Android RAF/桌面 CPU 节流不等于 GPU 显示帧率或 iPhone 验收。

## Mock 清理

- 独立 Android Mock 服务、库、卷、网络及私有运行数据已退役，旧 Mock HTTPS 返回 410。
- 手机 `com.tianyahuyu.oasis.mock` 和 `com.tianyahuyu.oasis.smoke` 已卸载，实际 package list 确认均不存在。
- 旧公网 sandbox 已完成退役：固定 `oasis-postgres` / `oasis_platform` / `oasis-postgres-data` 与生产实例独立；先关闭旧公开路径和停止/disable 6 个测试 unit，再于 2026-10-10 10:47 UTC 删除其固定容器及专属卷。完成收据 SHA `ddb448e94c8e5bd18baf7db4ab3948ecd17fd206684f98e661730b5fddbb7b39`，五步历史保留，未伪造 ACK。历史恢复备份和源码未当作活动 Mock 库删除。
- 只读审计确认所有财务未决计数为 0，另有 3 条已 SETTLED 的旧概率演出状态；用户已授权随旧测试库删除，不能通过伪造 ACK 或修改状态使其通过。
- v6 两步后因 systemd Requires 顺序变化拒绝，原失败收据和只读诊断保持原字节。独立 v2 接续固定原始证据，仅接受 9 个生产/TLS 与 4 个已观测测试 service 的 Requires 成员相同排序变化，其余保护严格一致；fresh audit/check 后只执行剩余三步 Docker 操作。
- 退役后旧 `/player` 跳转实际 Player，旧 demo/API/download 410，共享不可变资源、TLS、其他业务和生产实例需独立读回保持正常。
- 独立最终读回 SHA `dabc588a288ecd74179143af72f7c410100fb5c65b45e61c46b7430794d1a5e8`：旧容器/卷/端口不存在、retained 保护 stable diff 为空、旧入口 410、实际 Player/生产 health 200，生产指针仍为 source06。服务器 `/opt/oasis` 可用约 9.34GB（十进制）。
- 74 份历史 mock 备份已实际删除：370 文件、506,762,659 B 逻辑大小、507,858,944 B 分配大小。完成原始收据 SHA `7a7622d43942b300f22e4a31449a988df3bf83b1141670bed1e939c740cd673f`；独立读回 SHA `9866b6d89b21b00eb65f58dffd70ad833df612325d33defc79f95a987c1323e2`，74 路径全不存在、148 个原始 barrier 及完整保护通过。名义删除大小不等于磁盘净增加，保留证据也占空间。
- 最后 `/opt/oasis/backups/20261009T155133Z` 的 5 文件共12,829,348 B仍保留，等待source08真实修复、完整关闭验收及开放收据通过后做精确删除；后续工具目前为未执行草稿。source08失败刷新已完成真实备份/隔离恢复，不重复执行。不要删除共享不可变资源、旧current03的TLS依赖或其他业务文件来凑空间。

## 证据和接手

原始私有证据在被忽略的 `platform/review/`，不得整包上传；签名材料、凭据、依赖和构建输出按 `.gitignore` 排除。

- `android-player-20261010/root-native-recovery-build-20261010/`：QA/release 构建与签名读回。
- `android-player-20261010/root-qa-recovery-install-zf0w21sb/`：QA 实际安装读回。
- `android-player-20261010/current06-release-native-smoke-a2/`、`current06-release-auth-smoke-a1/`：正式 release 实际安装、非debug、原生返回、真实登录/零余额及重启 Cookie 保持。
- `android-player-20261010/current06-native-recovery-a2/`、`current06-native-recovery-back-a1/`：加载超时恢复和返回 watchdog。a2 后续 Debugger.pause 诊断失败未改判。
- `android-player-20261010/current06-native-basic-a5/`、`current06-native-run-perf-a1/`：最新真机操作和性能失败报告。
- `firstparty-release-20261010/root-refresh06-actual-6lr4yana/`：source06 fresh audit/check/实际开放收据。
- `firstparty-release-20261010/source06-runtime-permissions-kneakqie/`：入口权限修复、字节保护及读回。
- `firstparty-release-20261010/root-public-retirement-a1/` 至 `root-public-retirement-a6/`：旧公网库审计、检查、原始拒绝与部分执行诊断。
- `firstparty-release-20261010/root-source07-backend-tests.log`：首次完整 2,743 项，2,704 通过/39 失败（3 旧 build pin、1 迁移后的 URL import 断言、35 本地 PG 文件读取 Interrupted system call）；相关数据库文件独立串行重测 43 项全部通过、测试库已删除。新 build 后仍需完整回归通过。
- `firstparty-release-20261010/root-source07-backend-tests-a2.log`：新 build 后完整 2,746 项，2,739 通过/7 失败（6 本地 PG Interrupted system call、1 Run 存储绑定缺少预期 rejection）；原始失败未改判。
- `firstparty-release-20261010/root-source07-backend-tests-a3.log`：新 `/private/tmp` 独立 5488 集群完整 2,746/2,746 通过、0 skipped，测试数据库及本轮集群已停止删除，原 5487 未修改。原 a2 失败保留，具体旧集群 EINTR 原因尚未确认。发布 Python 聚焦检查 52/52 通过，fresh build verify 通过。
- `firstparty-release-20261010/root-public-retirement-resume-a2/`：新鲜 v2 audit/check、实际完成收据及独立最终读回；未来 source07 控制器必须从完成退役的保护接续，不能调用仍检查旧测试库的历史构造器。
- `firstparty-release-20261010/root-mock-backup-purge-v2-a1sx6k8i/`：74 份备份的实际删除、原始 barrier/journal及独立最终读回。
- `firstparty-release-20261010/root-refresh07-v2-actual-3h40kmon/`：v2 原 audit/approval/check/partial、原 API 与定时器恢复、失败资源检查及独立完整恢复读回；全部历史原字节保留。
- `firstparty-release-20261010/root-refresh07-v3-actual-kf7jcutf/`：已提交 revision9 的原关闭失败、API 精确恢复及三组差异的原始诊断。
- `firstparty-release-20261010/root-refresh07-v4-actual-96_yewxh/`：实际 audit/check、仅三 timer start 的原失败、完整静态 snapshot 和证书/监控 job 故障读回。

后续操作前重新检查 git、部署指针、进程归属、空间及自有房间；保护历史 receipt/controller 外部 SHA，不得修改冻结历史文件来绕过状态变化。完成后提供实际可用交付物、最终提交/推送及 git status 读回。
