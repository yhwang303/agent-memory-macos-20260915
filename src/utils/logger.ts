/**
 * Enhanced logger utility for AgentMemory System
 * Features:
 * - Console and file logging
 * - Lifecycle management (new log file per service start)
 * - Log rotation (keep last N log files)
 * - Configurable log levels
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

interface LoggerConfig {
  /** Current log level */
  level: LogLevel;
  /** Directory to store log files */
  logDir: string;
  /** Maximum log file size in bytes before rotation (default: 10MB) */
  maxLogFileSize: number;
  /** Whether to enable file logging */
  enableFileLogging: boolean;
  /** Whether to enable console logging */
  enableConsoleLogging: boolean;
  /** CLI mode - logs only to file, never to stderr (to avoid breaking CLI JSON output) */
  cliMode: boolean;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: string;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
}

class Logger {
  private config: LoggerConfig;
  private currentLogFile: string | null = null;
  private sessionId: string | null = null;
  private startTime: Date | null = null;
  private fileDescriptor: number | null = null;
  private initialized: boolean = false;
  private pendingLogs: string[] = [];
  private currentServiceName: string | null = null;

  constructor() {
    this.config = {
      level: (process.env.LOG_LEVEL as LogLevel) || 'info',
      logDir: process.env.LOG_DIR || path.join(os.homedir(), '.agent-memory', 'logs'),
      maxLogFileSize: parseInt(process.env.LOG_MAX_FILE_SIZE || String(10 * 1024 * 1024), 10), // 10MB default
      enableFileLogging: process.env.LOG_TO_FILE !== 'false',
      enableConsoleLogging: process.env.LOG_TO_CONSOLE !== 'false',
      cliMode: process.env.CODEBUDDY_CLI_MODE === '1'
    };
  }

  /**
   * Enable CLI mode - logs only to file, never to stderr
   * This is critical for hooks-cli where stdout must be pure JSON
   */
  setCliMode(enabled: boolean): void {
    this.config.cliMode = enabled;
    if (enabled) {
      // In CLI mode, always enable file logging for debugging
      this.config.enableFileLogging = true;
    }
  }

  /**
   * Set log level dynamically
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * Initialize the logger for a new service lifecycle
   * Opens the log file in append mode (creates if not exists)
   */
  init(serviceName: string = 'worker'): void {
    if (this.initialized && this.currentServiceName === serviceName) {
      return;
    }

    // If switching service, close previous file
    if (this.initialized && this.currentServiceName !== serviceName) {
      this.closeFileDescriptor();
    }

    this.startTime = new Date();
    this.sessionId = this.generateSessionId();
    this.currentServiceName = serviceName;

    if (this.config.enableFileLogging) {
      this.ensureLogDirectory();
      this.openLogFile(serviceName);
    }

    this.initialized = true;

    // Write pending logs
    if (this.pendingLogs.length > 0) {
      this.pendingLogs.forEach(log => this.writeToFile(log));
      this.pendingLogs = [];
    }

    this.info('Logger', '=== Session Started ===', {
      sessionId: this.sessionId,
      startTime: this.startTime.toISOString(),
      logFile: this.currentLogFile,
      config: {
        level: this.config.level,
        maxLogFileSize: this.config.maxLogFileSize,
        enableFileLogging: this.config.enableFileLogging
      }
    });
  }

  /**
   * Shutdown the logger gracefully
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    const endTime = new Date();
    const duration = this.startTime 
      ? Math.round((endTime.getTime() - this.startTime.getTime()) / 1000)
      : 0;

    this.info('Logger', '=== Session Ended ===', {
      sessionId: this.sessionId,
      endTime: endTime.toISOString(),
      durationSeconds: duration
    });

    this.closeFileDescriptor();
    this.initialized = false;
  }

  private closeFileDescriptor(): void {
    if (this.fileDescriptor !== null) {
      try {
        fs.closeSync(this.fileDescriptor);
      } catch {
        // Ignore close errors
      }
      this.fileDescriptor = null;
    }
  }

  /**
   * Get the current log file path
   */
  getCurrentLogFile(): string | null {
    return this.currentLogFile;
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Get all available log files
   */
  getLogFiles(): string[] {
    if (!fs.existsSync(this.config.logDir)) {
      return [];
    }

    return fs.readdirSync(this.config.logDir)
      .filter(file => file.endsWith('.log'))
      .map(file => path.join(this.config.logDir, file))
      .sort((a, b) => {
        const statA = fs.statSync(a);
        const statB = fs.statSync(b);
        return statB.mtime.getTime() - statA.mtime.getTime();
      });
  }

  /**
   * Read log file content
   */
  readLogFile(logFile?: string): string {
    const file = logFile || this.currentLogFile;
    if (!file || !fs.existsSync(file)) {
      return '';
    }
    return fs.readFileSync(file, 'utf-8');
  }

  // Log methods
  debug(category: string, message: string, data?: Record<string, unknown>): void {
    this.log('debug', category, message, data);
  }

  info(category: string, message: string, data?: Record<string, unknown>): void {
    this.log('info', category, message, data);
  }

  warn(category: string, message: string, data?: Record<string, unknown>): void {
    this.log('warn', category, message, data);
  }

  error(category: string, message: string, data?: Record<string, unknown>, error?: Error): void {
    const errorData = error ? {
      ...data,
      errorMessage: error.message,
      errorStack: error.stack
    } : data;
    this.log('error', category, message, errorData);
  }

  // Private methods

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.config.level];
  }

  private log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      data
    };

    const formattedLog = this.formatLogEntry(entry);

    // Console output
    if (this.config.enableConsoleLogging) {
      this.writeToConsole(level, formattedLog);
    }

    // File output
    if (this.config.enableFileLogging) {
      if (this.initialized) {
        this.writeToFile(formattedLog);
      } else {
        // Buffer logs until initialized
        this.pendingLogs.push(formattedLog);
      }
    }
  }

  private formatLogEntry(entry: LogEntry): string {
    const levelUpper = entry.level.toUpperCase().padEnd(5);
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
    return `[${entry.timestamp}] [${levelUpper}] [${entry.category}] ${entry.message}${dataStr}`;
  }

  private writeToConsole(level: LogLevel, message: string): void {
    // In CLI mode, skip stderr output entirely to avoid breaking JSON output
    if (this.config.cliMode) {
      return;
    }
    // Always write to stderr to avoid polluting stdout
    // This is critical for CLI tools that use stdout for JSON output
    process.stderr.write(message + '\n');
  }

  private writeToFile(message: string): void {
    if (this.fileDescriptor !== null) {
      try {
        // Check if rotation is needed before writing
        this.checkAndRotateIfNeeded();
        // Use synchronous write to ensure immediate disk write
        fs.writeSync(this.fileDescriptor, message + '\n');
      } catch {
        // Ignore write errors to avoid crash loops
      }
    }
  }

  private generateSessionId(): string {
    const now = new Date();
    const dateStr = now.toISOString().replace(/[-:]/g, '').replace('T', '-').split('.')[0];
    const random = Math.random().toString(36).substring(2, 8);
    return `${dateStr}-${random}`;
  }

  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.config.logDir)) {
      fs.mkdirSync(this.config.logDir, { recursive: true });
    }
  }

  /**
   * Open log file in append mode (single file per service)
   */
  private openLogFile(serviceName: string): void {
    const filename = `${serviceName}.log`;
    this.currentLogFile = path.join(this.config.logDir, filename);

    // Check if rotation is needed before opening
    this.rotateIfNeeded();

    // Open file with append mode using synchronous API for reliability
    this.fileDescriptor = fs.openSync(this.currentLogFile, 'a');

    // Write session separator
    const now = new Date();
    const separator = [
      '',
      '--------------------------------------------------------------------------------',
      `  New Session - ${now.toISOString()}`,
      `  Session ID: ${this.sessionId}`,
      '--------------------------------------------------------------------------------',
    ].join('\n');

    fs.writeSync(this.fileDescriptor, separator + '\n');
  }

  /**
   * Check if log file needs rotation and rotate if needed
   */
  private checkAndRotateIfNeeded(): void {
    if (!this.currentLogFile || !fs.existsSync(this.currentLogFile)) {
      return;
    }

    try {
      const stats = fs.statSync(this.currentLogFile);
      if (stats.size >= this.config.maxLogFileSize) {
        this.rotateLogFile();
      }
    } catch {
      // Ignore stat errors
    }
  }

  /**
   * Rotate if the current log file is too large (before opening)
   */
  private rotateIfNeeded(): void {
    if (!this.currentLogFile || !fs.existsSync(this.currentLogFile)) {
      return;
    }

    try {
      const stats = fs.statSync(this.currentLogFile);
      if (stats.size >= this.config.maxLogFileSize) {
        this.rotateLogFile();
      }
    } catch {
      // Ignore stat errors
    }
  }

  /**
   * Rotate the current log file
   */
  private rotateLogFile(): void {
    if (!this.currentLogFile) {
      return;
    }

    // Close current file descriptor
    this.closeFileDescriptor();

    // Generate rotated filename with timestamp
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const dateStr = `${year}${month}${day}_${hours}-${minutes}-${seconds}`;
    
    const baseName = path.basename(this.currentLogFile, '.log');
    const rotatedFilename = `${baseName}_${dateStr}.log`;
    const rotatedPath = path.join(this.config.logDir, rotatedFilename);

    // Rename current file to rotated name
    try {
      fs.renameSync(this.currentLogFile, rotatedPath);
    } catch {
      // If rename fails, continue anyway
    }

    // Reopen the log file (creates new file)
    this.fileDescriptor = fs.openSync(this.currentLogFile, 'a');
  }

}

// Export singleton instance
export const logger = new Logger();

export default logger;
