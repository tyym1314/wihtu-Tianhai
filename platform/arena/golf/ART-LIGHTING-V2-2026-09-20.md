# Golf 光照与自然材质 · 第二轮实际交付

范围仅 `arena/golf/`。没有编辑引擎、物理、关卡规则、Bowling、共享外壳、服务或钱包。本轮是在上一轮实际 Three.js / Blender 场景上继续制作；原 03 概念图仍是参照，没有被拿来盖住可玩的球场。

## 明确的前后证据

[完整对比页](assets/review/lighting-v2/comparison.html) 同时展示三个视口的前后图、入洞画面与实际录屏。

| 视口 | 修改前，同样四人/机位 | 修改后 | 实际一杆入洞 |
| --- | --- | --- | --- |
| 360 × 800 | [前](assets/review/lighting-v2/before-360.png) | [后](assets/review/lighting-v2/after-360.png) | [入洞](assets/review/lighting-v2/after-360-hole.png) |
| 390 × 844 | [前](assets/review/lighting-v2/before-390.png) | [后](assets/review/lighting-v2/after-390.png) | [入洞](assets/review/lighting-v2/after-390-hole.png) |
| 430 × 932 | [前](assets/review/lighting-v2/before-430.png) | [后](assets/review/lighting-v2/after-430.png) | [入洞](assets/review/lighting-v2/after-430-hole.png) |

[390 真实操作录屏](assets/review/lighting-v2/golf-lighting-v2-motion.webm)：从实际力度条点击、击球按钮，经过权威轨迹滚动到一杆入洞与杯边金色光迹。无音轨，`shot`/`win` 接口事件另存报告；不能据此声称真实扬声器或系统静音验收。所有参与者是这个独立本地 fixture 的明示机器人标签；不连接钱包。

## 这一轮具体改变

1. **石岸**：重新实际运行 Blender 建模。取消随机三角面块状配色，使用连续侵蚀层、浅凹凸与一致的砂岩色系；保留圆润但清楚的砌石接缝，石块高度/边缘稍有差异。显示岸体和装饰石变化都在球道碰撞边界之外，合法球路与洞位不变。重新导出三个 GLB 和可编辑 `.blend`。
2. **植物**：原先近乎平直的“梯形排叶”改成十九枝带弧度的棕榈羽状叶；每片小叶都有窄尖、中心折面与弯曲，茎轴随冠层弯曲。加入合批的石岸垂藤，遮断重复的砌石节奏。叶材质增加薄叶背光近似，保留明暗差，不是实体次表面散射模拟。
3. **材质**：石材/草面采用旋转、不同缩放的双纹理采样和低频世界坐标变化，降低同一纹理反复平铺的痕迹。加入近水湿石脚与局部轻微苔色。新代码在 `materials.mjs`，不提供任何碰撞或计分数据。
4. **水面**：减小重复大波形，改成交叉细波；以当前球场和装饰岸线生成只用于着色的近岸浅水掩码，加入浅水青绿过渡和细小动态亮纹。岸边泡沫跟随不规则花园轮廓，不再使用简单圆环。Water 仍反射真正的前景模型。
5. **光照**：增强暖色定向日光，降低统一环境填充，保留蓝色阴影层次。对新植物/石岸 **实际重新执行三次 Cycles AO 烘焙**，更新三洞接触阴影，并保留完整 `.blend` 与运行日志。只重烘焙 AO，不拿静态渲染替代实时玩法。

## 实际验证

- [before-report.json](assets/review/lighting-v2/before-report.json)：修改前捕获三个视口。
- [after-report.json](assets/review/lighting-v2/after-report.json)：360 / 390 / 430 均完成真实指针输入，忙时按钮禁用，权威成绩为 1 杆、动作数恰好 1、进入杯边特写、触发 `win`。console / 页面 / 资源错误为 0，没有 `/api` 或 `/v1` 请求。
- [第二/第三洞](assets/review/lighting-v2/courses-report.json)：额外检查重新烘焙后的两个场景，无资源/着色器错误；对应 [第二洞图](assets/review/lighting-v2/after-390-course-2.png)、[第三洞图](assets/review/lighting-v2/after-390-course-3.png)。这是明确的视觉 fixture，不冒充三洞全程操作。
- [规则 TAP](assets/review/lighting-v2/rules.tap)：既有 Golf 规则 14 / 14，通过完整三洞、边界处罚、同 tick 弃权等；未改测试或引擎来迁就美术。
- [独立 production bundle 检查](assets/review/lighting-v2/build-report.json)：散列 GLB/WebP/Draco URL 正常，实际 WebGL shader 编译无错误，不走 fallback。桌面 Chrome 当前采样 median / p95 约 16.7 ms。

复现（从 `platform/`，使用既有只读审图服务 18112）：

```sh
node arena/golf/qa/material-pass.mjs after
node arena/golf/qa/material-courses.mjs
node arena/golf/qa/material-build.mjs
```

没有启动或重启主 API，也没有调用真实钱包。构建检查仅启动随机端口的临时静态服务并自动清理。

## 源与资源记录

`assets/source/build_oasis.py`、`render_result.py` 已实际执行。建模日志 `build-lighting-v2.log`；三洞烘焙日志 `ao-lighting-v2-hole1.log` 至 `hole3.log`。使用项目现有 Blender 4.5.14 LTS，没有安装新软件。`assets/manifest.json` 更新为本轮 SHA256 和字节数。没有生成新的 AI 图像；继续使用上一轮已有原创纹理与远景，其完整来源保持在 [PROVENANCE.md](assets/PROVENANCE.md)。

## 仍剩余的局部差距和成本

这轮减少了硬分面和纹理重复，但不声称 100% 还原。石岸仍是风格化砌石，原稿更自然的侵蚀雕刻和边缘微裂纹尚未完全达到；棕榈仍缺少扫描级叶脉与真实透射。光照是实时阴影、烘焙 AO 与近似背光的组合，未达到原稿的电影级全局照明。水面亮纹不是光线追踪焦散，瀑布不是流体模拟。远处宫殿仍是独立静态背景平面；原稿摄影构图与冻结的实际关卡轮廓存在差别。

完整帧计数（包含阴影/水反射重复渲染）从约 **307 draw calls / 67.6 万三角形**，增至约 **312 draw calls / 81.0 万三角形**。细叶与藤叶增加约 20% 三角形；三个压缩石岸 GLB 总体积反而下降。当前 16.7 ms 来自桌面 Chrome，不能代表实体手机。低端设备的质量档、热量、GPU 内存与 WebView 真机验证仍未完成。
