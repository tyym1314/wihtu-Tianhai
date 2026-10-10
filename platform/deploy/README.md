# OASIS 公网沙箱部署与维护

本实例提供 13 款游戏的公网试玩和管理平台。服务器初始化了独立的沙箱数据库，**没有迁移本机历史局单、余额或合作方配置**。公网部署不等于真实合作方钱包、生产容量、容灾及手机 WebView 验收完成；测试币不能充值或提现。

## 访问入口

- 试玩大厅：<https://game.tianyahuyu.com/demo/>
- 管理平台：<https://game.tianyahuyu.com/#/games>
- 管理员用户名：`tyym`，沿用此前指定密码；密码不写入本说明。
- 每位试玩访客使用独立 Cookie 身份和测试钱包。首次进入游戏开户 12,000 测试币，重新启动游戏不会补回已消耗余额。
- 旧域名 `oasis.43.98.202.236.sslip.io` 保留 HTTPS，并通过 301 跳转到新域名的对应路径。

## 自有域名切换（2026-09-20）

GoDaddy 中为 `game.tianyahuyu.com` 添加 A 记录，指向 `43.98.202.236`。平台公开入口改为 `https://game.tianyahuyu.com`，内部端口、数据库、应用配置和服务器历史账本保持不变；本次切换不迁移或重置数据。平台 API 与试玩宿主都通过 `OASIS_PUBLIC_ORIGIN` 读取入口，配置更新后必须重启两个服务。

登录和试玩 Cookie 仅属于签发它们的域名。访问新域名时，管理员需要重新登录；试玩访客会取得新的独立身份和测试钱包，旧域名的访客余额不会自动显示在新身份下。旧身份、余额及局单仍保留在服务器数据库中。

切换前配置备份位于受保护的 `/opt/oasis/domain-migration-20260920`，其中包含私有环境配置，不得放入网页目录或公开分享。需要回滚域名时，先核对旧域名 DNS 与证书仍然有效，并暂停新会话、处理未决对局；成套恢复备份中的环境配置、两份主机 Nginx 配置以及 `proxy-nginx` 容器 ACME 配置。主机和容器分别通过 `nginx -t` 后重载，再重启 `oasis-api` 与 `oasis-demo`，验证旧入口健康、登录和游戏启动。保留数据库、密钥和账本，不运行初始化脚本。

下方既有验收记录对应旧域名首次部署；新域名切换需另行记录 DNS、TLS、跳转、登录、游戏启动与结算检查结果，不能沿用旧记录作为切换验收结论。

## 部署位置与端口

发布目录为 `/opt/oasis/releases/<版本>`，`/opt/oasis/current` 指向当前版本。使用 `readlink -f /opt/oasis/current` 或管理平台“版本与发布”页查看实际版本，不能以此文档的历史记录判断当前版本。私有配置与加密密钥保存在 `/opt/oasis/private`，不放在发布目录或网页目录中。

| 服务 | 监听地址 | 管理方式 |
| --- | --- | --- |
| HTTPS 入口 | 公网 `443`，精确匹配上述域名 | 主机 Nginx 独立虚拟主机 |
| 项目网页与内部反代 | `127.0.0.1:18880` | 主机 Nginx |
| 平台 API | `127.0.0.1:18881` | `oasis-api.service` |
| 参考钱包 | `127.0.0.1:18882` | 由 API 进程启动 |
| PostgreSQL | `127.0.0.1:18883` | Docker 容器 `oasis-postgres` |
| 访客试玩宿主 | `127.0.0.1:18885` | `oasis-demo.service` |
| ACME 验证桥接 | `172.17.0.1:18884` | 主机 Nginx，仅验证路径 |

公网直接访问 `18880` 曾超时，疑似受到云侧入口限制；因此通过共享 `443` 上新增的精确域名路由访问，项目本身仍使用独立内部端口。不要将数据库、钱包或 API 内部端口开放到公网，也不要修改其他站点的默认路由。

PostgreSQL 使用 `postgres:16-alpine`，数据卷为 `oasis-postgres-data`。网页文件来自 `/opt/oasis/current/platform/dist`；游戏资源及 API 由内部服务提供。

## 日常检查与重启

以下命令在服务器上以具备相应权限的账号执行。日志用于排查错误，不应公开发送包含 Cookie、令牌或私有配置的内容。

```sh
systemctl status oasis-api oasis-demo --no-pager
systemctl list-timers oasis-backup.timer oasis-certificate.timer oasis-monitor.timer --all
docker ps --filter name=oasis-postgres
curl --fail --silent --show-error https://game.tianyahuyu.com/health
journalctl -u oasis-api -u oasis-demo -n 100 --no-pager
```

计划重启前，在管理平台暂停新会话并等待现有对局结算；保留原数据库及全部密钥。恢复顺序：

```sh
docker start oasis-postgres
systemctl restart oasis-api
curl --fail --silent --show-error http://127.0.0.1:18881/health
systemctl restart oasis-demo
```

API 启动后会按既有订单恢复未完成操作。不要通过删除订单、重建数据库或更换密钥解决连接问题。Nginx 配置有修改时先执行 `nginx -t`，通过后再执行 `systemctl reload nginx`。

## HTTPS 续期

证书工具位于 `/opt/oasis/certbot/bin/certbot`，配置目录为 `/opt/oasis/acme/config`。自有域名证书位于其 `live/oasis-game` 子目录；保留 `live/oasis-sandbox` 中的旧域名证书及其续期配置，以支持旧 HTTPS 链接的 301 跳转。ACME 账号未配置邮件地址，应通过定时任务日志及证书到期时间检查续期状态。

`oasis-certificate.timer` 每天两次触发续期检查，成功更新证书后检查并重载主机 Nginx。既有 `proxy-nginx` 容器的 80 端口新增了 `/etc/nginx/conf.d/oasis-acme.conf`，仅处理 `game.tianyahuyu.com` 与 `oasis.43.98.202.236.sslip.io`。续期脚本会在该文件因容器重建而缺失时，从 `/opt/oasis/current/platform/deploy/oasis-acme-proxy.nginx.conf` 恢复它；该持久模板必须包含新旧两个域名，不能只修改运行中的容器。

查看及手动触发正常续期检查：

```sh
systemctl status oasis-certificate.timer --no-pager
journalctl -u oasis-certificate.service -n 80 --no-pager
systemctl start oasis-certificate.service
```

使用 ACME 测试环境验证续期，不替换正在使用的证书：

```sh
/opt/oasis/certbot/bin/certbot renew --dry-run --non-interactive --no-random-sleep-on-renew \
  --config-dir /opt/oasis/acme/config \
  --work-dir /opt/oasis/acme/work \
  --logs-dir /opt/oasis/acme/logs
```

续期依赖域名解析、外部 80 端口、`proxy-nginx` 与 ACME 桥接保持可用。不要删除证书账号或私钥。

## 备份

`oasis-backup.timer` 每天服务器时区 `02:35` 执行备份，输出到 `/opt/oasis/backups/<UTC时间戳>/`。每份包含 PostgreSQL 自定义格式转储、私有配置归档、当前版本路径、转储目录清单及校验摘要。私有归档包含数据库连接配置、平台 master key、访客签名密钥等敏感内容，应仅由运维账号访问。

```sh
systemctl start oasis-backup.service
journalctl -u oasis-backup.service -n 30 --no-pager
```

备份脚本检查转储目录可读性，但这不等于已完成灾难恢复演练。恢复时必须在隔离环境成套恢复数据库和对应私有配置，验证后再决定切换；不能仅恢复数据库而重新生成 master key。当前脚本不自动删除历史备份，应监控磁盘空间并制定保留策略。2026-09-20 已使用 `restore-drill.mjs` 对真实服务器备份完成一次隔离恢复：21 张必要表、6 把业务密钥解密、scope 和账本守恒均通过，临时数据库及私有文件已删除。结果在 `/opt/oasis/acceptance/restore-drill-release-20260920.json`；此记录只证明该次备份可恢复，不代替未来备份检查。

加密异地副本的导出、校验与还原步骤见 [OFFSITE-BACKUP.md](OFFSITE-BACKUP.md)。这是手动执行工具，不代表已配置定时异地上传。

## 升级与回滚

1. 在 `platform/` 执行 `npm run test:release` 和 `npm run build:release`。发布构建先后核验已审核 Android 产物的哈希与来源，再构建旧游戏、竞技游戏、合作方接入包和管理台；它不会重新构建或替换 APK。APK 需独立构建、审核并明确所属 Origin、包名、服务版本和设备验收记录，见 [Android 说明](../android-smoke/README.md)。再使用 `package-release.py` 打包经过构建、测试的发布物，解压到新的 `/opt/oasis/releases/<版本>/`，核对清单并安装该版本依赖。不要直接覆盖正在使用的目录。
2. 保持 `/opt/oasis/private`、`oasis-postgres-data` 和证书目录不变。部署包不得包含本地 `.local`、数据库、SSH 私钥或运行凭证。
3. 记录当前符号链接目标并完成备份。暂停新会话、处理完未决对局后，停止试玩和 API 服务，将 `/opt/oasis/current` 原子切换到新版本，再依次启动 API 和试玩服务。
4. 核验健康接口、管理员登录、独立访客身份、游戏启动／操作／返回与结算记录；有代理配置变更时另做 Nginx 配置检查。

打包器会校验 `release-build-manifest.json` 中的源文件和三个前端目录摘要；缺包、源文件变动或旧构建被覆盖会拒绝打包，必须重新运行完整构建。

`activate-release.py` 已实现清单校验、未决义务检查、备份、原子切换、健康检查及失败回切。仅在已确认数据库增量迁移兼容时使用 `--compatible-schema`。它会在停止服务后再次检查未决对局，避免检查和停服之间进入的新局被忽略。`package-delta.py` 只生成传输增量；目标必须先独立复制上一版本，再应用增量并验证完整新清单，不能使用会共同修改旧版本文件的硬链接。

服务器可用 `stage_delta.py <新版本目录名> <增量包路径> <SHA256>` 完成上述独立复制、逐文件校验和暂存；新目录名格式为 `YYYYMMDD-NN`。它不切换流量。随后用新版本中的 `activate-release.py /opt/oasis/releases/<新版本> --check-only` 检查未决局和依赖，确认可回滚的增量迁移后才执行带 `--compatible-schema` 的激活。若前置条件不满足，保留当前链接和服务，不得以删除未决局绕过检查。

`stage_delta.py` 自行持有 `private/release.lock`，不要再在外层持有同一锁调用。新构建可以省去上一版独有且未列入 retained lock 的指纹 chunk，但必须先验证旧 release 清单声明、稳定静态仓库全部内容以及 registry/head 收据，证明原 URL 的原字节仍可读取。同 URL 改字节、旧文件未列清单、仓库缺失或损坏、发布未完成均拒绝；既有 retained lock 的条目仍必须保留在新清单。暂存不删除原 release，也不删除静态库内容。

因此“最新完整发布包”不等于“完整历史 URL 灾备包”。恢复所有历史 URL 需要一致保存 `static-assets/`（包含 `.registry/`）与 `private/static-assets-head.json`，或保留能重建它们的原 release 和登记材料。现有每日 `backup.sh` 只备份数据库与私有配置，尚未自动备份静态仓库；不要据此宣称历史静态资源的自动异地恢复已经完成。全新部署没有这些历史材料时，只能证明新包及其中 retained lock 覆盖的资源，不能绕过暂存或回滚的覆盖门禁。

### 历史版本归档

`archive-releases.py` 只允许处理代码中列出的九个历史版本，每次修改一个目录。先在服务器上对已核对来源的工具执行 `python3 archive-releases.py --check-only`；检查不写文件。实际归档还会持有与发布相同的锁，再次排除当前、Mock、上一版、最近三份未 pin 版本及进程使用中的版本。所有旧指纹资源必须仍在当前目录且哈希一致，不满足时保留旧目录。

对已检查的单个版本执行 `python3 archive-releases.py 20260927-01 --archive`，工具先压缩并真实解压，核对整个目录的文件内容、路径、权限、属主、时间和内部符号链接，再回收原目录。外部链接、扩展属性、特殊文件、来源变动或临时空间不足均拒绝；临时工作之外至少保留 3 GiB 可用空间。归档保存在 `/opt/oasis/release-archives/<版本>/`，不能只按原目录大小报告收益，应读取结果的 `reclaimed_bytes` 并重新检查磁盘。该工具不处理数据库、私有配置、业务备份或其他服务。

中断后先使用 `python3 archive-releases.py <版本> --recover` 收敛该事务；需取回完整已归档代码时使用 `--restore`。恢复核验压缩包和目录清单，不覆盖现有版本，保留归档副本。恢复历史文件不等于回滚流量，激活仍需通过上面的 schema 与未决义务检查。不要手工删除事务目录或归档中的收据和清单，也不要把同机压缩归档当作异地灾备。

## 对外接入与运行状态

管理员可创建独立合作方账号；合作方自助创建 App、改密、管理签名密钥、配置接入并运行自检。完整步骤见平台 [接入交接](../specs/production-handoff.md)。正式环境使用独立数据库和 master key，默认关闭生产准入，禁止将现有沙箱数据库切换为生产。

“版本与发布”页展示真实版本、每分钟巡检和容量报告。巡检超过三分钟未更新会显示过期；目前只有 systemd journal 状态变化记录，没有外部短信、邮件或 IM 通知。巡检通过、后端测试通过和容量通过是三个不同结论；100 人容量以对应版本报告中的派发率、分接口延迟、异常率及账务清理证据为准。

回滚只将 `/opt/oasis/current` 切回上一份保留的代码版本，再重启服务。**必须先确认旧版本兼容现有数据库结构和未决订单版本**；存在不兼容迁移时，先制定专项恢复方案。不要为回滚清空数据库、删除 Docker 数据卷或重新运行私有配置初始化脚本。

## 验收记录

2026-09-20 首次公网部署在旧域名 `oasis.43.98.202.236.sslip.io` 上的检查已通过，证据位于本机 `platform/review/deployment/acceptance.json`，服务器副本位于 `/opt/oasis/acceptance/acceptance.json`：

- 外网 HTTPS 浏览器：12 款启动及返回、10 款进入免费练习、保龄球投球和跑酷跳跃、两款概率游戏各一次结算与展示确认；无脚本错误或失败素材请求。
- 管理员登录、API／数据库／参考钱包健康、Secure HttpOnly 管理员 Cookie，以及合作方接入包下载。
- 两个独立 HTTP 访客完成一局 10 测试币双人对局，5% 服务费与双方余额核对一致；重复启动／结算请求未造成重复扣款，跨访客恢复会话被拒绝。
- API 与试玩服务重启后，访客身份、钱包余额和原会话保持；再次启动未重新补发测试币。

浏览器验证采用桌面 Chrome 的移动视口；两访客对局使用 HTTP 客户端。这些结果不代替 Android／iPhone 原生 WebView、多人真机、并发容量、容灾恢复或真实合作方钱包验收。

同日切换至 `game.tianyahuyu.com` 后，重新通过 12 款启动／试玩／返回、管理员登录、测试币双人结算与重试隔离、接入包下载和新证书续期演练。证据为本机 `platform/review/deployment/custom-domain-acceptance.json`，服务器副本为 `/opt/oasis/acceptance/custom-domain-acceptance.json`。首轮浏览器检查为绕过本机此前缓存的 NXDOMAIN，显式指定了目标 IP，始终开启 TLS 证书验证；DNS 缓存刷新后，另用未指定 IP 的浏览器确认域名解析、12 款大厅和游戏启动／返回正常。旧 HTTPS 链接保留路径及查询参数，301 跳转到新域名。

## 公共沙箱退役工具

已结算演出例外固定为只读诊断观察到的 3 条 session/cycle/state/result 哈希、结算时间及 `pendingPlay` 类型（两条旧 JSON 字符串、一条 `null`）。这些字段的任何变化仍拒绝，不能扩展为任意已结算状态或执行确认操作。

`check` 保留 expected/actual 原始快照及精确字段差异。仅 PostgreSQL 客户端及 4 组连接数组，在每次完整实时归属检查、两份 raw 再次 PG/socket join 核验通过且 API/proxy PID、目标 IP/namespace 范围完全相同时，允许连接池端口、inode、数量变化并记录 `allowed_observed_differences`；其他字段仍逐项精确比较，只忽略采集时间。停服务后仍必须没有任何外来数据库客户端。首次 apply 检查拒绝会在指定私有新路径写 `before_mutation_refused` 收据，`history=[]`、`no_business_mutation=true`，随后终止，不进入任何业务修改；不完整 audit 明确记录为未完成，不能把缺失证据当作相同状态。

退役状态要求全部 6 个单元 inactive、MainPID/ControlPID 为零，API、试玩及两个 timer 必须 disabled。仅原 audit 已确认 `static` 的 backup/monitor service 保留该状态，同时对应 timer 必须 disabled/inactive，job 没有外部触发或依赖；其他单元或后来出现的 static 状态仍拒绝。

仅已观测的 9 个生产/TLS 单元 `Requires` 字段按依赖成员集合比较，拒绝重复成员、非字符串、空字段及非单空格分隔；成员变化和其他全部保护字段仍精确拒绝。每次保护检查保留原始 expected/actual、raw 差异、允许的顺序差异及归一后的差异，最终收据保留实际读回的保护快照。部分退役不能重跑原 apply，须以全部冻结原始证据和新鲜现场核验准备独立续退役工具。

`retire-public-sandbox.py` 的 `audit`（默认）与 `check` 只读取运行状态并输出私有证据；`apply` 必须另带 `--apply`。先准备 root 独占、权限 `0700` 的 `/opt/oasis/public-sandbox-retirement-20261010`，传入已核对 SHA256 的 source06 `complete_free_open` 生产收据，依次生成新鲜 inventory、外部核对其 SHA256、生成 check，再带 inventory/check 的外部 SHA256 执行 apply。证据最长有效 10 分钟。工具只停用公共 API、试玩宿主及其 backup/monitor 的 6 个单元，只删除固定 ID 的 `oasis-postgres` 容器和其唯一消费的 `oasis-postgres-data` 数据卷；所有财务及服务端未决业务必须为零。3 条已独立诊断的 `SETTLED` sandbox 演出残留仅在精确 session/App/game 范围及完整 session/cycle/state/result SHA256 证据覆盖时允许随专用卷丢弃，保留真实 `pending_presentations` 计数并明确未执行 ACK。数据库消费者同时核验 PostgreSQL 后端与各进程网络命名空间，包含共享 bridge 直连 `5432`；停 API 后必须没有外来客户端。外来进程/连接/依赖/数据卷消费者、加载后的未知命令或保护项变化均拒绝。局部检查可运行 `python3 platform/deploy/test_retire_public_sandbox.py`。

路由只精确修改 `/etc/nginx/conf.d/oasis.conf`，修改前核对原字节 SHA256，并以 `*.started.json` 私有记录保留原配置字节，修改后通过 `nginx -t` 才重载：公共 sandbox 页面、API 和旧下载返回 `410`，`/player` 以 `302` 转到独立生产域名并保留 `app_id` 等查询参数。共享 bridge、其他容器和 `5433`/`8850–8859` 业务、主域 TLS/ACME 续期、静态资源 HEAD、release/operations 锁、全部生产数据及历史控制器证据保留；共享代理容器 `/etc/nginx` 全部普通文件哈希按原生产收据核对并逐次重读。成功收据另附 `protection_handoff`，记录原 public 进程/数据库/健康页/Nginx 保护项的明确撤销及新保留项；后续控制器必须核验该收据，不能改写旧保护快照。`partial_refusal` 只证明已记录阶段，必须先读回现场再处理，不能据此宣布退役或盲目重跑。工具通过局部测试不等于服务器已经退役。
