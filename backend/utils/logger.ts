import "dotenv/config";
import fs from "fs";
import path from "path";

const USE_LOCAL_LOGS = process.env.LOCAL_LOGS === "true";

const EXPORT_FOLDER = "export";

function ensureExportFolder(): void {
  if (!fs.existsSync(EXPORT_FOLDER)) {
    fs.mkdirSync(EXPORT_FOLDER, { recursive: true });
  }
}

/**
 * Logger that mimics console interface
 */
export const logger = {
  log: (...args: any[]) => console.log(...args),
  info: (...args: any[]) => console.info(...args),
  warn: (...args: any[]) => console.warn(...args),
  error: (...args: any[]) => console.error(...args),
  debug: (...args: any[]) => console.debug(...args),
  /**
   * Log content to file (when LOCAL_LOGS=true) or show message to console
   * Filename format: {prefix}-{timestamp}-{suffix}.{extension}
   */
  logContent: (
    message: string,
    context?: Record<string, any>,
    file?: {
      content: string | Buffer;
      prefix: string;
      suffix: string;
      extension?: string;
    }
  ) => {
    if (file) {
      const date = new Date().toISOString().replace(/:/g, "-");
      const ext = file.extension || "txt";
      const filename = `${file.prefix}-${date}-${file.suffix}.${ext}`;

      if (USE_LOCAL_LOGS) {
        // Write to actual file
        ensureExportFolder();
        const filePath = path.join(EXPORT_FOLDER, filename);
        fs.writeFileSync(filePath, file.content);
        // Log message with context and file written info
        if (context) {
          console.log(message, { ...context, fileWritten: filename });
        } else {
          console.log(message, { fileWritten: filename });
        }
      } else {
        // Log message with context (skip binary content in console)
        const isBinary = Buffer.isBuffer(file.content);
        if (isBinary) {
          if (context) {
            console.log(message, { ...context, binarySize: file.content.length });
          } else {
            console.log(message, { binarySize: file.content.length });
          }
        } else {
          const fileOutput = `\n-----------\n${file.content}\n-----------\n`;
          if (context) {
            console.log(message + fileOutput, context);
          } else {
            console.log(message + fileOutput);
          }
        }
      }
    } else {
      // No file, just log message
      if (context) {
        console.log(message, context);
      } else {
        console.log(message);
      }
    }
  },
};

/**
 * Write data to export folder when LOCAL_LOGS=true, otherwise just log to console
 */
function writeLocalFile(data: string, filename?: string): void {
  if (USE_LOCAL_LOGS) {
    ensureExportFolder();
    const actualFilename = filename || `output-${new Date().toISOString().replace(/:/g, "-")}.txt`;
    const filePath = path.join(EXPORT_FOLDER, actualFilename);
    fs.writeFileSync(filePath, data);
    logger.log(`File written: ${actualFilename}`);
  } else {
    logger.log(`Data output (${data.length} bytes)`);
  }
}

/**
 * Write JSON data to export folder when LOCAL_LOGS=true, otherwise just log to console
 */
export function writeLocalJSON(data: any, filename?: string): void {
  const jsonString = JSON.stringify(data, null, 2);
  const actualFilename = filename || `output-${new Date().toISOString().replace(/:/g, "-")}.json`;
  writeLocalFile(jsonString, actualFilename);
}
