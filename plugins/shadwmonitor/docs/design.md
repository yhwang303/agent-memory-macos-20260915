# AI Monitor - 系统设计文档

## 1. 项目结构

```
ai_monitor/
├── docs/
│   ├── requirements.md          # 需求分析文档
│   └── design.md                # 本设计文档
├── config/
│   └── settings.yaml            # 全局配置
├── src/
│   ├── __init__.py
│   ├── main.py                  # 程序入口，启动各层服务
│   ├── config.py                # 配置加载
│   │
│   ├── perception/              # 系统感知层
│   │   ├── __init__.py
│   │   ├── window_monitor.py    # 前台窗口监控
│   │   ├── screen_capturer.py   # 截图采集
│   │   └── change_detector.py   # OpenCV 屏幕变化检测
│   │
│   ├── ocr/                     # OCR 感知层
│   │   ├── __init__.py
│   │   ├── ocr_engine.py        # OCR 引擎封装
│   │   └── zone_mapper.py       # 空间结构化文本生成
│   │
│   ├── agent/                   # Agent 感知层
│   │   ├── __init__.py
│   │   ├── distiller.py         # L1/L2/L3 蒸馏引擎
│   │   ├── prompts.py           # LLM Prompt 模板
│   │   └── query.py             # 渐进式披露查询接口
│   │
│   ├── storage/                 # 数据存储层
│   │   ├── __init__.py
│   │   ├── database.py          # SQLite 数据库操作
│   │   └── models.py            # 数据模型定义
│   │
│   └── utils/                   # 公共工具
│       ├── __init__.py
│       └── logger.py            # 日志工具
│
├── data/                        # 运行时数据（gitignore）
│   ├── screenshots/             # 截图存储，按日期子目录
│   │   └── 2026-04-14/
│   └── ai_monitor.db            # SQLite 数据库
│
├── requirements.txt
└── .gitignore
```

## 2. 数据库设计

### 2.1 ER 关系图

```
captures (截图记录)
  1 ──── 1  ocr_results (OCR结果)
  N ──── 1  moment_summaries (L1时刻描述)
  
moment_summaries
  N ──── 1  session_summaries (L2时段摘要)
  
session_summaries
  N ──── 1  daily_summaries (L3日摘要)

window_events (窗口切换事件) - 独立表
```

### 2.2 表结构

#### captures - 截图记录表
```sql
CREATE TABLE captures (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,              -- ISO 8601 格式时间戳
    process_name    TEXT,                       -- 进程名 如 WeChat.exe
    window_title    TEXT,                       -- 窗口标题
    screenshot_path TEXT NOT NULL,              -- 截图文件相对路径
    change_score    REAL,                       -- 变化度评分 0.0~1.0
    ocr_status      TEXT DEFAULT 'pending',     -- pending/processing/done/failed
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX idx_captures_timestamp ON captures(timestamp);
CREATE INDEX idx_captures_ocr_status ON captures(ocr_status);
```

#### ocr_results - OCR 结果表
```sql
CREATE TABLE ocr_results (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id      INTEGER NOT NULL REFERENCES captures(id),
    zone_map_text   TEXT NOT NULL,              -- 空间结构化文本（Zone-Map格式）
    raw_ocr_json    TEXT,                       -- 原始OCR数据（含bbox），JSON格式
    text_length     INTEGER,                    -- Zone-Map 文本字符数（用于统计）
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX idx_ocr_capture ON ocr_results(capture_id);
```

#### moment_summaries - L1 时刻描述表
```sql
CREATE TABLE moment_summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    time_start      TEXT NOT NULL,              -- 时间窗口开始
    time_end        TEXT NOT NULL,              -- 时间窗口结束
    summary         TEXT NOT NULL,              -- 1-2句话描述
    capture_ids     TEXT NOT NULL,              -- 关联的capture ID列表，JSON数组
    app_names       TEXT,                       -- 涉及的应用名称，JSON数组
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX idx_moment_time ON moment_summaries(time_start, time_end);
```

#### session_summaries - L2 时段摘要表
```sql
CREATE TABLE session_summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    time_start      TEXT NOT NULL,
    time_end        TEXT NOT NULL,
    summary         TEXT NOT NULL,              -- 时段摘要
    moment_ids      TEXT NOT NULL,              -- 关联的moment ID列表，JSON数组
    app_names       TEXT,                       -- 涉及的应用名称
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX idx_session_time ON session_summaries(time_start, time_end);
```

#### daily_summaries - L3 日摘要表
```sql
CREATE TABLE daily_summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    date            TEXT NOT NULL UNIQUE,       -- 日期 YYYY-MM-DD
    summary         TEXT NOT NULL,              -- 日报式摘要
    app_usage_stats TEXT,                       -- 应用使用统计，JSON
    session_ids     TEXT NOT NULL,              -- 关联的session ID列表
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX idx_daily_date ON daily_summaries(date);
```

#### window_events - 窗口切换事件表
```sql
CREATE TABLE window_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,
    process_name    TEXT,
    window_title    TEXT,
    event_type      TEXT NOT NULL,              -- 'switch' | 'focus' | 'close'
    created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX idx_window_timestamp ON window_events(timestamp);
```

## 3. 核心模块设计

### 3.1 系统感知层

#### 3.1.1 WindowMonitor - 窗口监控器

```python
class WindowMonitor:
    """定时轮询前台窗口信息，窗口切换时触发事件"""
    
    def __init__(self, poll_interval: float = 1.0):
        self.poll_interval = poll_interval
        self.current_window: WindowInfo = None
        self.on_window_change: Callback = None
    
    def get_active_window(self) -> WindowInfo:
        """调用 pywin32 获取前台窗口的进程名和标题"""
        ...
    
    async def run(self):
        """主循环：每秒轮询，窗口变化时写入 window_events"""
        ...
```

**WindowInfo 数据结构**:
```python
@dataclass
class WindowInfo:
    process_name: str    # 如 "chrome.exe"
    window_title: str    # 如 "Google - Chrome"
    timestamp: str       # ISO 8601
```

#### 3.1.2 ScreenCapturer - 截图采集器

```python
class ScreenCapturer:
    """使用 mss 库进行屏幕截图"""
    
    def capture(self) -> np.ndarray:
        """截取当前屏幕，返回 numpy 数组"""
        ...
    
    def save(self, image: np.ndarray, path: str):
        """保存截图为 PNG 文件"""
        ...
```

#### 3.1.3 ChangeDetector - 变化检测器

```python
class ChangeDetector:
    """基于 OpenCV 的屏幕变化检测"""
    
    def __init__(self, threshold: float = 0.02, 
                 check_interval: float = 2.0,
                 force_interval: float = 60.0):
        self.threshold = threshold           # 变化度阈值
        self.check_interval = check_interval # 对比间隔(秒)
        self.force_interval = force_interval # 强制截图间隔(秒)
        self.last_frame: np.ndarray = None
        self.last_capture_time: float = 0
    
    def compute_change_score(self, frame1: np.ndarray, frame2: np.ndarray) -> float:
        """
        计算两帧之间的变化度评分 (0.0 ~ 1.0)
        方案: 缩放为小图(如 480x270) → 转灰度 → absdiff → 均值归一化
        缩放可大幅降低计算量，同时不影响变化检测灵敏度
        """
        ...
    
    def should_capture(self, current_frame: np.ndarray) -> tuple[bool, float]:
        """判断是否应该截图，返回 (是否截图, 变化度评分)"""
        ...
    
    async def run(self, capturer: ScreenCapturer, window_monitor: WindowMonitor):
        """
        主循环:
        1. 每 check_interval 秒截图一次
        2. 与上一帧对比变化度
        3. 超过阈值 或 超过 force_interval → 保存截图 + 写入数据库
        4. 将截图推入 OCR 处理队列
        """
        ...
```

**变化检测算法选择**:
- 使用 `absdiff` + 均值方案而非 SSIM，原因是计算速度快 5-10 倍
- 先将图像缩放到 480x270 再对比，减少 ~90% 计算量
- 阈值 0.02 表示约 2% 像素变化即触发截图

### 3.2 OCR 感知层

#### 3.2.1 OCREngine - OCR 引擎封装

```python
class OCREngine:
    """封装 PaddleOCR，提供统一的 OCR 接口"""
    
    def __init__(self):
        self.engine = PaddleOCR(use_angle_cls=True, lang='ch')
    
    def recognize(self, image_path: str) -> list[OCRBlock]:
        """
        对图片执行 OCR，返回识别结果列表
        每个 OCRBlock 包含: text, bbox(x,y,w,h), confidence
        """
        ...
```

**OCRBlock 数据结构**:
```python
@dataclass
class OCRBlock:
    text: str
    bbox: tuple[int, int, int, int]  # x, y, width, height
    confidence: float
```

#### 3.2.2 ZoneMapper - 空间结构化文本生成器

```python
class ZoneMapper:
    """将 OCR 结果映射到屏幕区域网格，生成 Zone-Map 文本"""
    
    # 屏幕分区方案: 3列 × 3行 = 9个区域
    ZONE_LABELS = {
        (0, 0): "TL", (1, 0): "TC", (2, 0): "TR",  # Top
        (0, 1): "ML", (1, 1): "MC", (2, 1): "MR",  # Middle
        (0, 2): "BL", (1, 2): "BC", (2, 2): "BR",  # Bottom
    }
    
    def __init__(self, screen_width: int = 1920, screen_height: int = 1080,
                 cols: int = 3, rows: int = 3):
        self.screen_width = screen_width
        self.screen_height = screen_height
        self.cols = cols
        self.rows = rows
    
    def map_to_zone(self, bbox: tuple) -> str:
        """根据 bbox 中心点确定所属区域标签"""
        ...
    
    def generate_zone_map(self, ocr_blocks: list[OCRBlock], 
                          window_info: WindowInfo,
                          timestamp: str) -> str:
        """
        生成 Zone-Map 格式文本
        
        设计原则:
        1. 头部行: 分辨率、应用名、时间戳（元信息）
        2. 每个有内容的区域一行，格式: [区域标签] 文本内容
        3. 同区域多个文本用 " | " 分隔
        4. 空区域省略（减少token）
        5. 相邻重复文本去重（减少冗余）
        
        输出示例:
        @1920x1080 [WeChat.exe: 微信] 2026-04-14T10:30:00
        [TL] 聊天列表 | 张三 | 李四 | 工作群
        [TC] 张三: 你好，明天开会吗？ | 我: 好的，几点？
        [MC] 张三: 下午2点 | 我: 收到
        [BC] 输入消息...
        """
        ...
    
    def deduplicate(self, texts: list[str]) -> list[str]:
        """去除高度相似的相邻文本（如连续两帧几乎相同的OCR结果）"""
        ...
```

**Zone-Map 格式设计思考**:

| 方案 | Token 数 | 空间感 | 可读性 |
|------|----------|--------|--------|
| 原始 bbox JSON | ~500 | ✓ 精确 | ✗ 差 |
| ASCII 画布 | ~300 | ✓ 直观 | ✓ 好 | 
| **Zone-Map 标签式** | **~100** | **✓ 区域级** | **✓ 好** |
| 纯文本拼接 | ~80 | ✗ 无 | ✓ 好 |

选择 Zone-Map 标签式方案，在空间感和 token 效率间取得最佳平衡。9 个区域标签（TL/TC/TR/ML/MC/MR/BL/BC/BR）足以表达"屏幕哪个区域有什么内容"，模型可以轻松理解布局。

#### 3.2.3 OCR 异步处理队列

```python
class OCRProcessor:
    """异步 OCR 处理器，从队列中取截图进行 OCR"""
    
    def __init__(self, engine: OCREngine, mapper: ZoneMapper, 
                 db: Database, max_workers: int = 1):
        self.queue: asyncio.Queue = asyncio.Queue()
        self.engine = engine
        self.mapper = mapper
        self.db = db
    
    async def enqueue(self, capture_id: int, screenshot_path: str, 
                      window_info: WindowInfo, timestamp: str):
        """将截图加入处理队列"""
        ...
    
    async def run(self):
        """消费队列，逐一执行 OCR 并存储结果"""
        ...
```

### 3.3 Agent 感知层

#### 3.3.1 蒸馏架构

```
原始数据层（截图 + Zone-Map + 窗口信息）
     │
     │ L1 蒸馏: 每5分钟窗口
     ▼
时刻描述 (Moment Summary)
  "10:25-10:30 用户在VS Code编写Python代码，文件名为main.py"
     │
     │ L2 蒸馏: 每30分钟/应用切换
     ▼
时段摘要 (Session Summary)  
  "10:00-10:30 用户在VS Code进行Python后端开发，主要编写main.py和database.py"
     │
     │ L3 蒸馏: 每日一次
     ▼
日摘要 (Daily Summary)
  "今日主要进行Python后端开发(4h)、微信工作沟通(1.5h)、浏览技术文档(1h)..."
```

#### 3.3.2 Distiller - 蒸馏引擎

```python
class Distiller:
    """多级数据蒸馏引擎"""
    
    def __init__(self, llm_client, db: Database):
        self.llm = llm_client
        self.db = db
    
    async def distill_moment(self, time_start: str, time_end: str) -> str:
        """
        L1 蒸馏: 时刻描述
        
        输入: 5分钟窗口内所有 Zone-Map 文本 + 窗口信息
        输出: 1-2 句话描述
        
        调用策略:
        - 截图完成 OCR 后触发（延迟5分钟窗口）
        - 如果窗口内截图 < 2 张，标记为"无明显活动"
        """
        ...
    
    async def distill_session(self, moment_ids: list[int]) -> str:
        """
        L2 蒸馏: 时段摘要
        
        输入: 多个连续的 L1 时刻描述
        输出: 一段时段摘要
        
        触发条件:
        - 累计 6 个 L1 描述（约30分钟）
        - 或检测到主要应用切换（如从 VS Code 切换到 Chrome）
        """
        ...
    
    async def distill_daily(self, date: str) -> str:
        """
        L3 蒸馏: 日摘要
        
        输入: 当日所有 L2 时段摘要
        输出: 日报式总结 + 应用使用统计
        
        触发: 每日定时 / 手动触发
        """
        ...
```

#### 3.3.3 Prompt 设计

```python
# L1 Prompt
L1_PROMPT = """你是一个电脑使用行为分析助手。根据以下屏幕OCR数据，用1-2句话描述用户此刻在做什么。

时间范围: {time_start} ~ {time_end}
屏幕数据:
{zone_maps}

要求:
- 描述要具体（提及应用名、操作对象）
- 不要臆测用户意图，只描述可观察到的行为
- 用中文回答，一句话即可"""

# L2 Prompt  
L2_PROMPT = """根据以下时刻描述序列，归纳出这个时段用户的主要活动。

时段: {time_start} ~ {time_end}
时刻描述:
{moment_summaries}

要求:
- 合并相似活动，突出主要行为
- 标注涉及的应用和主题
- 2-3句话概括"""

# L3 Prompt
L3_PROMPT = """根据以下时段摘要，生成用户今日的活动报告。

日期: {date}
时段摘要:
{session_summaries}

要求:
- 按时间顺序梳理主要活动
- 统计各类活动的大致时间分配
- 突出重点工作内容
- 整体篇幅 200 字以内"""
```

#### 3.3.4 Query - 渐进式披露查询

```python
class QueryEngine:
    """支持多层级渐进式披露的查询引擎"""
    
    def __init__(self, db: Database):
        self.db = db
    
    def get_daily_summary(self, date: str) -> DailySummary:
        """获取日摘要（L3），最高层级入口"""
        ...
    
    def get_sessions_for_day(self, date: str) -> list[SessionSummary]:
        """获取某日所有时段摘要（L2）"""
        ...
    
    def get_moments_for_session(self, session_id: int) -> list[MomentSummary]:
        """获取某时段内所有时刻描述（L1）"""
        ...
    
    def get_captures_for_moment(self, moment_id: int) -> list[CaptureDetail]:
        """获取某时刻的原始截图和 Zone-Map 数据"""
        ...
    
    def get_capture_detail(self, capture_id: int) -> CaptureDetail:
        """获取单张截图的完整信息（元数据 + OCR + Zone-Map + 截图路径）"""
        ...
    
    def query_by_time(self, timestamp: str) -> dict:
        """
        按时间戳查询，自动返回最匹配的各层级数据
        返回: {
            "moment": MomentSummary,     # 所属的L1描述
            "session": SessionSummary,   # 所属的L2摘要
            "captures": [CaptureDetail]  # 附近的截图列表
        }
        """
        ...
    
    def query_by_app(self, app_name: str, date: str = None) -> list[MomentSummary]:
        """按应用名查询相关的时刻描述"""
        ...
```

## 4. 运行流程设计

### 4.1 主程序启动流程

```python
async def main():
    # 1. 加载配置
    config = load_config("config/settings.yaml")
    
    # 2. 初始化数据库
    db = Database(config.db_path)
    db.init_tables()
    
    # 3. 初始化各层组件
    window_monitor = WindowMonitor(config.window_poll_interval)
    capturer = ScreenCapturer()
    detector = ChangeDetector(
        threshold=config.change_threshold,
        check_interval=config.check_interval,
        force_interval=config.force_interval
    )
    
    ocr_engine = OCREngine()
    zone_mapper = ZoneMapper(config.screen_width, config.screen_height)
    ocr_processor = OCRProcessor(ocr_engine, zone_mapper, db)
    
    distiller = Distiller(config.llm_client, db)
    
    # 4. 启动异步任务
    await asyncio.gather(
        window_monitor.run(),           # 窗口监控循环
        detector.run(capturer, window_monitor),  # 截图+变化检测循环
        ocr_processor.run(),            # OCR 处理队列消费
        distiller.schedule(),           # 定时蒸馏任务
    )
```

### 4.2 数据处理管线时序

```
时间轴 →
t=0s     t=2s     t=4s     t=6s     ...     t=300s(5min)
 │        │        │        │                    │
 截图1    截图2    截图3    截图4                  │
 │        │(无变化) │        │(无变化)             │
 保存     跳过     保存     跳过                  │
 │                 │                             │
 ┗━→ OCR队列       ┗━→ OCR队列                    │
      ↓                ↓                         │
    ZoneMap1         ZoneMap3                     │
                                                 │
                                          ┗━→ L1蒸馏
                                               ↓
                                          MomentSummary
```

## 5. 配置文件设计

```yaml
# config/settings.yaml

# 系统感知层
perception:
  window_poll_interval: 1.0      # 窗口轮询间隔(秒)
  check_interval: 2.0            # 屏幕变化检测间隔(秒)
  change_threshold: 0.02         # 变化度阈值 (0.0~1.0)
  force_capture_interval: 60.0   # 无变化时强制截图间隔(秒)
  screenshot_quality: 80         # 截图质量(1-100)
  downscale_for_compare: [480, 270]  # 对比时缩放分辨率

# OCR 感知层
ocr:
  engine: "paddleocr"            # OCR引擎: paddleocr / tesseract
  language: "ch"                 # 识别语言
  confidence_threshold: 0.6      # 置信度过滤阈值
  zone_grid: [3, 3]              # 区域网格: 列数 × 行数
  max_queue_size: 100            # OCR 队列最大长度

# Agent 感知层  
agent:
  llm:
    base_url: "https://api.openai.com/v1"
    api_key: "${AI_MONITOR_API_KEY}"    # 从环境变量读取
    model: "gpt-4o-mini"                # L1/L2 使用轻量模型
    model_daily: "gpt-4o"               # L3 日摘要使用更强模型
    temperature: 0.3
    max_tokens: 500
  distill:
    moment_window: 300             # L1 时间窗口(秒) = 5分钟
    session_window: 1800           # L2 时间窗口(秒) = 30分钟
    daily_trigger_time: "23:00"    # L3 日摘要触发时间
    min_captures_for_moment: 2     # 触发L1蒸馏的最少截图数

# 存储
storage:
  db_path: "data/ai_monitor.db"
  screenshot_dir: "data/screenshots"
  max_retention_days: 30           # 截图保留天数

# 隐私
privacy:
  excluded_processes:              # 排除的进程（不截图）
    - "KeePass.exe"
    - "1Password.exe"
  excluded_titles:                 # 排除的窗口标题关键词
    - "密码"
    - "password"
    - "银行"
```

## 6. 关键设计决策

### 6.1 Zone-Map 空间文本格式

**问题**: 如何存储 OCR 文本，使其既保留空间布局信息，又对 LLM 友好（低 token），又人类可读？

**方案**: 9 区域标签式 Zone-Map

```
@1920x1080 [Code.exe: main.py - VS Code] 2026-04-14T14:30:00
[TL] Explorer | src | main.py | utils.py
[TC] main.py × | database.py
[MC] def capture_screen(): | img = mss.grab() | return np.array(img)
[MR] PROBLEMS | 0 errors | 2 warnings
[BC] Terminal | $ python main.py | Running...
[BR] Ln 42, Col 8 | Python | UTF-8
```

**优势**:
- ~100 tokens（原始 bbox JSON 需要 ~500 tokens，节省 80%）
- 9 个区域标签直觉明确（TL=左上，BC=下中等）
- LLM 可轻松理解"左上角是文件管理器，中间是代码编辑区"
- 空区域省略，进一步节省 token

### 6.2 异步解耦设计

截图采集和 OCR 处理通过 asyncio.Queue 解耦：
- 截图线程只负责截图 + 写元数据，不等待 OCR
- OCR 在独立协程中消费队列，即使 OCR 较慢也不影响截图
- 好处：OCR 单帧可能需要 1-3 秒，但截图间隔只有 2 秒

### 6.3 蒸馏触发策略

- **L1 (时刻描述)**: OCR 完成后检查，当前 5 分钟窗口内截图≥2张 且 窗口时间已过 → 触发
- **L2 (时段摘要)**: L1 生成后检查，累积≥6个 L1 或 检测到应用类别切换 → 触发
- **L3 (日摘要)**: 定时触发（默认 23:00）或手动调用

### 6.4 渐进式披露的索引设计

每层数据通过时间范围 + ID 列表双重索引：
- **时间索引**: 所有表都有 `time_start/time_end`，支持按时间范围快速查询
- **ID 关联**: `moment_summaries.capture_ids` → 可回溯到具体截图
- **查询路径**: 用户给定时间 → 二分查找匹配 moment → 获取 session → 获取 daily

## 7. 技术依赖

```
# requirements.txt
mss>=9.0.0               # 高性能截图
opencv-python>=4.8.0      # 图像对比
numpy>=1.24.0             # 数组操作
paddleocr>=2.7.0          # OCR引擎
paddlepaddle>=2.5.0       # PaddleOCR 依赖
pywin32>=306              # Windows API (窗口信息)
openai>=1.0.0             # LLM API 调用
pyyaml>=6.0               # 配置文件解析
aiosqlite>=0.19.0         # 异步 SQLite
Pillow>=10.0.0            # 图像处理
```

## 8. 部署与配置指南

### 8.1 环境要求

- **操作系统**: Windows 10/11（使用 pywin32 获取窗口信息）
- **Python**: 3.10+（已测试 3.14）
- **磁盘空间**: 建议预留 5GB+（截图按 JPEG 存储，单张约 500KB-1MB）

### 8.2 安装步骤

```bash
# 1. 克隆或解压项目
cd ai_monitor

# 2. 安装依赖
pip install -r requirements.txt

# 3. 配置环境变量（二选一）

# 方式A: 系统环境变量
set AI_MONITOR_BASE_URL=https://api.openai.com/v1
set AI_MONITOR_API_KEY=your-api-key-here

# 方式B: 创建 .env 文件（参考 .env.example）
copy .env.example .env
# 编辑 .env 填入你的 API 地址和密钥
```

### 8.3 环境变量说明

| 变量名 | 必填 | 说明 | 示例 |
|--------|------|------|------|
| `AI_MONITOR_BASE_URL` | 是 | LLM API 基础地址（兼容 OpenAI 格式） | `https://api.openai.com/v1` |
| `AI_MONITOR_API_KEY` | 是 | LLM API 密钥 | `sk-xxxx` |

> **注意**: 你的 API 端点必须兼容 OpenAI `/chat/completions` 接口格式。

### 8.4 配置文件详解 (`config/settings.yaml`)

```yaml
# ── 系统感知层 ──
perception:
  window_poll_interval: 1.0      # 窗口轮询间隔(秒)，检测前台应用切换
  check_interval: 5.0            # 屏幕变化检测间隔(秒)，每隔N秒截图对比
  change_threshold: 0.02         # 变化度阈值(0~1)，超过才保存截图。0.02≈2%像素变化
  force_capture_interval: 60.0   # 强制截图间隔(秒)，即使无变化也截一张
  screenshot_quality: 80         # JPEG 质量(1-100)，越低文件越小
  downscale_for_compare: [480, 270]  # 对比时缩放分辨率，降低CPU开销

# ── OCR 感知层 ──
ocr:
  engine: "paddleocr"            # OCR引擎标识（实际使用 RapidOCR）
  language: "ch"                 # 识别语言: ch(中英混合) / en(纯英文)
  confidence_threshold: 0.6      # OCR 置信度过滤，低于此值的文本丢弃
  zone_grid: [3, 3]              # 屏幕分区: [列数, 行数]，3x3=9个区域
  max_queue_size: 100            # OCR 处理队列上限，超出则丢弃最旧任务

# ── Agent 感知层 ──
agent:
  llm:
    base_url: "${AI_MONITOR_BASE_URL}"   # 从环境变量读取
    api_key: "${AI_MONITOR_API_KEY}"     # 从环境变量读取
    model: "gemini-3.1-pro-preview"      # L1/L2 蒸馏使用的模型
    model_daily: "gemini-3.1-pro-preview" # L3 日摘要使用的模型
    temperature: 0.3            # 生成温度，越低越稳定
    max_tokens: 500             # 单次生成最大 token 数
  distill:
    moment_window: 300          # L1 时间窗口(秒)，每5分钟生成一个时刻描述
    session_window: 1800        # L2 时间窗口(秒)，每30分钟生成一个时段摘要
    daily_trigger_time: "23:00" # L3 日摘要自动触发时间
    min_captures_for_moment: 2  # 触发L1蒸馏的最少截图数

# ── 存储 ──
storage:
  db_path: "data/ai_monitor.db"       # SQLite 数据库路径
  screenshot_dir: "data/screenshots"  # 截图存储目录
  max_retention_days: 30              # 截图保留天数（暂未启用自动清理）

# ── 隐私 ──
privacy:
  excluded_processes:           # 排除的进程名（不截图、不记录）
    - "KeePass.exe"
    - "1Password.exe"
  excluded_titles:              # 排除的窗口标题关键词
    - "密码"
    - "password"
    - "银行"
```

### 8.5 运行方式

```bash
# 启动屏幕采集（后台持续运行，截图+OCR+自动蒸馏）
python src/main.py capture

# 启动 Web 查看界面（浏览器打开 http://127.0.0.1:8080）
python src/main.py web

# 指定端口
python src/main.py web --port 9090
```

建议用两个终端分别运行 `capture` 和 `web`，或使用 `start.bat` 一键启动。

### 8.6 数据说明

| 目录/文件 | 说明 |
|-----------|------|
| `data/ai_monitor.db` | SQLite 数据库，存储所有元数据、OCR文本、蒸馏摘要 |
| `data/screenshots/YYYY-MM-DD/` | 截图文件，按日期分目录，JPEG 格式 |

所有数据均存储在本地 `data/` 目录，不会上传到任何远程服务器。

## 9. 后续扩展点

- **语义搜索**: 对 Zone-Map 文本建向量索引，支持"我什么时候讨论过XXX"
- **多屏支持**: 支持多显示器分别截图
- **智能排除**: 自动识别敏感内容并模糊处理
- **导出功能**: 支持导出日报为 Markdown / PDF
