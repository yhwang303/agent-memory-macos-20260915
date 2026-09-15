from datetime import datetime
from pathlib import Path

import cv2
import mss
import numpy as np

from src.utils.logger import log


class ScreenCapturer:
    """
    monitor_index 含义（mss 约定）:
      0 = 所有显示器拼接的虚拟桌面
      1 = 主显示器（默认）
      2, 3, … = 第二、第三块屏幕
    """

    def __init__(self, screenshot_dir: str = "data/screenshots", quality: int = 80,
                 monitor_index: int = 1):
        self.screenshot_dir = screenshot_dir
        self.quality = quality
        self._sct = mss.mss()
        total = len(self._sct.monitors) - 1  # monitors[0] 是虚拟桌面
        if monitor_index < 0 or monitor_index > total:
            log.warning("monitor_index=%d 超出范围 (共 %d 块屏幕)，回退到主显示器", monitor_index, total)
            monitor_index = 1
        self.monitor_index = monitor_index
        mon = self._sct.monitors[self.monitor_index]
        log.info("截图目标: monitors[%d]  (%dx%d @ +%d,+%d)  |  共检测到 %d 块显示器",
                 self.monitor_index, mon["width"], mon["height"], mon["left"], mon["top"], total)

    def capture(self) -> np.ndarray:
        monitor = self._sct.monitors[self.monitor_index]
        raw = self._sct.grab(monitor)
        img = np.array(raw)
        return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

    def save(self, image: np.ndarray, timestamp: datetime | None = None) -> str:
        ts = timestamp or datetime.now()
        date_str = ts.strftime("%Y-%m-%d")
        time_str = ts.strftime("%H-%M-%S-%f")[:-3]

        mon_dir = Path(self.screenshot_dir) / date_str / f"m{self.monitor_index}"
        mon_dir.mkdir(parents=True, exist_ok=True)

        filename = f"{time_str}.jpg"
        filepath = mon_dir / filename
        cv2.imwrite(str(filepath), image, [cv2.IMWRITE_JPEG_QUALITY, self.quality])

        rel_path = f"{date_str}/m{self.monitor_index}/{filename}"
        log.debug("截图已保存: %s", rel_path)
        return rel_path
