import asyncio
import json
from pathlib import Path

from src.ocr.ocr_engine import OCREngine
from src.ocr.zone_mapper import ZoneMapper
from src.storage.database import Database
from src.storage.models import OCRResult, WindowInfo
from src.utils.logger import log


class OCRProcessor:
    def __init__(self, engine: OCREngine, mapper: ZoneMapper,
                 db: Database, screenshot_dir: str,
                 max_queue_size: int = 100, num_workers: int = 2):
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=max_queue_size)
        self.engine = engine
        self.num_workers = num_workers
        self.mapper = mapper
        self.db = db
        self.screenshot_dir = screenshot_dir
        self._running = False

    async def enqueue(self, task: dict):
        try:
            self.queue.put_nowait(task)
        except asyncio.QueueFull:
            log.warning("OCR 队列已满，丢弃最旧任务")
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            await self.queue.put(task)

    async def _worker(self, worker_id: int, engine: OCREngine):
        log.info("OCR worker-%d 已启动", worker_id)
        while self._running:
            try:
                task = await asyncio.wait_for(self.queue.get(), timeout=2.0)
            except asyncio.TimeoutError:
                continue
            except Exception:
                continue

            capture_id = task["capture_id"]
            rel_path = task["screenshot_path"]
            full_path = str(Path(self.screenshot_dir) / rel_path)

            try:
                await self.db.update_ocr_status(capture_id, "processing")

                blocks = await asyncio.get_event_loop().run_in_executor(
                    None, engine.recognize, full_path
                )

                if not blocks:
                    await self.db.update_ocr_status(capture_id, "done")
                    log.debug("OCR worker-%d 无文本: capture_id=%d", worker_id, capture_id)
                    continue

                window_info = WindowInfo(
                    process_name=task.get("process_name", ""),
                    window_title=task.get("window_title", ""),
                    timestamp=task.get("timestamp", ""),
                )
                zone_map_text = self.mapper.generate_zone_map(
                    blocks, window_info, task["timestamp"]
                )

                raw_json = json.dumps(
                    [{"text": b.text, "bbox": list(b.bbox), "conf": round(b.confidence, 3)}
                     for b in blocks],
                    ensure_ascii=False,
                )

                ocr_result = OCRResult(
                    capture_id=capture_id,
                    zone_map_text=zone_map_text,
                    raw_ocr_json=raw_json,
                    text_length=len(zone_map_text),
                )
                await self.db.insert_ocr_result(ocr_result)
                await self.db.update_ocr_status(capture_id, "done")

                log.debug("OCR worker-%d 完成: capture_id=%d, zones=%d chars",
                          worker_id, capture_id, len(zone_map_text))

            except Exception as e:
                log.error("OCR 处理失败: capture_id=%d, %s", capture_id, e)
                await self.db.update_ocr_status(capture_id, "failed")

    async def run(self):
        self._running = True
        log.info("OCR 处理器已启动 (workers=%d)", self.num_workers)

        # 每个 worker 独占一个引擎实例，避免多线程共享同一 ONNX session 的竞争问题
        engines = [self.engine] + [
            OCREngine(
                language=self.engine.language,
                confidence_threshold=self.engine.confidence_threshold,
            )
            for _ in range(self.num_workers - 1)
        ]

        await asyncio.gather(*[
            self._worker(i, engines[i]) for i in range(self.num_workers)
        ])

    def stop(self):
        self._running = False
