/**
 * A colorized logger for mineflayer bots.
 * Adapted from @serenityjs/logger
 */
import { formatMinecraftColorCode } from './minecraft-colors.mts';
import { LoggerColors } from './logger-colors.mts';

export { LoggerColors } from './logger-colors.mts';
export { formatMinecraftColorCode, stripMinecraftColorCodes } from './minecraft-colors.mts';

/**
 * Log level for filtering messages.
 */
export const LogLevel = {
  Debug: 0,
  Info: 1,
  Warn: 2,
  Error: 3,
  None: 4,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/**
 * Format a date as MM-DD-YYYY HH:mm:ss
 */
function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const year = date.getFullYear();
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${month}-${day}-${year} ${hours}:${minutes}:${seconds}`;
}

/**
 * A colorized logger for applications.
 */
export class Logger {
  /**
   * Global log level. Messages below this level are not shown.
   */
  public static level: LogLevel = LogLevel.Info;

  /**
   * Whether debug messages should be shown (shortcut for level = Debug).
   */
  public static get DEBUG(): boolean {
    return Logger.level === LogLevel.Debug;
  }

  public static set DEBUG(value: boolean) {
    Logger.level = value ? LogLevel.Debug : LogLevel.Info;
  }

  /**
   * The module name of the logger.
   */
  public readonly name: string;

  /**
   * The color of module name.
   */
  public readonly color: string;

  /**
   * Constructs a new logger.
   * @param name - The module name.
   * @param color - The color of the module name (from LoggerColors).
   */
  constructor(name: string, color: string = LoggerColors.White) {
    this.name = name;
    this.color = color;
  }

  /**
   * Creates the formatted prefix for log messages.
   */
  private prefix(level?: string, levelColor?: string): string {
    const timestamp = `${LoggerColors.DarkGray}<${LoggerColors.Reset}${formatTimestamp()}${LoggerColors.DarkGray}>`;
    const module = `${LoggerColors.DarkGray}[${this.color}${this.name}${LoggerColors.DarkGray}]`;

    if (level && levelColor) {
      const levelTag = `${LoggerColors.DarkGray}[${levelColor}${level}${LoggerColors.DarkGray}]`;
      return `${timestamp} ${module} ${levelTag}${LoggerColors.Reset}`;
    }

    return `${timestamp} ${module}${LoggerColors.Reset}`;
  }

  /**
   * Colorize arguments by converting Minecraft color codes.
   */
  private colorize(...args: unknown[]): unknown[] {
    return args.map((arg) => {
      if (typeof arg === 'string') {
        return formatMinecraftColorCode(arg);
      }
      return arg;
    });
  }

  /**
   * Logs a message to the console.
   */
  public log(...args: unknown[]): void {
    console.log(this.prefix(), ...this.colorize(...args));
  }

  /**
   * Logs an info message to the console.
   */
  public info(...args: unknown[]): void {
    if (Logger.level > LogLevel.Info) return;
    console.log(this.prefix('Info', LoggerColors.DarkAqua), ...this.colorize(...args));
  }

  /**
   * Logs a warning message to the console.
   */
  public warn(...args: unknown[]): void {
    if (Logger.level > LogLevel.Warn) return;
    console.log(this.prefix('Warning', LoggerColors.Yellow), ...this.colorize(...args));
  }

  /**
   * Logs an error message to the console.
   */
  public error(...args: unknown[]): void {
    if (Logger.level > LogLevel.Error) return;
    console.log(this.prefix('Error', LoggerColors.DarkRed), ...args);
  }

  /**
   * Logs a success message to the console.
   */
  public success(...args: unknown[]): void {
    if (Logger.level > LogLevel.Info) return;
    console.log(this.prefix('Success', LoggerColors.Green), ...this.colorize(...args));
  }

  /**
   * Logs a debug message to the console.
   * Only shown when DEBUG is true or level is Debug.
   */
  public debug(...args: unknown[]): void {
    if (Logger.level > LogLevel.Debug) return;
    console.log(this.prefix('DEBUG', LoggerColors.Red), ...this.colorize(...args));
  }

  /**
   * Logs a chat message to the console.
   */
  public chat(sender: string, message: string): void {
    if (Logger.level > LogLevel.Info) return;
    console.log(this.prefix('Chat', LoggerColors.DarkAqua), this.colorize(sender)[0], '>', this.colorize(message)[0]);
  }

  /**
   * Create a child logger with a sub-module name.
   */
  public child(name: string, color?: string): Logger {
    return new Logger(`${this.name}:${name}`, color ?? this.color);
  }
}

/**
 * Default logger instance for the bot.
 */
export const defaultLogger = new Logger('Bot', LoggerColors.Aqua);
