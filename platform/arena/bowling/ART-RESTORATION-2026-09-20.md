# Neon Bowl · 2026-09-20 实际美术交付

> 历史阶段记录。当前场馆、相机、柔光和最新三视口证据见 [场馆第三轮](ART-VENUE-V3-2026-09-20.md)。

本轮保持现有权威引擎、刚体参数、轨迹、倒瓶判断、补投、截止和钱包不变。球、十瓶、球道、灯光与摄影机均为实时 WebGL；没有把原稿整屏盖到游戏上。

## 对原稿的实际改进

以 `output/design/pvp-arena-concepts-v1/07-bowling.png` 为参照，实际运行 Blender 4.5.14 LTS，制作深色私享球馆、平滑瓶身及红色颈圈、具有三个真实布尔孔洞与独立暗色内壁的树脂球。修正瓶模型面朝向，保证瓷白瓶身和红颈圈正常显示；交付原生 `.blend` 与 Draco GLB。

主球更近、更大且完整露在底部操作区之上。球体新增原创紫蓝珍珠树脂星纹，暗场蓝紫灯带、原创霓虹瓶冠后墙、深色金属木艺和柔化实时球道反射取代原先偏亮的塑料柱阵。十瓶仍按真实 1+2+3+4 排列与权威姿态运动。

HUD 保留真实玩家、当前总分/待定分、局次与时限，取消重复品牌副标题。逐局成绩、方向与力度改为可展开明细；默认操作区只有旋转与投球。场景前划投球手势仍可用。

动态粒子避免使用初始原点包围球裁剪，修复瓶区特写中的粒子误剔除。跟球镜头进入撞击区，物理接触触发粒子及音效钩子。只有引擎确认全中后才开始约三秒已知合法轨迹的慢动作回放，叠加金色光点。回放不更改任何物理结果、输入时间或得分，后续合法投球可中断。共享结果外壳约定最终合法事件后的 3400 ms 展示尾段。

## 文件与出处

- `BowlingGame.jsx`、`bowling.css`：手机布局、可展开参数/计分、真实比分和事件状态。
- `scene.mjs`：球馆、后墙、球道材质、反射、镜头、真实轨迹及确认后的慢动作演出。
- `art.mjs`：压缩模型/解码器、瓷瓶/金属/树脂材质与资源释放。
- `assets/source/build_neon.py`、`render_result.py`、`optimize-textures.mjs`：实际运行的制作与交付脚本，保留 `.blend`、执行日志、原始纹理。
- [原创图片完整 prompt 和来源](assets/PROVENANCE.md)，[尺寸及 SHA256](assets/manifest.json)。后墙图片仅是实际场馆中的一块墙面，不包含可玩球道或 UI。

## 验证与证据

- Golf + Bowling 引擎 33 / 33 通过，其中 Bowling 19；物理与计分源没有修改。
- `node tests/bowling-ui.mjs`：三项原有独立 HTTP + 真实指针投球验证通过，390 两人、360 四人拖动及普通按钮投球。保留忙状态、轨迹、全中和音效钩子断言，只补静态模型/Draco 路径以真实使用新资产。
- `node tests/golf-bowling-art-ui.mjs`：合计四视口场景；Bowling 390×844、360×800 实际点击/划动，真实全中、碰撞与确认演出；无溢出或页面错误，不访问钱包 API。
- 独立 production bundle 以真实 Chrome 验证散列资产路径和 Draco 解码，未使用 fallback。桌面 frame median 16.7 ms / p95 16.7 ms，完整帧约 154 draw calls / 26 万三角形，包含反射等重复渲染。不得当作实体手机数据。
- [390 主画面](assets/review/bowling-390-blender.png)、[360 主画面](assets/review/bowling-360-blender.png)、[碰撞途中](assets/review/bowling-390-impact.png)、[真实全中演出](assets/review/bowling-390-strike.png)。
- [实际投球到全中录像](assets/review/bowling-motion.webm)、[动作/权威结果记录](assets/review/motion-evidence.json)、[UI 报告](assets/review/art-ui-report.json)、[构建报告](assets/review/build-report.json)。录像无音轨，仅记录音效接口调用，未验收物理扬声器。

专用预览与 Golf 共用 `golf/art-review.config.mjs`，18122 / 独立 cache / 无钱包。使用 `?game=bowling&players=2&lang=en`。该入口是本地审图工具，不是对外试玩服务。

## 仍与原稿不同的部分

球、瓶、控件占比和暗场氛围已明显靠近原稿，但没有达到绘制稿的电影级全局照明、景深与装饰密度。当前球馆为真实几何配局部墙面美术，反射为成本受控的实时近似；没有把夸张静态飞瓶排列伪装成权威碰撞。首次模型解码、低端设备质量档、实体 iOS/Android WebView 和音频仍需专项验收。此交付不代表生产、真钱包或外部合作方验收。
