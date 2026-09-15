from dataclasses import dataclass, field
from typing import Optional


@dataclass
class WindowInfo:
    process_name: str
    window_title: str
    timestamp: str


@dataclass
class OCRBlock:
    text: str
    bbox: tuple[int, int, int, int]  # x, y, width, height
    confidence: float


@dataclass
class CaptureRecord:
    id: Optional[int] = None
    timestamp: str = ""
    process_name: str = ""
    window_title: str = ""
    screenshot_path: str = ""
    change_score: float = 0.0
    ocr_status: str = "pending"


@dataclass
class OCRResult:
    id: Optional[int] = None
    capture_id: int = 0
    zone_map_text: str = ""
    raw_ocr_json: str = ""
    text_length: int = 0


@dataclass
class MomentSummary:
    id: Optional[int] = None
    time_start: str = ""
    time_end: str = ""
    summary: str = ""
    capture_ids: list[int] = field(default_factory=list)
    app_names: list[str] = field(default_factory=list)


@dataclass
class SessionSummary:
    id: Optional[int] = None
    time_start: str = ""
    time_end: str = ""
    summary: str = ""
    moment_ids: list[int] = field(default_factory=list)
    app_names: list[str] = field(default_factory=list)


@dataclass
class DailySummary:
    id: Optional[int] = None
    date: str = ""
    summary: str = ""
    app_usage_stats: dict = field(default_factory=dict)
    session_ids: list[int] = field(default_factory=list)


@dataclass
class CaptureDetail:
    """查询时使用的完整截图详情，包含 OCR 结果"""
    capture: CaptureRecord
    ocr: Optional[OCRResult] = None
