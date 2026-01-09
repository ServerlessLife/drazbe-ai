import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFile } from "fs/promises";
import { logger } from "../utils/logger.js";

const BUCKET_NAME = process.env.PUBLIC_BUCKET_NAME || "";
const LOCAL_STORAGE = process.env.LOCAL_STORAGE === "true";

const s3Client = new S3Client({});

/**
 * Upload a file to S3
 * @param content - File content as Buffer or local file path
 * @param s3Key - S3 key (path) for the file including folder
 * @param contentType - MIME type of the file
 * @returns S3 key of the uploaded file
 */
async function uploadFile(
  content: Buffer | string,
  s3Key: string,
  contentType: string
): Promise<string> {
  if (LOCAL_STORAGE) {
    logger.log("Local storage mode - skipping S3 upload", { s3Key });
    return typeof content === "string" ? content : s3Key;
  }

  logger.log("Uploading file to S3", { s3Key, contentType });

  const body = typeof content === "string" ? await readFile(content) : content;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: body,
      ContentType: contentType,
    })
  );

  logger.log("File uploaded to S3", { s3Key });

  return s3Key;
}

export const S3Service = {
  uploadFile,
};
