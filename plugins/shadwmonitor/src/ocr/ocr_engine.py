from pathlib import Path

import cv2
from rapidocr_onnxruntime import RapidOCR

from src.storage.models import OCRBlock
from src.utils.logger import log

# OCR 前将图片缩放至此宽度，减少推理耗时
_OCR_MAX_WIDTH = 1280


class OCREngine:
    def __init__(self, language: str = "ch", confidence_threshold: float = 0.6):
        self.language = language
        self.confidence_threshold = confidence_threshold
        self._engine: RapidOCR | None = None

    def _ensure_engine(self):
        if self._engine is None:
            log.info("初始化 RapidOCR 引擎...")
            # use_angle_cls=False：屏幕文字基本水平，跳过方向分类模型，速度提升约 30%
            self._engine = RapidOCR(use_angle_cls=False)
            log.info("RapidOCR 引擎初始化完成")

    def recognize(self, image_path: str) -> list[OCRBlock]:
        self._ensure_engine()

        if not Path(image_path).exists():
            log.warning("OCR 图片不存在: %s", image_path)
            return []

        img = cv2.imread(image_path)
        if img is None:
            log.warning("OCR 图片读取失败: %s", image_path)
            return []

        # 超过最大宽度则等比缩放，大幅降低推理耗时
        h, w = img.shape[:2]
        if w > _OCR_MAX_WIDTH:
            scale = _OCR_MAX_WIDTH / w
            img = cv2.resize(img, (_OCR_MAX_WIDTH, int(h * scale)), interpolation=cv2.INTER_AREA)

        try:
            result, _ = self._engine(img)
        except Exception as e:
            log.error("OCR 识别失败: %s - %s", image_path, e)
            return []

        blocks: list[OCRBlock] = []
        if not result:
            return blocks

        for line in result:
            box_points = line[0]  # [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
            text = str(line[1])
            try:
                confidence = float(line[2])
            except (TypeError, ValueError):
                confidence = 0.0

            if confidence < self.confidence_threshold:
                continue

            xs = [p[0] for p in box_points]
            ys = [p[1] for p in box_points]
            x = int(min(xs))
            y = int(min(ys))
            w = int(max(xs) - x)
            h = int(max(ys) - y)

            blocks.append(OCRBlock(text=text, bbox=(x, y, w, h), confidence=confidence))

        return blocks
