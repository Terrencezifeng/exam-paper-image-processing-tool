# 试卷整理与手动擦除验证报告

## 当前范围

- 生产流程只包含本地方向识别、保守裁边、透视校正、灰度增强、手动擦除/恢复和 A4 PDF 导出。
- 自动手写识别、自动擦除、待复核遮罩及外部 OCR API 均不参与应用运行和生产构建。
- 图片、手工笔画、恢复数据和 PDF 全部留在浏览器；Linux 服务器只提供 HTTPS 静态资源。

## 自动验证

| 状态 | 命令或检查 | 范围 |
| --- | --- | --- |
| 通过 | `npm run lint` | React、TypeScript、Worker、测试与配置 |
| 通过 | `npm run typecheck` | 应用、Worker、评测配置和 E2E 类型 |
| 通过 | `npm test` | 21 项：解码、几何、三档增强、v2/v3→v4 存储迁移、PDF、模型回退和 Worker 协议 |
| 通过 | `npm run build` | 生产构建、Worker、方向模型和 HEIC 按需分包 |
| 通过 | `npm run e2e` | 19 项通过、2 项按设计跳过：桌面 Chromium、Android Chromium、iPhone WebKit 工作流 |
| 通过 | `npm run eval:samples` | 23 项：4 组授权样张、32 张方向变体、边界和三档增强指标 |
| 通过 | `npm run verify:models` | 生产模型仅包含 6.47 MB PaddleOCR 方向模型，哈希、大小、预处理和阈值均匹配清单 |
| 通过 | `npm audit --audit-level=moderate --registry=https://registry.npmjs.org` | 0 个已知漏洞 |

## 样张结论

- 4 组 clean/written 共 32 个旋转变体中，29 个自动转正（90.625%），自动误转为 0；其余安全回退人工确认。
- 方向模型的最高置信度门槛为 0.70、前两类差值门槛为 0.15；不符合纵向纸张合理性的结果也会回退。
- 4 张 clean 页以平均四角误差不超过 0.04 的结果完成可信裁边。
- sample-01、sample-02 written 页可可信裁边；sample-03、sample-04 written 页会拒绝可疑轮廓、保留整图并提示手动调角，未丢失答案区。
- 四张 clean 页的 `clear` 和 `highContrast` 均达到相对 `soft` 至少 10% 和 20% 的文字对比提升；亮背景均匀度未降低，细线保留率至少 99.5%。
- 增强图与导出基线均为灰度；切换档位锁定方向与四角，并保留擦除、恢复、撤销和重做记录。
- 批量增强在桌面、Pixel 和 iPhone/WebKit 视口串行执行；新增页面继承最近一次任务级档位，单页仍可覆盖。
- 低置信度方向/边界页在缩略图显示待确认标记；显式确认会持久化，未确认页面在导出对话框按页码和原因汇总。
- 真实样张已在桌面 Chromium、Android Chromium 和 iPhone WebKit 视口完成非空画布与响应式截图检查，无横向溢出或工具栏遮挡。

## 兼容与恢复

- 浏览器支持的 JPG、PNG、WebP 及 HEIC/HEIF 优先原生解码；原生失败且确认是 HEIC/HEIF 时才按需加载 `heic-to/csp`。
- WebKit 不支持 Worker `OffscreenCanvas` 时回退主线程串行处理；IndexedDB 不接受 Blob 时改存 ArrayBuffer，并在恢复时还原 Blob。
- v2 任务只迁移擦除前 `enhanced` 图，忽略旧自动遮罩；v2/v3 迁移为 `soft`；v4 保存逐页档位、任务默认档位、页面确认状态、页面顺序、增强基线和手工笔画。
- 20 页 E2E 使用微型合成 PNG 验证队列、排序、恢复和 PDF 页数，不代表 12 MP 性能结论。
- Windows 无 GPU 的无头 Chromium 会记录 WebGPU 初始化失败并自动使用 WASM，这是预期回退路径。

## 实机待验

- 仓库暂缺可再分发的真实 HEIC/HEIF 样张；自动测试已覆盖原生优先和本地回退分流，真实文件解码及连续多图内存曲线仍需设备验收。
- 12 MP 首张缩略图 3 秒、20 张高分辨率图片的手机内存峰值、实体 A4 打印和 Safari 下载行为需在目标手机上复测。
