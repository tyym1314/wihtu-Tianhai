# Release 归档与 Restic 去重试验

现有 `archive-releases.py` 生成的 `release.tar.gz`、`snapshot.json`、`receipt.json` 和 `identity.json` 是保留的恢复依据。Restic pilot 只建立第二种可验证副本，用于测量跨版本去重效果；不会替换或删除原归档，不发布恢复目录，也不修改 `current`、`android-mock-current`、数据库或 private 配置。

## 范围和固定目录

试验只接受与归档工具相同的 9 个 release：`20260927-01`、`20260927-02`、`20260927-03`、`20260928-01`、`20260928-02`、`20260928-03`、`20261004-02`、`20261004-03`、`20261004-04`。

固定工作根为 `/opt/oasis/release-dedup-pilot`：

| 路径 | 用途 |
| --- | --- |
| `repo/` | 独立 Restic repository，包含数据、索引、快照、配置及加密 key 文件 |
| `password` | root 拥有的 0600 密码文件；不输出到日志或命令行 |
| `bin/` | 固定版本、核对压缩包及解压后二进制 SHA-256 的工具 |
| `index.json` | release、原归档指纹、精确 Restic snapshot ID 及校验结果之间的关联 |
| `scratch/` | 从原归档实际解包后核验的临时树 |
| `restored/` | 独立恢复验证目录；禁止作为运行 release 发布 |

写操作同时持有既有 deployment/archive 锁，重新核验 allowlist、current/mock/previous/recent releases/process references 保护和当前静态资产覆盖。空间检查使用普通可用空间，保留至少 3 GiB；解包、repository 新增、缓存及恢复验证的峰值空间仍须纳入估算。检查失败应拒绝继续，不能删除原 tar 换取临时空间。

## 来源与依赖

Restic 固定为 **0.19.1 / Linux amd64**，下载来源限定为 [官方 v0.19.1 release](https://github.com/restic/restic/releases/tag/v0.19.1)，对应 `releases/download/v0.19.1/` 下的官方 `.bz2` 和 `SHA256SUMS`。代码固定压缩包 SHA-256 与解压后二进制 SHA-256，并在初始化及使用前核对；不使用本机 `PATH` 中的 restic。已按 HTTPS 官方 `SHA256SUMS` 核验下载，未完成 PGP 签名验证，不称为“已验证签名”。

| 文件 | 固定 SHA-256 |
| --- | --- |
| `restic_0.19.1_linux_amd64.bz2` | `f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c` |
| 解压后的 Restic 二进制 | `20d4142678d0d95ec11a4759def1b73fd9190abc9ca19e4b62d067c0b387e639` |

运行目标是 Linux amd64，需 Python 3.10+、同目录的 `archive-releases.py`、POSIX 文件系统、root 权限及可用的 `flock`、`fsync`、UID/GID 与符号链接操作。root 用于保留、恢复和验证原数字属主及权限。初次初始化的密码必须另行安全备份；工具本身不把密码或 repository 复制到 Mac。

## 命令协议

程序为 `compact-release-archives.py`。原 tar 保持完整，因此本阶段会增加磁盘占用；`repository_allocated_bytes` 和 `pilot_allocated_bytes` 是副本占用，不是已释放空间。

| 接口 | 预期作用 |
| --- | --- |
| `--check-only [release]`，默认模式 | 只读检查一项或全部 allowlist、保护条件、归档指纹、空间和现有试验状态；不初始化 repository |
| `--init --binary-archive <官方 linux_amd64.bz2>` | 核对固定工具，创建全新的独立 repository 和密码；不备份 release |
| `--backup <release>` | 对一项原 tar 真实解包并核验，备份文件树，记录精确 snapshot ID |
| `--verify [release]` | 完整读取 repository 数据并检查，再恢复一项或全部已登记快照、与原清单比对 |
| `--restore <release>` | 按已登记精确 snapshot ID 恢复到独立目录并核验；不覆盖或发布现有目录 |

不存在原 tar 删除、迁移、`forget`、`prune`、覆盖 release 或切换服务的接口。只读预检不执行 Restic，返回 `repository_verified: false`，不能证明密码或 repository 可用，也不能替代写操作持锁后的再次检查。

## 备份和恢复证据

1. 先验证原归档身份、receipt、tar 和 snapshot 指纹；把 tar 实际解包到工具自己的新目录，拒绝路径逃逸、外部链接和特殊文件。逐项核对原 snapshot 的路径集合及逻辑条目：类型、模式、UID/GID、mtime、链接目标、文件大小和 SHA-256。ctime 由重建文件产生，不作相等要求；分配块数不是逻辑内容相等的替代指标。
2. 对核验后的**解包文件树**运行 backup，保留退出码、snapshot ID、数据新增量与原归档指纹。不能仅把 `tar.gz` 当作输入，再声称获得原文件树的去重率。
3. 执行 `check --read-data`，完整读取数据块；普通 `check` 主要核验 repository 结构，不能替代该步骤。[官方 repository 检查说明](https://restic.readthedocs.io/en/stable/045_working_with_repos.html)
4. 按每个已登记的**精确 snapshot ID**，使用独立、空的目标目录实际 restore；不使用浮动 `latest`，不使用 `--delete`。Restic 默认可能覆盖目标文件，因此程序必须先拒绝已占用的目标。[官方恢复说明](https://restic.readthedocs.io/en/stable/050_restore.html)
5. 在目标 Linux 文件系统上再次比对全部逻辑条目，记录每版结果。`check --read-data` 通过不等于应用恢复验证通过；Mac 上成功解包也不等于 Linux 元数据等价。
6. 读回 index、9 项登记状态、校验结果及 repository 实际占用。节省量使用磁盘实际分配量与可恢复副本的同口径比较；跨版本唯一文件 SHA-256 总量只是内容重复程度的证据，不能直接充当 Restic repository 大小。

恢复会先从精确 snapshot ID 读取已固定 SHA-256 的原清单，重新计算所需空间，再写恢复树；不会只相信可编辑 index 中的空间数字。入口独立于原 tar，但仍依赖配套 `archive-releases.py`、既有 deployment 锁、current/mock/previous/process 保护状态和当前静态资产覆盖。它是本机受保护的历史版本恢复入口，不是已验证的裸仓库灾难恢复工具。恢复材料须同时保存完整 repository、密码恢复材料、index 和两个 Python 工具；失去主机状态时的独立灾备流程仍需另外验证。

Restic 支持跨快照内容去重，改名可能需要重新扫描，但相同内容仍可共享；权限、属主等元数据变化仍被保存。符号链接按链接保存，不跟随目标。[官方备份说明](https://restic.readthedocs.io/en/stable/040_backup.html) 具体元数据能力见 [Metadata handling](https://restic.readthedocs.io/en/stable/manual_rest.html#metadata-handling)。

对压缩 tar 去重效果较差是需要实测的技术推断：压缩前内容、顺序或元数据变化可能改变压缩流，Restic 看到的是压缩后的字节。不能断言其完全没有去重，也不能预先承诺节省比例。

## 中断与重复执行

原 tar 及其 receipt/snapshot 始终保留。初始化不得重置既有密码、key 或 repository。重复 `--backup RELEASE` 在已有 index 条目时重新完整检查、真实恢复比对，通过后返回 `already_verified`，不增加 snapshot。重复 `--restore RELEASE` 若已有 `restored/<release>` 则拒绝覆盖，不发布或更换运行 release。

备份完成但 index 尚未登记、恢复完成但校验尚未落盘、文件同步或目录重命名中断，均不能自动标记成功。中断时保留专属 scratch、journal、原 tar 和 repository，返回 `INCOMPLETE_PILOT_REQUIRES_INSPECTION`；journal 中精确 snapshot ID 用于人工调查。不能自动 `unlock`、`prune`、`forget` 或复写密码/index。只有完整 check 和真实恢复比对通过后才提交 index；未登记 snapshot 不构成已验证恢复承诺。

## 密码和副本风险

Repository 包含加密 key 文件，但访问仍需要有效密码。只备份数据文件或只记住密码都不够：完整 repository 和密码恢复材料都要保留。丢失全部有效密码会使备份无法恢复。[官方初始化与密码说明](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)

同机 Restic repository 可以降低保留版本的重复占用，却仍与服务器磁盘、主机故障共用失效范围。Mac 可保存完整 repository 的第二份副本，并实际验证从该副本在 Linux 恢复；不应因服务器已有去重副本，就把 Mac 上单份文件称为可靠的唯一离线保障。

不要先在 Mac 上以普通用户解包 Linux 原树再备份，并假定数字 UID/GID、大小写敏感路径或其他元数据均保持不变。若要验证 Linux 还原能力，应在 Linux 保留原属性地生成和恢复快照，或以原清单逐项证明跨平台结果。

## 验证状态

2026-10-08，固定官方二进制的真实 Linux 隔离夹具 **17/17 通过**，用时 24.251 秒。夹具覆盖两份 release 的初始化、备份、`check --read-data`、精确快照恢复、重复备份不增加快照，以及原 tar 不可访问时的独立恢复。恢复比较包含非默认数字 UID/GID、符号链接和纳秒 mtime；密码未变化，既有恢复目标及重复初始化均拒绝覆盖。

失败用例验证了错误仓库身份、权限或二进制摘要、短 snapshot ID、错误 tag、清单损坏、空间不足、进程占用、被修改的恢复空间界限、原 receipt 变化和 repository 同步失败；未验证副本不得登记成功。同步故障属于注入测试，不构成真实断电试验。

测试仅使用经授权的新临时目录 `/tmp/oasis-restic-fixtures-20261008-365754eb67f1`；全部 base、proc、repository、密码和 scratch 均位于其中，测试完成后核对夹具身份并删除该目录。执行前、执行后及清理后分别读回可用空间；代码执行 3 GiB 保留检查，这些采样不是连续空间监控。未初始化或备份 `/opt/oasis` 的真实 repository，未制作或验证 Mac 副本，也未完成脱离现有主机状态的灾难恢复。

完整本地记录位于 `platform/review/release/restic-tool-development/linux-fixtures-365754eb67f1.log`，该 ignored 日志 SHA-256 为 `f623dc27706d902c01adb753a992f5d2ccacb2751e85505a9ea89a83d7c728af`。本次被测源码 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `compact-release-archives.py` | `2b5397eb1c17bd343e8a14b73441db24a424938ba408181d38a81d5189ae879d` |
| `test_compact_release_archives.py` | `2d531170acf692ce9a016bc27bb869c801fb7460daac2ade6a543aba74896819` |

常规本地夹具可运行 `python3 -m unittest discover -s platform/deploy -p 'test_compact_release_archives.py' -v`；没有显式选择官方二进制时，真实 Linux Restic 用例会跳过。微型夹具的 repository 占用不代表真实 9 版归档可节省的空间；真实 pilot 须另行读回实际磁盘分配量和每份恢复结果，原 tar 在本阶段始终保留。
