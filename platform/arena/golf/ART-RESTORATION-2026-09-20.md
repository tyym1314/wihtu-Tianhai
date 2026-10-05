> 本页记录第一轮交付。后续石岸/植物/水面/照明及最新性能数字见 [第二轮实际交付](ART-LIGHTING-V2-2026-09-20.md)。

# Oasis Golf · 2026-09-20 实际美术交付

本轮只改显示层、独立资产和本地验证。三个球场的权威几何、碰撞、杆数、超时、钱包和共享平台代码未改。画面是实时 Three.js 场景，既有引擎轨迹仍决定球的位置与入洞结果。

## 对原稿的实际改进

以 `output/design/pvp-arena-concepts-v1/03-golf.png` 为参照，保留绿松石水面、金砂岩高岛、立体绿色球道、棕榈花草和金色控件。实际运行项目内 Blender 4.5.14 LTS，生成三套曲线石岛、独立可编辑砌石、石拱桥/嵌饰和植物库，并导出压缩 GLB。花园外岸使用不规则轮廓；球道内侧碰撞线保持原位，新增石沿厚度只向外扩展。

近景不再只依赖纯色：原创细草与砂岩 albedo、数值法线、三洞实际 Cycles 接触 AO、暖日光/蓝天阴影、双层十八叶棕榈、蕨叶、白花与粉花。Water 反射真实场景，水面扰动、透明岸泡沫、瀑布、叶片、旗帜持续运动。远处宫殿图片仅放在所有球场之后的世界平面，水岸透明过渡，不覆盖球台或操作目标。

动态粒子显式避免使用初始原点包围球裁剪，修复杯边特写中粒子被误剔除。真实入洞才启动 2.6 秒杯边镜头、螺旋金色微粒和贴地光迹；普通球沿权威轨迹滚动，其他玩家仍是无碰撞幽灵球。共享结果外壳由 root 管理，已约定最终合法事件后的 2800 ms 展示尾段。

## 文件与出处

- `scene.mjs`：实时环境、原碰撞网格对应的显示面、摄影机和入洞效果。
- `art.mjs`：GLB/Draco 加载、材质映射、接触 AO、缓存及释放。
- `golf.css`：入洞视觉层级；真实 HUD / 力度 / 金色按钮保持。
- `assets/source/build_oasis.py`、`render_result.py`、`optimize-textures.mjs`：实际执行的建模、渲染/烘焙、压缩脚本；目录保留执行日志和可编辑 `.blend`。
- `assets/models/`：三洞石岛和共享植物压缩模型；`assets/textures/`：原始 PNG 与运行时 WebP。
- [完整原创图片 prompt / 来源](assets/PROVENANCE.md)，[尺寸与 SHA256](assets/manifest.json)。共享远景复制自 root 的 Run 原创 atlas，其原始 prompt 在共享资产记录中。

## 验证与可直接查看的证据

- `node --test tests/golf-engine.test.mjs tests/bowling-engine.test.mjs`：33 / 33，Golf 14、Bowling 19。没有为通过检查而修改引擎。
- `node tests/golf-bowling-art-ui.mjs`：四种移动视口场景，Golf 390×844 两人 / 360×800 四人，实际点力度条并击球，一杆入洞，忙期间按钮禁用，杯边镜头与 win 音效钩子被触发；另外检查三洞几何展示。无页面或资源错误，也没有 `/api`、`/v1` 请求。第三洞截图是明示的本地视觉 fixture，不冒充逐洞完成录像。
- `node tests/golf-bowling-art-build.mjs`：独立 Vite production bundle，真实 Chrome 加载散列后的 GLB/WebP/Draco URL，未触发 fallback；测得桌面 frame median 16.7 ms / p95 16.7–16.8 ms（多次复核范围）。这是当前桌面机器证据，不是真机性能结论。
- [390 主画面](assets/review/golf-390-blender.png)、[360 主画面](assets/review/golf-360-blender.png)、[实际入洞特写](assets/review/golf-390-hole.png)、[第二洞](assets/review/golf-390-hole-2.png)、[第三洞](assets/review/golf-390-hole-3.png)。
- [真实击球到入洞录像](assets/review/golf-motion.webm)，[动作/声音钩子/引擎结果](assets/review/motion-evidence.json)，[UI 报告](assets/review/art-ui-report.json)，[构建报告](assets/review/build-report.json)。录像本身无声，不能用来证明扬声器音频验收。

复核专用入口是 `art-review.html` / `art-review.jsx` / `art-review.config.mjs`。在 `platform/` 运行 `node node_modules/vite/bin/vite.js --config arena/golf/art-review.config.mjs`，本地 18122、独立 Vite cache，不连钱包。结束后关闭专用服务。

## 原稿差距与边界

本版本是经过实际建模与交互验证的美术升级，仍不能称逐像素还原。原稿的电影级光照、自然岩层雕刻和细腻叶片透光尚未完全达到；权威球场形状被冻结，因此与概念图构图有差异。远景为静态美术平面，近景为真实 3D。岸泡沫/瀑布为动画着色器，不是流体模拟。

当前完整渲染统计约 300 draw calls / 67 万三角形（包含阴影与反射重复渲染），已经压缩模型与纹理，但还需 Android / iOS WebView 的 GPU、温度、弱网和内存实测再确定质量档。未声称外部合作方、真实钱包、实体手机或生产验收完成。
