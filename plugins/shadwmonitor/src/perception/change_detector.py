import asyncio
from datetime import datetime

import cv2
import numpy as np

from src.perception.screen_capturer import ScreenCapturer
from src.perception.window_monitor import WindowMonitor
from src.storage.database import Database
from src.storage.models import CaptureRecord
from src.utils.logger import log


class ChangeDetector:
    def __init__(self, threshold: float = 0.02, check_interval: float = 2.0,
                 force_interval: float = 60.0,
                 downscale: tuple[int, int] = (480, 270)):
        self.threshold = threshold
        self.check_interval = check_interval
        self.downscale = downscale
        self.last_frame: np.ndarray | None = None
        self._running = False
        self._ocr_queue: asyncio.Queue | None = None

    def set_ocr_queue(self, queue: asyncio.Queue):
        self._ocr_queue = queue

    def _to_small_gray(self, frame: np.ndarray) -> np.ndarray:
        small = cv2.resize(frame, self.downscale, interpolation=cv2.INTER_AREA)
        return cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    def compute_change_score(self, frame1: np.ndarray, frame2: np.ndarray) -> float:
        g1 = self._to_small_gray(frame1)
        g2 = self._to_small_gray(frame2)
        diff = cv2.absdiff(g1, g2)
        return float(diff.mean() / 255.0)

    def should_capture(self, current_frame: np.ndarray) -> tuple[bool, float]:
        if self.last_frame is None:
            self.last_frame = current_frame
            return True, 1.0

        score = self.compute_change_score(self.last_frame, current_frame)

        if score >= self.threshold:
            self.last_frame = current_frame
            return True, score

        return False, score

    async def run(self, capturer: ScreenCapturer, window_monitor: WindowMonitor,
                  db: Database):
        self._running = True
        log.info("屏幕变化检测已启动 (间隔: %.1fs, 阈值: %.3f)", self.check_interval, self.threshold)

        while self._running:
            try:
                frame = capturer.capture()
                do_capture, score = self.should_capture(frame)

                if do_capture:
                    ts = datetime.now()
                    rel_path = capturer.save(frame, ts)

                    window = window_monitor.current_window
                    process_name = window.process_name if window else ""
                    window_title = window.window_title if window else ""

                    if window and window_monitor.is_excluded(window):
                        log.debug("跳过排除窗口截图: %s", process_name)
                    else:
                        record = CaptureRecord(
                            timestamp=ts.isoformat(timespec="seconds"),
                            process_name=process_name,
                            window_title=window_title,
                            screenshot_path=rel_path,
                            change_score=score,
                            ocr_status="pending",
                        )
                        capture_id = await db.insert_capture(record)
                        log.debug("截图入库: id=%d, score=%.4f, app=%s", capture_id, score, process_name)

                        if self._ocr_queue:
                            try:
                                self._ocr_queue.put_nowait({
                                    "capture_id": capture_id,
                                    "screenshot_path": rel_path,
                                    "process_name": process_name,
                                    "window_title": window_title,
                                    "timestamp": ts.isoformat(timespec="seconds"),
                                })
                            except asyncio.QueueFull:
                                log.warning("OCR 队列已满，跳过入队: capture_id=%d", capture_id)

            except Exception as e:
                log.error("变化检测异常: %s", e)

            await asyncio.sleep(self.check_interval)

    def stop(self):
        self._running = False
