# 试玩站静态缓存边界

`/demo/`、`/demo/native/<game>`、`/demo/native-return` 和 `/api/demo/*` 均返回 `Cache-Control: no-store`。它们承载会话入口、访客身份或动态配置，不能使用公开长缓存。

试玩大厅与 Android WebView 宿主引用的六个公开文件（大厅 JS/CSS、H5 SDK、原生宿主模块/启动模块/CSS）使用 `/demo/static/<完整 SHA-256>/<文件名>`。持久归档可用时，响应对实际字节再次计算 SHA-256，并在返回 200 或 304 **之前**更新最后服务时间，随后返回 30 天 `public, immutable`、强 ETag 和正确的 JS/CSS MIME 类型。旧版未加指纹的 `/demo/host.mjs` 等 URL 仍可读取，但必须重新验证，不使用 immutable。没有配置持久归档的内存宿主仅返回需重新验证的缓存策略，不承诺 immutable。

启用 `OASIS_LOCAL_DIR` 时，服务只将这六类公开文件原子写入其下的 `demo-public-static-v1`，目录权限 0700、文件权限 0600。旧哈希 URL 从这里读取，并重新校验内容哈希；文件名按独立于当前构建的安全规则检查，仅允许归档目录中的 `.mjs` 和 `.css` 公共资源，因此文件改名后旧 URL 仍可在保留期内访问，其他扩展名和路径返回 404。最近一次成功服务后的保留期为 45 天，覆盖每次 30 天 immutable 承诺；条件请求 304 也会续期。归档至多 512 个文件、16 MiB，单文件至多 1 MiB。过期文件可删除；未过期文件不能为了腾空间提前淘汰。启动时若归档不可用或超限，宿主启动失败，必须扩容或待旧承诺到期后再切换版本。运行中的宿主如无法续期当前资源，则不再给该请求返回 immutable。归档只保存公开代码，不保存 HTML、Cookie、访客响应或密钥。

本次没有改动 `/arena/assets/`、`/legacy/assets/` 和 `/legacy/bundles/` 的 Nginx 转发。游戏构建资源现由平台 API 按带哈希与否分别返回 immutable 或重新验证缓存。后续若将文件直出交给 Nginx，必须先在隔离配置中验证 `nginx -t`、路径归一化与穿越拒绝、MIME、gzip、304、原子版本符号链接切换及回滚，再用真实手机和并发流量测量 TTFB 与帧耗时；未通过前保持现有路由。

本地回归：

```sh
cd platform
node --test tests/demo-static-cache.test.mjs tests/deployment-demo.test.mjs tests/native-game-host.test.mjs
node tests/native-game-host-ui.mjs
```
