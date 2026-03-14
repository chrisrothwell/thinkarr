import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import fs from "fs";

const CONFIG_DIR =
  process.env.CONFIG_DIR || (process.platform === "win32" ? "./.config" : "/config");
const LOGS_DIR = path.join(CONFIG_DIR, "logs");

const isBuild = process.env.NEXT_PHASE === "phase-production-build";
const isTest = process.env.NODE_ENV === "test";

// Ensure logs directory exists — skip during Next.js builds and unit tests
if (!isBuild && !isTest) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Format a Date as "YYYY-MM-DD HH:MM:SS" in the timezone set by the TZ
 * environment variable. Uses Intl.DateTimeFormat with explicit 2-digit
 * options so the output is stable across ICU/CLDR versions.
 */
export function formatLocalTimestamp(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(process.env.TZ ? { timeZone: process.env.TZ } : {}),
  }).formatToParts(date);
  const p: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const { type, value } of parts) p[type] = value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const localTimestamp = winston.format.timestamp({
  format: () => formatLocalTimestamp(),
});

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    localTimestamp,
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? "\n" + JSON.stringify(meta, null, 2) : "";
          return `${timestamp} [${level}] ${message}${metaStr}`;
        })
      ),
    }),
    ...(isBuild || isTest ? [] : [
      new DailyRotateFile({
        dirname: LOGS_DIR,
        filename: "thinkarr-%DATE%.log",
        datePattern: "YYYY-MM-DD",
        maxFiles: "14d",
        maxSize: "20m",
        format: winston.format.combine(localTimestamp, winston.format.json()),
      }),
    ]),
  ],
});

export { logger };
