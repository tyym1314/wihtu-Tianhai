# 飞镖手机输入回归

2026-09-28。修复范围仅 `DartsGame.jsx` 的手势生命周期和派发条件，未修改命中映射、分数、规则或美术。

- 一次拖拽绑定主 `pointerId` 和权威 `turnStartedAt`/当前镖数。第二触点（包括在靶面外）、系统取消、失去 capture、页面隐藏/失焦、回合变化都取消旧拖拽。
- 释放时用当前快照与服务器时钟再次核对可操作状态，并核对 capture 仍属于该指针。同步 pending 锁防止同一批事件重复发送。
- 取消、短按和失效手势不发请求；之后重新开始的合法拖拽仍正常投掷。

运行 `node tests/precision-touch-ui.mjs`。当前生产 UI + 隔离 HTTP 真实引擎通过 Chrome 8 项、WebKit 7 项检查，页面错误均为 0；合法拖拽得到一次实际 `throw` 接收。`report.json` 包含逐项结果及浏览器生成的 trusted 指针事件。

Chrome 使用 CDP 原生触摸序列（含双指、touchCancel）；桌面 WebKit 使用原生鼠标指针和实际 capture 释放。没有冒充 iPhone 真机 Safari 触摸验收。HTTP 请求在引擎校验前计数，服务器拒绝不能掩盖误提交。检查使用独立练习状态，无生产房间、钱包或部署。
