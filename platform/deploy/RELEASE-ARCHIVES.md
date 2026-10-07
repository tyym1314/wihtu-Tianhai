# Release 归档与 Restic 去重试验

现有 `archive-releases.py` 生成的 `release.tar.gz`、`snapshot.json`、`receipt.json` 和 `identity.json` 是恢复依据。`compact-release-archives.py` 建立可验证的 Restic 副本，本身不删除原 tar。完成独立副本还原后，可另行显式运行本文末尾的 `retire-release-archives.py` 协议逐份释放 tar；三份历史 metadata 永久保留。所有工具均不发布恢复目录，也不修改 `current`、`android-mock-current`、数据库或 private 配置内容。

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

`compact-release-archives.py` 不提供 tar 删除、`forget`、`prune`、覆盖 release 或切换服务的接口。只读预检不执行 Restic，返回 `repository_verified: false`，不能证明密码或 repository 可用，也不能替代写操作持锁后的再次检查。

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

v1 pilot 保留原 tar 及其 receipt/snapshot；只有下述独立迁移协议可以改变 tar 的保留状态。初始化不得重置既有密码、key 或 repository。重复 `--backup RELEASE` 在已有 index 条目时重新完整检查、真实恢复比对，通过后返回 `already_verified`，不增加 snapshot；v2 已释放 tar 的版本同样验证已有精确快照，不试图重新备份缺失 tar。重复 `--restore RELEASE` 若已有 `restored/<release>` 则拒绝覆盖，不发布或更换运行 release。

备份完成但 index 尚未登记、恢复完成但校验尚未落盘、文件同步或目录重命名中断，均不能自动标记成功。中断时保留专属 scratch、journal、原 tar 和 repository，返回 `INCOMPLETE_PILOT_REQUIRES_INSPECTION`；journal 中精确 snapshot ID 用于人工调查。不能自动 `unlock`、`prune`、`forget` 或复写密码/index。只有完整 check 和真实恢复比对通过后才提交 index；未登记 snapshot 不构成已验证恢复承诺。

## 密码和副本风险

Repository 包含加密 key 文件，但访问仍需要有效密码。只备份数据文件或只记住密码都不够：完整 repository 和密码恢复材料都要保留。丢失全部有效密码会使备份无法恢复。[官方初始化与密码说明](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)

同机 Restic repository 可以降低保留版本的重复占用，却仍与服务器磁盘、主机故障共用失效范围。Mac 可保存完整 repository 的第二份副本，并实际验证从该副本在 Linux 恢复；不应因服务器已有去重副本，就把 Mac 上单份文件称为可靠的唯一离线保障。

不要先在 Mac 上以普通用户解包 Linux 原树再备份，并假定数字 UID/GID、大小写敏感路径或其他元数据均保持不变。若要验证 Linux 还原能力，应在 Linux 保留原属性地生成和恢复快照，或以原清单逐项证明跨平台结果。

## 验证状态

2026-10-08，固定官方二进制的真实 Linux 隔离夹具 **17/17 通过**，用时 24.251 秒。夹具覆盖两份 release 的初始化、备份、`check --read-data`、精确快照恢复、重复备份不增加快照，以及原 tar 不可访问时的独立恢复。恢复比较包含非默认数字 UID/GID、符号链接和纳秒 mtime；密码未变化，既有恢复目标及重复初始化均拒绝覆盖。

失败用例验证了错误仓库身份、权限或二进制摘要、短 snapshot ID、错误 tag、清单损坏、空间不足、进程占用、被修改的恢复空间界限、原 receipt 变化和 repository 同步失败；未验证副本不得登记成功。同步故障属于注入测试，不构成真实断电试验。

上述 17 项测试仅使用经授权的新临时目录 `/tmp/oasis-restic-fixtures-20261008-365754eb67f1`；全部 base、proc、repository、密码和 scratch 均位于其中，测试完成后核对夹具身份并删除该目录。执行前、执行后及清理后分别读回可用空间；代码执行 3 GiB 保留检查，这些采样不是连续空间监控。该批夹具本身未初始化或备份 `/opt/oasis` 的真实 repository，也未验证 Mac 副本；后续独立副本证明是另一份单独绑定的证据，不能从此测试结果推导。

完整本地记录位于 `platform/review/release/restic-tool-development/linux-fixtures-365754eb67f1.log`，该 ignored 日志 SHA-256 为 `f623dc27706d902c01adb753a992f5d2ccacb2751e85505a9ea89a83d7c728af`。本次被测源码 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `compact-release-archives.py` | `2b5397eb1c17bd343e8a14b73441db24a424938ba408181d38a81d5189ae879d` |
| `test_compact_release_archives.py` | `2d531170acf692ce9a016bc27bb869c801fb7460daac2ade6a543aba74896819` |

常规本地夹具可运行 `python3 -m unittest discover -s platform/deploy -p 'test_compact_release_archives.py' -v`；没有显式选择官方二进制时，真实 Linux Restic 用例会跳过。微型夹具的 repository 占用不代表真实 9 版归档可节省的空间；真实 pilot 须另行读回实际磁盘分配量和每份恢复结果，原 tar 在本阶段始终保留。

## 独立副本验收后的逐份 tar 迁移协议

`retire-release-archives.py` 是独立的显式操作入口。默认只读 `--check-only`，每次必须指定一个 allowlist release。迁移工具需要同目录的 `compact-release-archives.py` 与 `archive-releases.py`；原始 tar、repo、密码、二进制和恢复材料均不能由路径猜测或宽泛删除处理。

首次准备需要一个已有的证明目录，其中包含 `materials.json`、`transfer-proof.json`、`linux-restore-report.json`，并从独立保留的 receipt 指定 transfer SHA 与原 v1 index SHA。目录不包含密码。工具验证 transfer 对材料与 Linux 报告的摘要绑定，核对完整导出包的 SHA/bytes、repo ID、原 index、九个不同的完整 snapshot ID、每版三份 metadata 及历史 tar 摘要，并要求九份 Linux 实际恢复全部通过、`check --read-data` 通过、全部 POSIX 比较字段齐全。Mac 的物理保管位置不能从 JSON 自行推导：transfer receipt 由已执行复制及读回的控制流程提供，外部 SHA 是信任入口。

示例中的 SHA 必须替换成操作人员独立保存的完整值：

```sh
python3 retire-release-archives.py --check-only 20260927-01 \
  --proof-directory /absolute/path/to/verified-proof \
  --expected-transfer-sha256 FULL_TRANSFER_RECEIPT_SHA256 \
  --expected-index-sha256 FULL_ORIGINAL_V1_INDEX_SHA256

# 仅在检查、代码审查和真实 Linux 隔离夹具通过后，显式处理这一版。
python3 retire-release-archives.py --release-tar 20260927-01 \
  --proof-directory /absolute/path/to/verified-proof \
  --expected-transfer-sha256 FULL_TRANSFER_RECEIPT_SHA256 \
  --expected-index-sha256 FULL_ORIGINAL_V1_INDEX_SHA256
```

第一次显式操作把原 v1 index 和三份证明的原始字节保存到 `release-dedup-pilot/retirement/`，0700 目录与 0600 文件，最后形成不可变 `capsule.json`。每版 `release-archives/<release>/storage.json` 是 tar 状态的唯一权威；live index 升级为 `format:2, original_tar_policy:"per_release"`，只引用证明摘要与状态协议。没有状态文件、未知状态、摘要不符或非 allowlist 条目必须拒绝，不能默认“仍保留”。初始化完成前的 v1 重试仍必须提供外部两项 SHA；不会仅信任未被 v2 index 锚定的本地 capsule。

| 状态 | 预期文件布局 | `--recover RELEASE` 行为 |
| --- | --- | --- |
| `retained` | `release.tar.gz` 存在，隔离名不存在 | 无需恢复 |
| `quarantine_prepared` | 原名或隔离名恰好存在一个 | 验证原 inode/内容后回退原名并记 retained |
| `quarantined` | 仅 `release.tar.gz.retiring` 存在 | 验证后回退原名 |
| `unlink_prepared` | 仅隔离名存在，或删除已完成且两者均无 | 仍在则回退；已无则重新完整检查并真实恢复后补记完成 |
| `restic_only` | 两个 tar 名均不存在 | 保持已完成状态，不新建或删除任何 tar |

`--recover` 不执行 tar unlink。v1 准备阶段中断时，它可以在外部摘要仍匹配、九份原 tar 均完好的条件下完成 v2 登记；并不会继续释放。任意歧义（两个名字同时存在、删除意图前两个名字均缺失、inode/hash 改变等）均停止并保留现场。原子状态写入使用临时文件、文件 fsync、replace、目录 fsync；中断留下的非权威 `.next` 文件留作检查，不作为状态读取。

实际 `--release-tar` 全程持有既有 deployment/archive 双锁，重新检查 current/mock/previous/recent/process references、静态资源覆盖及不少于 3 GiB 的空间余量。先对服务器 repo 执行 `check --read-data`，按精确 snapshot ID 真实恢复并逐项比对；仅验证完成的自有 scratch 被清理。随后再次读回证明、index、metadata 与保护状态，将原 tar 同目录改名隔离；持久化删除意图后，最后重新校验 tar 的设备/inode/size/模式/UID/GID/mtime/单链接及 SHA，再通过目录 FD unlink 精确隔离名并 fsync。记录的 tar 分配字节与文件系统可用空间增量分别输出，不把逻辑文件大小当作实际回收量。

旧 `archive-releases.py --restore RELEASE` 对 retained 版本保持原行为。迁移中的版本返回 `ARCHIVE_RETIREMENT_IN_PROGRESS` 及恢复命令；已释放版本返回 `ARCHIVE_MOVED_TO_RESTIC` 与 `compact-release-archives.py --restore RELEASE`，并明确 `restored:false`。Restic 恢复仍只写独立 `restored/<release>`，不会自动发布。原 `receipt.json` 中 tar SHA 是历史身份，不能用它为重新压缩、字节不同的 tar 背书。

失败的真实恢复保留 scratch 和 journal，并阻止后续写操作，需人工检查；`--recover` 不自动抹掉未验证的恢复现场。服务器 repo 与 Mac 第二份材料均保留，工具不提供 `forget`、`prune`、`unlock`、整目录删除、重新生成密码或清理原 metadata 的接口。

本地新增测试运行方式：

```sh
python3 -m unittest discover -s platform/deploy -p 'test_retire_release_archives.py' -v
```

真实 Linux 隔离夹具必须显式设置 `RESTIC_REAL_BINARY_ARCHIVE` 指向固定官方压缩包。测试依赖同目录的三个测试文件 `test_retire_release_archives.py`、`test_compact_release_archives.py`、`test_archive_releases.py`，以及四个生产工具 `retire-release-archives.py`、`compact-release-archives.py`、`archive-releases.py`、`verify-release-replica.py`。它会在临时目录建立九份快照、用另一份完整导出实际恢复九份，再释放其中一份测试 tar 并核验非默认 UID/GID、符号链接、纳秒 mtime 的恢复。夹具中的 Mac custody receipt 是模拟输入，不能替代生产的 Mac 复制证据。未选择该环境变量时该项明确 skip；本地假 Restic 通过不代表真实 Linux 夹具通过，更不授权生产释放。

2026-10-08，该入口与 archive、compact、replica 的完整定向测试已在真实 Linux 隔离目录运行，**79/79 通过、零跳过**，用时 107.697 秒。两项真实 Restic 用例都执行；九份独立恢复、单份测试 tar 释放及随后的精确恢复通过。临时目录 `/tmp/oasis-retirement-fixtures-20261008-cf2287437810` 已核对身份并清理，执行后两套线上服务健康检查通过，未操作线上九份原 tar。

记录为本地忽略上传的 `review/release/retirement-tool-development/linux-fixtures-cf2287437810.log`，SHA-256 `c7dd5a36c523497317e68ac43c4299f946685b7d14fbfc7f654296267ea0833e`。被测迁移工具 SHA-256 `aa9569bdb6ee36c8b950df6481d903f1dc6a9dc2659edf90c8177398582b4164`，archive 为 `f5f10f2eb95c921419f82259ebe539e3596744cd9eb79bc3701a47771dfaffde`，compact 为 `82ff0677603a3dd7515aa983f64f42d97d6cd1ef8cb128ce169e056001d9e072`。这些是隔离夹具证据；线上释放仍须通过对应版本的实际证明、保护条件和恢复门禁。
