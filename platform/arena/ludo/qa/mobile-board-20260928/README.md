# Ludo 手机控件与 WebKit 骰面

2026-09-28。仅修改 `LudoGame.jsx` 和本模块 `restoration.css`，未修改引擎或任何棋盘规则。

修复前在 WebKit 实际复现：权威 `dice=6`、DOM 正面 6 个点，但截图显示背面的 1 点。`before-webkit-dice.png/json` 保存图像、每面的点数与 transform/backface 属性。最终骰子只有一个受控二维正面，保留金色骰台、材质和掷骰动效；没有隐藏骰面参与合成。未知点数仍显示问号，不泄露下一次骰子。

棋盘棋子标注 1/2，新增最小 44 px 高的独立选择按钮。两枚棋子叠在同一格也可分别选择，继续使用原确认按钮提交；未扩大互相重叠的棋盘 hitbox。

运行：`node tests/mobile-board-controls-ui.mjs`。

Chrome 原生触摸、桌面 WebKit 可信鼠标指针分别在 390×844、360×844 检查：真实 HTTP 掷骰响应与唯一骰面一致，六种点数逐一核对；叠子先选 1 再选 2，仅 2 号棋子通过实际引擎移动，其他棋子不动。`report.json` 记录最终矩阵、trusted 输入事件与页面错误；每个浏览器六个骰面裁图可直接检查。不是 iPhone 真机 Safari 验收。

QA 使用单独随机端口和隔离引擎状态，每个 HTTP 尝试在引擎校验前计数。测试 finally 关闭浏览器及服务器，`server-cleanup.json` 记录关闭后连接被拒绝的读回。
