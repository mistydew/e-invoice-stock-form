# 网页增强识别 v5.1.1

## 运行方式

网页在独立 Worker 中运行 ONNX Runtime Web 1.23.2（WASM 单线程）和 OpenCV.js 4.11.0。单线程不依赖 GitHub Pages 无法配置的跨域隔离响应头。所有资源使用模块或 Worker 相对路径，支持 `/e-invoice-stock-form/` 子路径。

`browser-ocr.js` 负责 Worker 生命周期、请求和超时；`ocr-worker.js` 完成 BGR 输入、DB 检测轮廓、矩形扩张、透视裁剪、CTC 解码和字符墨迹定位；`rapid-ocr.js` 复用交接包的表格解析与分区域复核。文字行估算轻微倾斜角度后，先校正整张图片再分列。大幅旋转、透视畸变和模糊拍照仍需人工裁剪或旋转。

Mobile 模型约 22 MB，WASM 与 OpenCV 约 23 MB。名称与规格继续尝试使用 server 模型（约 85 MB）裁剪复核；同一 mobile 模型的两次高置信度读数仍可能一起漏字，因此不能仅按高置信度跳过跨模型复核。精细模型下载失败或超过 20 秒时回退到 mobile，并向用户提示。下载按字节报告进度，字段复核逐项报告进度；请求的无进展超时会随实际进度重置。

缓存只存 GET 静态资源，票据不写入缓存、服务端或日志。应用与模型缓存分开，升级时迁移已有模型资源；缓存写入在后台完成，不阻塞模型响应流。旧浏览器保留 Tesseract 兼容路径，不应将备用引擎与增强引擎的效果混为一谈。

## 多页与表头修复

v5.1 将 PDF 的文本提取和 OCR 回退都按页执行，不再给坐标加页码偏移后一次解析。`invoice-pages.js` 按相同票号及兼容的销售方、日期组合页数据，再校验整票总额；折扣在组合后处理，因此可以合并跨页折扣。不同票号保留各自身份信息。

字符墨迹定位保留红色表头。若检测漏掉单位等表头，使用相邻已确认表头之间的图像区域重新读取标签和字符坐标，确认后再定位该列，不根据商品内容猜单位。

## 导出校验定位

v5.1.1 将导出拦截原因显示为文件来源、来源内条目、表格行号及具体字段。无效数字标红，点击提示或导出按钮可直接定位；编辑时立即更新校验，保留非法输入原文供修正，并支持全角数字。折扣行允许数量和单价为空，金额和税额仍必须有效。

有待核对行时，汇总显示“已确认金额”及待核对数量，不把缺失金额显示成已完成总额。另修复密集 PDF 明细与页尾“小计、合计”被串成一个行簇，污染最后商品名称的问题。

## 模型与许可证

ONNX 模型来自用户提供的 v4.4 交接包，未转换或量化。识别字典从模型 `character` 元数据逐行提取，添加 CTC blank 和空格，共 18385 项。RapidOCR / PaddleOCR 许可证保留在 `lib/ocr/licenses/`；ONNX Runtime、OpenCV、PDF.js 许可证随对应静态目录保留。

- `ch_PP-OCRv5_det_mobile.onnx`: `4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae`
- `ch_PP-OCRv5_rec_mobile.onnx`: `5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5`
- `ch_PP-OCRv5_rec_server.onnx`: `e09385400eaaaef34ceff54aeb7c4f0f1fe014c27fa8b9905d4709b65746562a`

参考实现与运行时文档：

- https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/ch_ppocr_rec/utils.py
- https://github.com/PaddlePaddle/PaddleOCR/blob/main/ppocr/postprocess/db_postprocess.py
- https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html

## 发布和验证

`npm test` 执行解析、队列和 CTC 回归；`npm run build:web` 只把静态文件复制到 `dist-web/`。GitHub Actions 通过测试后发布此目录，开发文件、Python、本地服务和票据样本均不发布。

v5.0 使用虚构公司样本验证了图片、PDF、OFD、ZIP、队列、导出与离线流程。v5.1 另使用用户提供的一份两页真实 PDF 和三张不同的真实图片作本机验收，逐行核对 PDF 金额、税额、跨页折扣及 Excel 输出，并检查图片字段、下载失败回退和离线识别。真实样本、OCR 文本和导出文件不进入仓库或站点。

自动回归共 49 项，包含多页页序、跨页折扣、不同票号元数据、整票总额差异、模型下载中断、有进度时的超时行为、精细模型不可用时保留可靠初读，以及导出缺失字段定位和密集明细页尾边界。有限样本不代表所有版式的准确率；强透视、模糊及特殊符号仍需对照原票核验。
