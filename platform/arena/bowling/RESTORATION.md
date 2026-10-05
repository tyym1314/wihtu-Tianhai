> 历史记录：下述范围仅指 2026-09-19。当前 Blender 模型、PBR 纹理与录像交付见 [2026-09-20 美术说明](ART-RESTORATION-2026-09-20.md)，本页“尚未使用 Blender”等表述已不代表当前版本。

# 2026-09-19 可视层恢复：低机位球馆、真实反射与倒瓶特写

状态：本地可玩画面改善，未宣称与概念图完全一致。引擎、权威物理、等级、钱包与共享平台服务在本次修改中均未编辑。

## 本次实现

- 重新安排球道低机位与跟球近景，使待发球完整出现在操作区之上，撞瓶时摄影机靠近真实物理瓶阵。
- 球道新增 Three Reflector 对真实球、瓶和球馆的实时反射；固定384×768单一反射目标、无多重采样。不是烘焙倒影图片，仍需真机测额外GPU成本。
- 球馆增加内嵌蓝紫灯槽、墙面竖向饰条、圆角座椅、墙面标识、路标；调整木色、灯光与材质。正确1+2+3+4十瓶排列不变。
- 接共享 `PlayerPortrait`，支持平台玩家头像与默认原创人物图；四人UI、真实比分、全中/补中和三局补投规则未改。

## 实际验证

- `tests/bowling-ui.mjs` 最小更新只涉及 esbuild automatic JSX、静态头像资源放行/映射；保留原有断言。390/360实际鼠标指针拖动进入独立HTTP权威引擎、真实十瓶回放、禁用忙状态、按钮全中、音效钩子均通过。
- `review/restoration-review.mjs` 额外检查共享头像数量与精确资源HTTP200；[报告](review/restoration-validation.json)。
- [准备画面](review/bowling-390-before.png)、[撞瓶镜头](review/bowling-390-collision.png)、[全中](review/bowling-390-strike.png)、[最新原测试报告](review/ui-validation.json)。

三款纯规则合跑60/60通过，TAP保存于 [restoration-rules.tap](../golf/qa/restoration-rules.tap)。完整arena构建成功，输出到独立临时目录以避免覆盖主预览；[构建输出](../bowling/review/restoration-build.txt)。所有浏览器证据来自macOS桌面Chrome移动视口，未在Android/iOS真机WebView验收，也没有访问主钱包。

## 尚存差距

主球和十瓶已经是可复用真实3D模型，可以继续代码制作；球馆仍是程序化建筑，缺少参考图中的高精度装饰/PBR资产与演出景深。当前不包含专业Blender制作或真机GPU/FPS验收。近景遵循服务端轨迹，不把参考图夸张飞瓶当成碰撞结果。

本轮没有新增AI生成的位图或使用整屏设计图假装可玩场景。保龄球仅复用root提供的共享人物图；其资产来源见共享目录说明。
