import type { Logger, LoggerOption, LogLevel } from './types';

export const noopLogger: Logger = () => null;

type SdkLogBridge = (logLevel: LogLevel, ...args: unknown[]) => void;

declare global {
  // eslint-disable-next-line no-var
  var __ermisSdkLog: SdkLogBridge | undefined;
}

let sdkLogger: Logger | undefined;

function serializeLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    const serialized = JSON.stringify(arg);
    return typeof serialized === 'string' ? serialized : String(arg);
  } catch {
    return String(arg);
  }
}

function formatLogArgs(args: unknown[]): string {
  return args.map(serializeLogArg).join(' ');
}

function getExtraData(args: unknown[]): Record<string, unknown> | undefined {
  return args.length > 1 ? { args } : undefined;
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === 'info' || value === 'warn' || value === 'error';
}

function createConsoleLogger(levels: LogLevel[]): Logger | undefined {
  const enabledLevels = new Set(levels.filter(isLogLevel));
  if (enabledLevels.size === 0) return undefined;

  return (logLevel: LogLevel, message: string, extraData?: Record<string, unknown>) => {
    const methodName = logLevel === 'error' ? 'error' : logLevel === 'warn' ? 'warn' : 'log';
    const enabled = enabledLevels.has(logLevel);
    if (!enabled || typeof globalThis === 'undefined') return;

    const consoleTarget = globalThis.console;
    const method = consoleTarget?.[methodName] || consoleTarget?.log;
    if (typeof method !== 'function') return;

    if (extraData) {
      method.call(consoleTarget, `[SDK:${logLevel}] ${message}`, extraData);
      return;
    }

    method.call(consoleTarget, `[SDK:${logLevel}] ${message}`);
  };
}

function resolveLogger(logger?: LoggerOption): Logger | undefined {
  if (typeof logger === 'function' && logger !== noopLogger) return logger;
  if (Array.isArray(logger)) return createConsoleLogger(logger);
  return undefined;
}

function installGlobalLogBridge(): void {
  if (typeof globalThis === 'undefined') return;
  if (!sdkLogger) {
    globalThis.__ermisSdkLog = undefined;
    return;
  }
  globalThis.__ermisSdkLog = (logLevel: LogLevel, ...args: unknown[]) => {
    sdkLog(logLevel, ...args);
  };
}

export function getLogger(logger?: LoggerOption): Logger {
  return resolveLogger(logger) || noopLogger;
}

export function setSdkLogger(logger?: LoggerOption): void {
  sdkLogger = resolveLogger(logger);
  installGlobalLogBridge();
}

export function sdkLog(logLevel: LogLevel, ...args: unknown[]): void {
  if (!sdkLogger) return;
  sdkLogger(logLevel, formatLogArgs(args), getExtraData(args));
}

installGlobalLogBridge();
