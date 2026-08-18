# Exam Paper Image Processing Tool

面向教师和学生的试卷图片整理工具。图片处理、24 小时任务恢复和 PDF 生成均在浏览器本地完成，不需要账号、业务后端或图片上传。

## 当前能力

- 一次导入最多 20 张 JPG、PNG、WebP、HEIC 或 HEIF 图片，单张最大 20 MB、4000 万像素。
- PaddleOCR 文档四方向模型在浏览器本地识别；置信度或方向合理性不足时保留当前方向并提示手动旋转。
- 保守纸张边界检测、透视校正和可拖动四角的人工校正。
- 局部光照归一化、灰度转换，以及逐页或批量“柔和 / 清晰 / 高对比”文字增强，保留公式、表格线和插图细节。
- 方向或纸张边界不可靠的页面在缩略图中持续标记；确认状态会保存，并在导出前再次汇总提醒。
- 桌面与手机编辑器：移动、缩放、白色擦除、恢复、撤销和重做。
- 页面排序、删除、取消、失败重试，以及统一 A4 竖版灰度 PDF 导出。
- IndexedDB 临时恢复；任务超过 24 小时后过期，也可主动清空。

自动手写识别和自动擦除不属于当前生产功能。授权手写样张和离线研究工具仍保留在仓库中，但不会进入应用运行时或生产构建。

## 本地开发

前置条件：Node.js 24+、npm 11+。

```bash
npm install
npm run dev
```

生产构建和质量检查：

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e
npm run verify:models
npm run eval:samples
```

首次运行 E2E 前安装 Chromium 和 WebKit：

```bash
npx playwright install chromium webkit
```

## 架构

- `src/App.tsx`：批量任务、页面工具、任务队列和导出工作流。
- `src/components/EditorCanvas.tsx`：跨端缩放、平移、擦除和恢复画布。
- `src/lib/image-processing.ts`：解码、边界检测、双线性透视、方向和灰度增强。
- `src/lib/model-runtime.ts`：同源方向模型校验与 WebGPU/WASM 回退。
- `src/workers/image-processing.worker.ts`：页面处理、进度、取消、结果和错误消息。
- `src/lib/storage.ts`：v4 逐页/任务默认增强档位、页面确认状态，以及 v2/v3 任务迁移。
- `src/lib/pdf.ts`：A4 竖版灰度 PDF。

处理顺序为“解码 → 方向判断 → 边界与透视 → 灰度增强 → 手动补修 → PDF”。

## Linux 静态部署

应用没有服务端业务逻辑。Linux 服务器只需构建并托管 `dist/`，同时正确提供 JavaScript、WASM 和 ONNX MIME 类型并启用 HTTPS。Nginx 示例见 [Linux 部署说明](docs/deployment/linux-nginx.md)。

## 隐私与许可

- 用户图片不会上传，也不会进入远程日志。
- 源图和处理结果仅保存在当前浏览器的 IndexedDB 中。
- HEIC/HEIF 仅在浏览器不能原生解码时，按需加载 `heic-to` 本地解码器。
- 第三方许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 仅应处理和分发已获授权的试卷材料。

完整范围与验收标准见 [MVP 需求](docs/requirements/worksheet-digitization-mvp.md)，当前验证结果见 [验证报告](docs/engineering/VERIFICATION.md)。

## 已知限制

- 不提供 OCR、可搜索 PDF、Word 导出、账号、云同步或自动手写擦除。
- 方向模型低置信度或不符合纵向纸张合理性的页面需要用户确认；模糊、遮挡或缺角页面可能需要手动调整四角。
- 文字增强可改善阴影、轻度虚焦和低对比，但不能恢复严重失焦或运动模糊中已经丢失的信息。
- “应用到全部”会串行更新当前任务中的已完成页面，并把所选档位作为之后新增页面的默认值；仍可再单独调整任一页面。
- iOS Safari 与 Android Chrome 的 HEIC、20 页内存和实体打印质量仍应在目标设备持续抽测。
