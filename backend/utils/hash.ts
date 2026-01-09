import crypto from "crypto";

/**
 * Helper to generate MD5 hash (16 char hex)
 */
export function hash(input: string): string {
  return crypto.createHash("md5").update(input).digest("hex").substring(0, 16);
}
