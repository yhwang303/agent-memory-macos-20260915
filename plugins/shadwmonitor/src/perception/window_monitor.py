import asyncio
import sys
from datetime import datetime

import psutil

if sys.platform == "win32":
    import win32gui
    import win32process
elif sys.platform == "darwin":
    from AppKit import NSWorkspace
    from Quartz import (
        CGWindowListCopyWindowInfo,
        kCGNullWindowID,
        kCGWindowLayer,
        kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionOnScreenOnly,
        kCGWindowName,
        kCGWindowOwnerPID,
    )

from src.storage.models import WindowInfo
from src.storage.database import Database
from src.utils.logger import log


class WindowMonitor:
    def __init__(self, poll_interval: float = 1.0, excluded_processes: list[str] = None,
                 excluded_titles: list[str] = None):
        self.poll_interval = poll_interval
        self.current_window: WindowInfo | None = None
        self.excluded_processes = [p.lower() for p in (excluded_processes or [])]
        self.excluded_titles = [t.lower() for t in (excluded_titles or [])]
        self._running = False

    def get_active_window(self) -> WindowInfo | None:
        try:
            if sys.platform == "darwin":
                return self._get_active_window_macos()
            if sys.platform != "win32":
                return None

            hwnd = win32gui.GetForegroundWindow()
            if not hwnd:
                return None

            window_title = win32gui.GetWindowText(hwnd)
            _, pid = win32process.GetWindowThreadProcessId(hwnd)

            try:
                process = psutil.Process(pid)
                process_name = process.name()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                process_name = "Unknown"

            return WindowInfo(
                process_name=process_name,
                window_title=window_title,
                timestamp=datetime.now().isoformat(timespec="seconds"),
            )
        except Exception as e:
            log.debug("获取前台窗口失败: %s", e)
            return None

    def _get_active_window_macos(self) -> WindowInfo | None:
        app = NSWorkspace.sharedWorkspace().frontmostApplication()
        if app is None:
            return None

        pid = app.processIdentifier()
        process_name = app.localizedName() or "Unknown"
        window_title = ""
        options = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
        windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) or []
        for window in windows:
            if window.get(kCGWindowOwnerPID) != pid:
                continue
            if window.get(kCGWindowLayer, 0) != 0:
                continue
            title = window.get(kCGWindowName)
            if title:
                window_title = str(title)
                break

        return WindowInfo(
            process_name=process_name,
            window_title=window_title,
            timestamp=datetime.now().isoformat(timespec="seconds"),
        )

    def is_excluded(self, window: WindowInfo) -> bool:
        if window.process_name.lower() in self.excluded_processes:
            return True
        title_lower = window.window_title.lower()
        return any(kw in title_lower for kw in self.excluded_titles)

    async def run(self, db: Database):
        self._running = True
        log.info("窗口监控已启动 (轮询间隔: %.1fs)", self.poll_interval)

        while self._running:
            try:
                window = self.get_active_window()
                if window and not self.is_excluded(window):
                    if (self.current_window is None or
                            window.process_name != self.current_window.process_name or
                            window.window_title != self.current_window.window_title):
                        await db.insert_window_event(
                            timestamp=window.timestamp,
                            process_name=window.process_name,
                            window_title=window.window_title,
                            event_type="switch",
                        )
                        log.debug("窗口切换: %s - %s", window.process_name, window.window_title)
                        self.current_window = window
            except Exception as e:
                log.error("窗口监控异常: %s", e)

            await asyncio.sleep(self.poll_interval)

    def stop(self):
        self._running = False
