import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import fs from "fs";

const CONFIG_DIR =
  process.env.CONFIG_DIR || (process.platform === "win32" ? "./.config" : "/config");
const LOGS_DIR = path.join(CONFIG_DIR, "logs");

// Ensure logs directory exists — skip during Next.js build (NEXT_PHASE is set)
if (process.env.NEXT_PHASE !== "phase-production-build") {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const isBuild = process.env.NEXT_PHASE === "phase-production-build";

// Use local time from the TZ env var rather than UTC
const localTimestamp = winston.format.timestamp({
  format: () => new Date().toLocaleString("sv"),
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
    ...(isBuild ? [] : [
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
