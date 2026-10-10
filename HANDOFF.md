# 游戏平台交接 — 2026-10-10

用户要求：界面和游戏流畅、达到上线标准；提供最简 APK；删除其他 Mock 应用及数据；使用真实数据和接口，已连接本机 Android 手机。工作仍在进行，尚未达到完整第三方接入上线标准。

## 当前部署

- 发布分支 master，本轮开始时 HEAD `13e91695aef6c5ddaee655e75a6102e4a0027b7f`。当前提交与未提交修改须重新读回 git。
- 真实 Player：`https://oasis-player.43.98.202.236.sslip.io/player?app_id=app_e091fb5daf135660d39ce89fc23760ab`。
- 独立生产实例：`/opt/oasis/production-current` 指向 `20261010-06`，API 18891、数据库 18893；真实注册账号、持久化会话、真实房间及生产账本，测试账号初始余额 0。
- 已开放第一方免费练习的 11 款竞技游戏，概率游戏、资金转入转出、第三方资金接入仍未开放。免费练习通过不代表 13 款和资金上线通过。
- release manifest SHA256 `1135152d247b7de6f8bdecac3ede9ac9fb4a1675936c9596dde6ddba2d353a25`；本地 build stamp SHA256 `aefc1f7b7ed3d75baac6ec092d1e31081617a03e0114fb26bd12423b1ffdc0a3`。
- source06 发布时 HTML 权限 0600 导致游戏入口 404，已在锁内核对完整 manifest 后将公开运行文件权限规范化，字节/inode/mtime不变，11 个入口读回 200。打包和 delta staging 已修复此权限继承问题，24 项聚焦测试通过。

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
- 标准见 `platform/specs/mobile-quality-v1.md/json`：完整冷热入口各 5 次、逐款至少 15 分钟/3 完整局/30 操作、帧间隔、延迟、生命周期、内容和服务端容量等。当前尚未完成这些门槛；Android RAF/桌面 CPU 节流不等于 GPU 显示帧率或 iPhone 验收。

## Mock 清理

- 独立 Android Mock 服务、库、卷、网络及私有运行数据已退役，旧 Mock HTTPS 返回 410。
- 手机 `com.tianyahuyu.oasis.mock` 和 `com.tianyahuyu.oasis.smoke` 已卸载，实际 package list 确认均不存在。
- 旧公网 sandbox 已完成退役：固定 `oasis-postgres` / `oasis_platform` / `oasis-postgres-data` 与生产实例独立；先关闭旧公开路径和停止/disable 6 个测试 unit，再于 2026-10-10 10:47 UTC 删除其固定容器及专属卷。完成收据 SHA `ddb448e94c8e5bd18baf7db4ab3948ecd17fd206684f98e661730b5fddbb7b39`，五步历史保留，未伪造 ACK。历史恢复备份和源码未当作活动 Mock 库删除。
- 只读审计确认所有财务未决计数为 0，另有 3 条已 SETTLED 的旧概率演出状态；用户已授权随旧测试库删除，不能通过伪造 ACK 或修改状态使其通过。
- v6 两步后因 systemd Requires 顺序变化拒绝，原失败收据和只读诊断保持原字节。独立 v2 接续固定原始证据，仅接受 9 个生产/TLS 与 4 个已观测测试 service 的 Requires 成员相同排序变化，其余保护严格一致；fresh audit/check 后只执行剩余三步 Docker 操作。
- 退役后旧 `/player` 跳转实际 Player，旧 demo/API/download 410，共享不可变资源、TLS、其他业务和生产实例需独立读回保持正常。
- 独立最终读回 SHA `dabc588a288ecd74179143af72f7c410100fb5c65b45e61c46b7430794d1a5e8`：旧容器/卷/端口不存在、retained 保护 stable diff 为空、旧入口 410、实际 Player/生产 health 200，生产指针仍为 source06。服务器 `/opt/oasis` 可用约 9.34GB（十进制）。

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

后续操作前重新检查 git、部署指针、进程归属、空间及自有房间；保护历史 receipt/controller 外部 SHA，不得修改冻结历史文件来绕过状态变化。完成后提供实际可用交付物、最终提交/推送及 git status 读回。
