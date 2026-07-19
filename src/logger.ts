export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
}

function emit(
  scope: string,
  level: Level,
  message: string,
  fields?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...fields,
  });

  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, fields) => emit(scope, 'debug', message, fields),
    info: (message, fields) => emit(scope, 'info', message, fields),
    warn: (message, fields) => emit(scope, 'warn', message, fields),
    error: (message, fields) => emit(scope, 'error', message, fields),
  };
}