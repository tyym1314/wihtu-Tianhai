# 虎虎生财 · GOLDEN TIGER

独立的移动端 Web 试玩游戏。原雷霆王座继续使用 8787 端口；本游戏使用 8790，独立页面、构建目录、服务端入口、Cookie 和试玩钱包。

## 运行

在本项目目录执行：

```sh
node_modules/.bin/vite build --config tiger.vite.config.ts
node_modules/.bin/tsx server/tiger-index.ts
```

打开 http://127.0.0.1:8790/ 。本游戏使用 `dist-tiger`，不要用旧游戏的默认构建命令覆盖 `dist`。

开发时保留上述 API 服务，另运行：

```sh
node_modules/.bin/vite --config tiger.vite.config.ts
```

开发入口：http://127.0.0.1:5174/tiger.html 。默认只监听本机；可通过 `TIGER_PORT`、`TIGER_HOST`、`TIGER_DATA_PATH`、`TIGER_STATIC_DIR` 配置独立实例。

## 已实现

- 红金场景、原创立体质感老虎和符号；分层角色呼吸、眨眼、头部/手臂/尾巴摆动和中奖动作。采用 2D 分层动画，不是实时 3D 骨骼模型。
- 3×3 滚轴、5 条线、逐轴减速与回弹、锁定符号重转、中奖线、满盘 ×10、金币雨、分级大奖和数字跳动。
- AUTO 10/25/50/100 次、随时停止后完成本轮、极速模式、可调投入、记录与规则。
- 原创合成循环音乐和滚动、落轴、普通中奖、大奖等音效；首次点击解锁，支持独立开关及音量。
- 中文、英文、阿拉伯语界面；窄小屏幕可纵向滚动到完整操作区。
- 设置内的“演出预览”可直接查看大奖或满盘演出，不改变余额。
- 服务端生成与结算结果，幂等请求、待展示回合恢复、版本检查、独立 JSON 持久化钱包。

## 数值与当前范围

公开产品参考：[PG Fortune Tiger](https://www.pgsoft.com/games/110/)。本版本使用自制美术、音乐、代码和独立数学模型，未使用 PG 的游戏资源或私有算法，也未验证与原版逐帧一致。

长期 RTP 目标约 99%。最终独立种子模拟 20,000,000 个完整付费回合，观测 RTP **99.2086%**，95% 蒙特卡洛区间 **98.9911%–99.4262%**。这是抽样验证，不是精确理论值或认证结果；包括全部重转和最终倍率，最大模型奖励 455×。详见 `output/math/tiger-validation.json` 与 `output/math/tiger-model.md`。

当前是本机演示币版本，尚未接入 App 账户、礼物账本和正式经济系统。未完成实体 iPhone/Android WebView 的帧率、扬声器听音和安全区矩阵验收。

## 验证与资产

```sh
node_modules/.bin/tsc --noEmit
npm test
```

确定性 UI 验收工具为 `scripts/tiger-ui-fixture.ts`，使用 8789 端口及临时钱包；不会导入正式试玩服务器，退出后清理临时数据。

- 验收记录：`output/qa/tiger-v1.md`
- 全部测试：`output/qa/tiger-tests.tap`
- 音频信号验证：`output/qa/tiger-audio-validation.json`
- 旧游戏 37 个文件的保护基线：`output/tiger/thunder-baseline.json`
- 图片资产：`public/assets/tiger/`
- 场景/符号生成提示词：`output/design/tiger/scene-prompts.md`
- 角色生成提示词：`output/design/tiger/character-prompts.md`
