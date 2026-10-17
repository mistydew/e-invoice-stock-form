# 网页增强识别 v5.0

## 运行方式

网页在独立 Worker 中运行 ONNX Runtime Web 1.23.2（WASM 单线程）和 OpenCV.js 4.11.0。单线程不依赖 GitHub Pages 无法配置的跨域隔离响应头。所有资源使用模块或 Worker 相对路径，支持 `/e-invoice-stock-form/` 子路径。

`browser-ocr.js` 负责 Worker 生命周期、请求和超时；`ocr-worker.js` 完成 BGR 输入、DB 检测轮廓、矩形扩张、透视裁剪、CTC 解码和字符墨迹定位；`rapid-ocr.js` 复用交接包的表格解析与分区域复核。文字行估算轻微倾斜角度后，先校正整张图片再分列。大幅旋转、透视畸变和模糊拍照仍需人工裁剪或旋转。

Mobile 模型约 22 MB；商品与规格使用 server 模型复核（约 85 MB，首次按需加载）。WASM 与 OpenCV 约 23 MB。缓存只存 GET 静态资源，票据不写入缓存、服务端或日志。旧浏览器保留 Tesseract 兼容路径，不应将备用引擎与增强引擎的效果混为一谈。

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

本次人工构造两家虚构公司样本，在 Edge 中验证了 PNG、JPG、缩小截图、轻微倾斜截图、扫描 PDF、文本 PDF、文本 OFD、ZIP、折扣保留/合并、队列和 Excel 读回，并验证缓存后的离线重开与识别。36 项回归测试通过。没有真实票据样本，不能据此给出真实发票准确率。部分压缩/倾斜图中的希腊规格符号仍可能漏读，会提示复核；不能按金额或商品名称猜测补字。
