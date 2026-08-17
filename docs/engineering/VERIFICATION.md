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
| 通过 | `npm test` | 解码分流、几何、存储 v2→v3、PDF 和 Worker 协议 |
| 通过 | `npm run build` | 生产构建、Worker、方向模型和 HEIC 按需分包 |
| 通过 | `npm run e2e` | 桌面 Chromium、Android Chromium、iPhone WebKit 工作流 |
| 通过 | `npm run eval:samples` | 4 组授权 clean/written 样张及旋转变体 |
| 通过 | `npm run verify:models` | 生产模型仅包含约 0.04 MB 的方向模型 |
| 通过 | `npm audit --audit-level=moderate --registry=https://registry.npmjs.org` | 0 个已知漏洞 |

## 样张结论

- 4 张 clean 页均能转正并以平均四角误差不超过 0.04 的结果完成可信裁边。
- sample-01、sample-02 written 页可可信裁边；sample-03、sample-04 written 页会拒绝可疑轮廓、保留整图并提示手动调角，未丢失答案区。
- 增强图与导出基线均为灰度；印刷保护区域在未手动编辑时保持不变。
- 真实样张已在桌面 Chromium、Android Chromium 和 iPhone WebKit 视口完成非空画布与响应式截图检查，无横向溢出或工具栏遮挡。

## 兼容与恢复

- 浏览器支持的 JPG、PNG、WebP 及 HEIC/HEIF 优先原生解码；原生失败且确认是 HEIC/HEIF 时才按需加载 `heic-to/csp`。
- WebKit 不支持 Worker `OffscreenCanvas` 时回退主线程串行处理；IndexedDB 不接受 Blob 时改存 ArrayBuffer，并在恢复时还原 Blob。
- v2 任务只迁移擦除前 `enhanced` 图，忽略旧自动遮罩；v3 保存页面顺序、增强基线和手工笔画。
- 20 页 E2E 使用微型合成 PNG 验证队列、排序、恢复和 PDF 页数，不代表 12 MP 性能结论。

## 实机待验

- 仓库暂缺可再分发的真实 HEIC/HEIF 样张；自动测试已覆盖原生优先和本地回退分流，真实文件解码及连续多图内存曲线仍需设备验收。
- 12 MP 首张缩略图 3 秒、20 张高分辨率图片的手机内存峰值、实体 A4 打印和 Safari 下载行为需在目标手机上复测。
