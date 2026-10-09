# 真实玩家 HTTPS 入口

`production-ingress.py` 为已经隔离的真实 production 实例提供单独的 HTTPS 入口：
`https://oasis-player.43.98.202.236.sslip.io`。它使用 API `127.0.0.1:18891` 和
`/opt/oasis/production-current/platform/dist`；不启动 Demo、不创建玩家或余额，也不打开生产准入。
此入口用于切换稳定域名之前的实际后端、浏览器和手机验收。正式玩家 APK 应在最终入口确定后构建。

先用 `production-instance/` 建立关闭准入的独立服务、数据库、管理员和 paused 平台自有 App。
以下命令必须使用已经发布、完整校验的 immutable release 和实际清单 SHA。
每次改变阶段前重新生成独占的 check 文件；旧文件和失败日志需要保留。

```sh
python3 /opt/oasis/releases/YYYYMMDD-NN/platform/deploy/production-ingress.py check \
  --release /opt/oasis/releases/YYYYMMDD-NN --manifest-sha256 "$ACTUAL_MANIFEST_SHA256" \
  --output /opt/oasis/private/production-ingress-check-UNIQUE.json
python3 /opt/oasis/releases/YYYYMMDD-NN/platform/deploy/production-ingress.py acme \
  --release /opt/oasis/releases/YYYYMMDD-NN --manifest-sha256 "$ACTUAL_MANIFEST_SHA256" \
  --check-file /opt/oasis/private/production-ingress-check-UNIQUE.json
```

`acme` 只建立专属 HTTP challenge vhost；验证公开随机 challenge 的完整字节后删除本次 challenge。
重新 check 后运行 `certificate`，只申请 `oasis-production-player` 证书。
再次 check 后运行 `start`，要求本地与公网 `/health/ready` 都返回真实 production 环境及健康状态。
若本次新建的 TLS vhost 验证失败，仅回收本次创建的 vhost 并重新检查、重载 Nginx。

所有阶段保护其他主机与 Docker Nginx vhost 的完整 SHA 和现有 proxy 容器身份，复用既有
`/opt/oasis/private/release.lock`；不会创建、覆盖或删除公共试玩配置与退役 Mock 配置。
HTTP 路由和 TLS vhost 仅使用新的精确 hostname。操作失败可能保留专属 ACME 文件或证书，
应先读取现场状态并生成新 check，不能把成功申请的证书当作需要重复创建的资源。

专属证书路径为 `/opt/oasis/acme/config/live/oasis-production-player/fullchain.pem`。
`oasis-production-player-certificate.timer` 每天两次触发专属 `.service`，命令绑定已验证发布源码与清单。
续期使用同一保护和锁；只有成功后才重载 Nginx。监控必须明确使用这些路径和 unit，不能沿用试玩证书。
工具和两个 scope helper 必须与实际发布清单一致。Certbot 禁止目录 hooks，默认 CLI 配置必须不存在或为空；
专属 renewal 配置仅允许同一域名、webroot 和证书目录，拒绝执行 hooks 与 installer。
启用专属 timer 前，会核对主文件、链接、drop-in 和 systemd 的全部实际执行命令。

入口禁用 Demo 和历史测试 APK 下载。HTML 不缓存；资源只有命名包含内容哈希时才使用长期 immutable 缓存，
未版本化图片保留重新验证。JSON、JavaScript 和模型使用 HTTP/1.1 代理及 gzip。

本工具通过配置语法、单次健康检查或证书检查，不表示已经满足上线标准。上线仍要求实际 App、
真实账户及零余额、原游戏恢复/退出、手机操作与持续性能、容量、备份恢复和业务对账验证。
