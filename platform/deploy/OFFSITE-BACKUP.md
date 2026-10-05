# 单次加密异地副本

此工具把已经完成并校验 `SHA256SUMS` 的备份封装为一个加密文件，供运维下载到用户 Mac；提供 `verify` 仅验证和 `restore` 恢复完整备份文件两种本地出口。它不连接第三方、不执行 SSH、不自动传输或定时备份，也不代表异地数据库恢复演练已经完成。

在服务器执行 `export`，只提供 RSA **公钥** PEM；私钥始终留在 Mac。工具生成随机 AES-256-GCM 密钥，以 RSA-OAEP-SHA256 包装；源备份时间、校验摘要、tar 哈希等头部信息作为 GCM 附加认证数据，修改头部、密文或认证标签都会验证失败。要求 RSA 2048–8192 位，归档上限 **64 MiB**；处理在内存中进行，峰值内存高于归档大小，不适合大备份。不得把私钥上传服务器或复制到发布目录。

```sh
node /opt/oasis/current/platform/deploy/offsite-backup.mjs export \
  /opt/oasis/backups/20260920T120000Z \
  /absolute/path/to/offsite-public.pem \
  /opt/oasis/private/offsite/oasis-backup-20260920T120000Z.oasis-backup
```

时间戳应替换为本次已经完成的备份目录；输出文件名必须使用相同时间戳，目录固定在 `/opt/oasis/private/offsite`。输出为 `0600`，原子创建且不覆盖现有文件。归档包含数据库转储、私有配置压缩包、发布版本记录、校验清单和数据库对象清单；不新增明文临时文件。

将加密文件和此脚本下载到 Mac 后，使用本机 RSA 私钥验证（脚本仅依赖 Node.js 内置模块）：

```sh
node /absolute/path/to/offsite-backup.mjs verify \
  /absolute/path/to/oasis-backup-20260920T120000Z.oasis-backup \
  /absolute/path/to/private-rsa.pem
```

`verify` 只在内存中解密、验证 GCM 和原 tar 哈希、再次核对内部备份清单；不解包到磁盘、不打印密钥或配置。成功仅输出源时间戳、哈希、字节数和文件数，失败非零退出。私钥 PEM 必须可由 Node.js 直接读取（本工具不接受交互式口令）。加密副本仍应保存在受控目录，并与服务器上的导出摘要核对 `envelope_sha256`。

需要实际恢复备份文件时，指定一个**尚不存在**的规范绝对路径，父目录必须已存在且不能经过软链接：

```sh
node /absolute/path/to/offsite-backup.mjs restore \
  /absolute/path/to/oasis-backup-20260920T120000Z.oasis-backup \
  /absolute/path/to/private-rsa.pem \
  /Users/your-account/Backups/oasis-restored-20260920
```

认证和全部校验完成后才创建新目录 `0700`，写入固定五个 `0600` 文件：`SHA256SUMS`、`database.dump`、`private-config.tar.gz`、`release.txt`、`database-contents.txt`。拒绝已有目标、软链、路径穿越及在线发布目录；完整性失败不创建输出，写入失败清理仅本次新建的目录。成功摘要包含输出路径，不打印文件内容。`private-config.tar.gz` 包含完整运行密钥与配置，**恢复目录是敏感明文备份**，不得公开分享或放入网站目录。

`restore` 不启动服务、不连接数据库、不覆盖正在运行的配置。数据库恢复演练接续使用 `restore-drill.mjs`：将这五个文件成套置于演练服务器新建的 `/opt/oasis/backups/<原始source_stamp>/` 私有目录后，按恢复演练命令执行隔离数据库导入、密钥解密和账本核对。完成演练前不要替换当前数据库、运行配置或 master key。

服务器 `backup.sh` 使用精确 `--exclude=private/offsite` 排除已导出的加密副本，防止后续备份把旧备份再次打入私有归档而递归膨胀。该排除仅针对 `private/offsite` 子目录；`private/state/master.key`、运行环境文件及其余私有配置继续保留。恢复出的明文副本应存放在工作目录或专用备份目录，不要另放到正在归档的 `private` 树内。

测试：`node --test tests/offsite-backup.test.mjs`。测试只使用临时生成的 RSA 密钥，不读取用户 SSH 私钥。
