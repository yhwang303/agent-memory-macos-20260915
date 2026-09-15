from difflib import SequenceMatcher

from src.storage.models import OCRBlock, WindowInfo


# 3x3 区域标签: (col_index, row_index) -> label
_ZONE_LABELS_3x3 = {
    (0, 0): "TL", (1, 0): "TC", (2, 0): "TR",
    (0, 1): "ML", (1, 1): "MC", (2, 1): "MR",
    (0, 2): "BL", (1, 2): "BC", (2, 2): "BR",
}


class ZoneMapper:
    def __init__(self, screen_width: int = 1920, screen_height: int = 1080,
                 cols: int = 3, rows: int = 3):
        self.screen_width = screen_width
        self.screen_height = screen_height
        self.cols = cols
        self.rows = rows
        self.zone_labels = _ZONE_LABELS_3x3 if (cols == 3 and rows == 3) else self._build_labels()

    def _build_labels(self) -> dict[tuple[int, int], str]:
        labels = {}
        for r in range(self.rows):
            for c in range(self.cols):
                labels[(c, r)] = f"R{r}C{c}"
        return labels

    def map_to_zone(self, bbox: tuple[int, int, int, int]) -> str:
        x, y, w, h = bbox
        cx = x + w / 2
        cy = y + h / 2

        col = min(int(cx / self.screen_width * self.cols), self.cols - 1)
        row = min(int(cy / self.screen_height * self.rows), self.rows - 1)

        return self.zone_labels.get((col, row), "MC")

    def generate_zone_map(self, ocr_blocks: list[OCRBlock],
                          window_info: WindowInfo | None,
                          timestamp: str) -> str:
        zone_texts: dict[str, list[str]] = {}

        for block in ocr_blocks:
            zone = self.map_to_zone(block.bbox)
            if zone not in zone_texts:
                zone_texts[zone] = []
            zone_texts[zone].append(block.text.strip())

        for zone in zone_texts:
            zone_texts[zone] = self._deduplicate(zone_texts[zone])

        proc = window_info.process_name if window_info else ""
        title = window_info.window_title if window_info else ""
        header = f"@{self.screen_width}x{self.screen_height} [{proc}: {title}] {timestamp}"

        zone_order = ["TL", "TC", "TR", "ML", "MC", "MR", "BL", "BC", "BR"]
        lines = [header]
        for zone_label in zone_order:
            if zone_label in zone_texts and zone_texts[zone_label]:
                content = " | ".join(zone_texts[zone_label])
                lines.append(f"[{zone_label}] {content}")

        return "\n".join(lines)

    def _deduplicate(self, texts: list[str], threshold: float = 0.85) -> list[str]:
        if len(texts) <= 1:
            return texts
        result = [texts[0]]
        for t in texts[1:]:
            if not t:
                continue
            ratio = SequenceMatcher(None, result[-1], t).ratio()
            if ratio < threshold:
                result.append(t)
        return result
