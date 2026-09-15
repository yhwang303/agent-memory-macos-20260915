import argparse
import asyncio
import os
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.config import load_config
from src.utils.logger import log


def _load_dotenv():
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.exists():
        return
    with open(env_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if key and key not in os.environ:
                os.environ[key] = value


_load_dotenv()


def get_config():
    config_path = str(Path(__file__).resolve().parent.parent / "config" / "settings.yaml")
    return load_config(config_path)


async def run_capture():
    """采集模式：启动屏幕监控 + OCR + 蒸馏"""
    from src.agent.distiller import Distiller
    from src.ocr.ocr_engine import OCREngine
    from src.ocr.processor import OCRProcessor
    from src.ocr.zone_mapper import ZoneMapper
    from src.perception.change_detector import ChangeDetector
    from src.perception.screen_capturer import ScreenCapturer
    from src.perception.window_monitor import WindowMonitor
    from src.storage.database import Database

    config = get_config()
    base_dir = config.base_dir

    db_path = str(Path(base_dir) / config.storage.db_path)
    screenshot_dir = str(Path(base_dir) / config.storage.screenshot_dir)

    db = Database(db_path)
    await db.init_tables()

    window_monitor = WindowMonitor(
        poll_interval=config.perception.window_poll_interval,
        excluded_processes=config.privacy.excluded_processes,
        excluded_titles=config.privacy.excluded_titles,
    )

    ocr_engine = OCREngine(
        language=config.ocr.language,
        confidence_threshold=config.ocr.confidence_threshold,
    )

    zone_mapper = ZoneMapper(
        cols=config.ocr.zone_grid[0],
        rows=config.ocr.zone_grid[1],
    )

    ocr_processor = OCRProcessor(
        engine=ocr_engine,
        mapper=zone_mapper,
        db=db,
        screenshot_dir=screenshot_dir,
        max_queue_size=config.ocr.max_queue_size,
        num_workers=config.ocr.workers,
    )

    monitor_indices = config.perception.monitor_indices or [1]
    capture_pairs: list[tuple[ScreenCapturer, ChangeDetector]] = []
    for idx in monitor_indices:
        cap = ScreenCapturer(
            screenshot_dir=screenshot_dir,
            quality=config.perception.screenshot_quality,
            monitor_index=idx,
        )
        det = ChangeDetector(
            threshold=config.perception.change_threshold,
            check_interval=config.perception.check_interval,
            force_interval=config.perception.force_capture_interval,
            downscale=tuple(config.perception.downscale_for_compare),
        )
        det.set_ocr_queue(ocr_processor.queue)
        capture_pairs.append((cap, det))

    distiller = Distiller(config=config.agent, db=db)

    detectors = [det for _, det in capture_pairs]
    components = [window_monitor, *detectors, ocr_processor, distiller]

    bridge_poster = None
    if config.agent_mem.enabled:
        from src.agent_mem_bridge import BridgePoster

        bridge_poster = BridgePoster(config.agent_mem, db_path)
        await bridge_poster.init()
        components.append(bridge_poster)
        log.info("agent_mem 桥接已启用: endpoint=%s", config.agent_mem.endpoint)

    def shutdown_handler():
        log.info("收到停止信号，正在关闭...")
        for comp in components:
            comp.stop()

    loop = asyncio.get_running_loop()
    try:
        loop.add_signal_handler(signal.SIGINT, shutdown_handler)
        loop.add_signal_handler(signal.SIGTERM, shutdown_handler)
    except NotImplementedError:
        pass

    log.info("=" * 50)
    log.info("AI Monitor 采集模式启动")
    log.info("截图目录: %s", screenshot_dir)
    log.info("数据库: %s", db_path)
    log.info("监控显示器: %s | 变化阈值: %.3f | 检测间隔: %.1fs",
             monitor_indices, config.perception.change_threshold, config.perception.check_interval)
    log.info("=" * 50)

    try:
        coros = [
            window_monitor.run(db),
            *[det.run(cap, window_monitor, db) for cap, det in capture_pairs],
            ocr_processor.run(),
            distiller.schedule(),
        ]
        if bridge_poster is not None:
            coros.append(bridge_poster.run())
        await asyncio.gather(*coros)
    except KeyboardInterrupt:
        shutdown_handler()
    except Exception as e:
        log.error("采集程序异常退出: %s", e)
        raise
    finally:
        log.info("AI Monitor 采集已停止")


def run_web(host: str = "127.0.0.1", port: int = 8080):
    """Web 模式：启动查看和查询界面"""
    import uvicorn
    from src.web.app import create_app

    config_path = str(Path(__file__).resolve().parent.parent / "config" / "settings.yaml")
    config = get_config()
    app = create_app(config, config_path=config_path)

    log.info("=" * 50)
    log.info("AI Monitor Web 界面启动")
    log.info("访问地址: http://%s:%d", host, port)
    log.info("API 文档: http://%s:%d/docs", host, port)
    log.info("=" * 50)

    uvicorn.run(app, host=host, port=port, log_level="info")


def main():
    parser = argparse.ArgumentParser(description="AI Monitor - 屏幕活动感知系统")
    subparsers = parser.add_subparsers(dest="command", help="运行模式")

    subparsers.add_parser("capture", help="启动屏幕采集 (监控 + OCR + 蒸馏)")

    web_parser = subparsers.add_parser("web", help="启动 Web 查看界面")
    web_parser.add_argument("--host", default="127.0.0.1", help="监听地址 (默认 127.0.0.1)")
    web_parser.add_argument("--port", type=int, default=8080, help="监听端口 (默认 8080)")

    args = parser.parse_args()

    if args.command == "capture":
        try:
            asyncio.run(run_capture())
        except KeyboardInterrupt:
            pass
    elif args.command == "web":
        run_web(host=args.host, port=args.port)
    else:
        parser.print_help()
        print("\n用法示例:")
        print("  python src/main.py capture    # 启动屏幕采集")
        print("  python src/main.py web        # 启动 Web 查看界面")
        print("  python src/main.py web --port 9090  # 指定端口")


if __name__ == "__main__":
    main()
