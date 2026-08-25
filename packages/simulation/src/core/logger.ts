export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Minimal logging surface, so the simulation never reaches for `console` directly. */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** Drops everything. The default in tests. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};

export function createConsoleLogger(scope = 'sim', minLevel: LogLevel = 'info'): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[minLevel];
  const write = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
    if (order[level] < threshold) return;
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const line = `[${level}] [${scope}] ${message}${suffix}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    child: (childScope) => createConsoleLogger(`${scope}:${childScope}`, minLevel),
  };
}
