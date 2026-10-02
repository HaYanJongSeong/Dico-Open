/**
 * Structured logger for module-scoped JSON log entries.
 */
export interface Logger {
  /**
   * Log a debug message.
   * @param msg - Human-readable log message
   * @param meta - Structured metadata to include in the log entry
   * @returns Nothing
   */
  debug(msg: string, meta?: Record<string, unknown>): void;

  /**
   * Log an info message.
   * @param msg - Human-readable log message
   * @param meta - Structured metadata to include in the log entry
   * @returns Nothing
   */
  info(msg: string, meta?: Record<string, unknown>): void;

  /**
   * Log a warning message.
   * @param msg - Human-readable log message
   * @param meta - Structured metadata to include in the log entry
   * @returns Nothing
   */
  warn(msg: string, meta?: Record<string, unknown>): void;

  /**
   * Log an error message.
   * @param msg - Human-readable log message
   * @param meta - Structured metadata to include in the log entry
   * @returns Nothing
   */
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Generate a correlation ID for request tracing.
 * @param threadId - Discord thread ID
 * @returns Correlation ID in format `threadId-timestamp`
 */
export function generateCorrelationId(threadId: string): string {
  return `${threadId}-${Date.now()}`;
}

/**
 * Create a structured JSON logger for a module.
 * @param module - Module name for log context
 * @returns Logger instance with debug/info/warn/error methods
 */
export function createLogger(module: string): Logger {
  const pretty = process.env.OPENCODE_LOG_FORMAT === 'pretty' || process.stdout.isTTY === true;
  const log = (
    level: string,
    msg: string,
    meta: Record<string, unknown> = {},
  ): void => {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      module,
      msg,
      ...meta,
    });

    const output = pretty ? formatPrettyLog(level, module, msg, meta) : entry;
    switch (level) {
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
      default:
        console.log(output);
    }
  };

  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
  };
}

function formatPrettyLog(level: string, module: string, msg: string, meta: Record<string, unknown>): string {
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  const icon = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '✅';
  const message = prettyMessage(msg, meta);
  const location = typeof meta.sessionId === 'string'
    ? `OpenCode 세션 ${meta.sessionId}${typeof meta.threadId === 'string' ? ` · Discord 스레드 ${meta.threadId}` : ''}`
    : typeof meta.threadId === 'string'
      ? `Discord 스레드 ${meta.threadId}`
    : typeof meta.projectPath === 'string'
      ? `프로젝트 ${meta.projectPath}`
      : module;
  const error = meta.error instanceof Error ? meta.error.message : typeof meta.error === 'string' ? meta.error : undefined;
  return `[${time}] ${icon} ${message}${error ? ` · ${error}` : ''} · ${location}`;
}

function prettyMessage(msg: string, meta: Record<string, unknown>): string {
  if (msg === 'Discord 메시지 수신') {
    return `Discord 메시지 수신 완료${typeof meta.contentLength === 'number' ? ` · ${meta.contentLength}자` : ''}`;
  }
  if (msg === 'OpenCode 프롬프트 전달 시작') return 'OpenCode 작업 시작';
  if (msg === 'OpenCode 프롬프트 전달 완료') return 'OpenCode 프롬프트 전달 완료';
  if (msg === 'OpenCode 이벤트 수신') return `OpenCode 작업 진행 · ${String(meta.type ?? '이벤트')}`;
  if (msg === 'Discord 스트림 메시지 전송') return 'Discord 응답 전송';
  if (msg === 'Discord 스트림 메시지 수정') return 'Discord 응답 갱신';
  if (msg === 'Discord 스트림 조각 전송') return 'Discord 응답 조각 전송';
  if (msg === 'Discord 로그인 완료') return 'Discord 로그인 완료';
  return msg;
}
