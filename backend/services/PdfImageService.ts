import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createCanvas, loadImage, type Canvas } from "canvas";
import { execSync } from "child_process";
import crypto from "crypto";
import { S3Service } from "./S3Service.js";
import { logger } from "../utils/logger.js";
import { ExtractedPhoto } from "../types/DocumentResult.js";

// Thresholds for filtering out mostly-white/empty images
const MIN_COLOR_VARIANCE = 1500;
const MAX_BRIGHTNESS = 240;
const MIN_COLOR_SATURATION = 5;

// Thresholds for splitting photos
const SPLIT_LINE_BRIGHTNESS = 240;
const MIN_SEPARATOR_HEIGHT = 5;
const MIN_PHOTO_HEIGHT = 50;

interface PhotoRegion {
  y: number;
  height: number;
}

/**
 * Analyze image to determine if it's a color photo
 */
async function analyzeImageFile(imagePath: string): Promise<{
  isPhoto: boolean;
  hasColor: boolean;
  avgBrightness: number;
  variance: number;
  avgSaturation: number;
}> {
  const img = await loadImage(imagePath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  const step = 40;
  let sum = 0;
  let sumSq = 0;
  let saturationSum = 0;
  let count = 0;

  for (let i = 0; i < data.length; i += 4 * step) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const gray = r * 0.299 + g * 0.587 + b * 0.114;
    sum += gray;
    sumSq += gray * gray;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max - min;
    saturationSum += saturation;

    count++;
  }

  const avgBrightness = sum / count;
  const variance = sumSq / count - avgBrightness * avgBrightness;
  const avgSaturation = saturationSum / count;

  const isPhoto = variance > MIN_COLOR_VARIANCE && avgBrightness < MAX_BRIGHTNESS;
  const hasColor = avgSaturation > MIN_COLOR_SATURATION;

  return { isPhoto, hasColor, avgBrightness, variance, avgSaturation };
}

/**
 * Detect horizontal separator lines
 */
function detectPhotoRegions(canvas: Canvas): PhotoRegion[] {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  const rowBrightness: number[] = [];

  for (let y = 0; y < height; y++) {
    const rowData = ctx.getImageData(0, y, width, 1).data;
    let sum = 0;
    for (let x = 0; x < width * 4; x += 4) {
      const gray = rowData[x] * 0.299 + rowData[x + 1] * 0.587 + rowData[x + 2] * 0.114;
      sum += gray;
    }
    rowBrightness.push(sum / width);
  }

  const isSeparator: boolean[] = rowBrightness.map((b) => b >= SPLIT_LINE_BRIGHTNESS);

  const regions: PhotoRegion[] = [];
  let regionStart = -1;
  let separatorCount = 0;

  for (let y = 0; y < height; y++) {
    if (isSeparator[y]) {
      separatorCount++;
      if (regionStart !== -1 && separatorCount >= MIN_SEPARATOR_HEIGHT) {
        const regionHeight = y - separatorCount + 1 - regionStart;
        if (regionHeight >= MIN_PHOTO_HEIGHT) {
          regions.push({ y: regionStart, height: regionHeight });
        }
        regionStart = -1;
      }
    } else {
      separatorCount = 0;
      if (regionStart === -1) {
        regionStart = y;
      }
    }
  }

  if (regionStart !== -1) {
    const regionHeight = height - regionStart;
    if (regionHeight >= MIN_PHOTO_HEIGHT) {
      regions.push({ y: regionStart, height: regionHeight });
    }
  }

  return regions;
}

/**
 * Detect vertical separator lines
 */
function detectVerticalRegions(canvas: Canvas): { x: number; width: number }[] {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  const colBrightness: number[] = [];

  for (let x = 0; x < width; x++) {
    const colData = ctx.getImageData(x, 0, 1, height).data;
    let sum = 0;
    for (let y = 0; y < height * 4; y += 4) {
      const gray = colData[y] * 0.299 + colData[y + 1] * 0.587 + colData[y + 2] * 0.114;
      sum += gray;
    }
    colBrightness.push(sum / height);
  }

  const isSeparator: boolean[] = colBrightness.map((b) => b >= SPLIT_LINE_BRIGHTNESS);

  const regions: { x: number; width: number }[] = [];
  let regionStart = -1;
  let separatorCount = 0;
  const MIN_VERTICAL_SEPARATOR = 3;
  const MIN_PHOTO_WIDTH = 100;

  for (let x = 0; x < width; x++) {
    if (isSeparator[x]) {
      separatorCount++;
      if (regionStart !== -1 && separatorCount >= MIN_VERTICAL_SEPARATOR) {
        const regionWidth = x - separatorCount + 1 - regionStart;
        if (regionWidth >= MIN_PHOTO_WIDTH) {
          regions.push({ x: regionStart, width: regionWidth });
        }
        regionStart = -1;
      }
    } else {
      separatorCount = 0;
      if (regionStart === -1) {
        regionStart = x;
      }
    }
  }

  if (regionStart !== -1) {
    const regionWidth = width - regionStart;
    if (regionWidth >= MIN_PHOTO_WIDTH) {
      regions.push({ x: regionStart, width: regionWidth });
    }
  }

  return regions;
}

/**
 * Trim white borders from a canvas
 */
function trimWhiteBorders(canvas: Canvas): Canvas {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  const TRIM_THRESHOLD = 245;
  const MIN_CONTENT_PERCENT = 0.05;

  const rowHasContent = (y: number): boolean => {
    let nonWhiteCount = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const gray = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
      if (gray < TRIM_THRESHOLD) {
        nonWhiteCount++;
      }
    }
    return nonWhiteCount / width >= MIN_CONTENT_PERCENT;
  };

  const colHasContent = (x: number, startY: number, endY: number): boolean => {
    let nonWhiteCount = 0;
    const colHeight = endY - startY + 1;
    for (let y = startY; y <= endY; y++) {
      const idx = (y * width + x) * 4;
      const gray = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
      if (gray < TRIM_THRESHOLD) {
        nonWhiteCount++;
      }
    }
    return nonWhiteCount / colHeight >= MIN_CONTENT_PERCENT;
  };

  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;

  for (let y = 0; y < height; y++) {
    if (rowHasContent(y)) {
      top = y;
      break;
    }
  }

  for (let y = height - 1; y >= 0; y--) {
    if (rowHasContent(y)) {
      bottom = y;
      break;
    }
  }

  for (let x = 0; x < width; x++) {
    if (colHasContent(x, top, bottom)) {
      left = x;
      break;
    }
  }

  for (let x = width - 1; x >= 0; x--) {
    if (colHasContent(x, top, bottom)) {
      right = x;
      break;
    }
  }

  const newWidth = Math.max(1, right - left + 1);
  const newHeight = Math.max(1, bottom - top + 1);

  if (newWidth >= width - 4 && newHeight >= height - 4) {
    return canvas;
  }

  const trimmedCanvas = createCanvas(newWidth, newHeight);
  const trimmedCtx = trimmedCanvas.getContext("2d");
  trimmedCtx.drawImage(canvas, left, top, newWidth, newHeight, 0, 0, newWidth, newHeight);

  return trimmedCanvas;
}

/**
 * Split an image into multiple photos if separators are detected
 */
async function splitIntoPhotos(imagePath: string): Promise<Canvas[]> {
  const img = await loadImage(imagePath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  const hRegions = detectPhotoRegions(canvas);
  const allPhotos: Canvas[] = [];
  const regionsToProcess = hRegions.length > 0 ? hRegions : [{ y: 0, height: img.height }];

  for (const hRegion of regionsToProcess) {
    const stripCanvas = createCanvas(img.width, hRegion.height);
    const stripCtx = stripCanvas.getContext("2d");
    stripCtx.drawImage(
      img,
      0,
      hRegion.y,
      img.width,
      hRegion.height,
      0,
      0,
      img.width,
      hRegion.height
    );

    const vRegions = detectVerticalRegions(stripCanvas);

    if (vRegions.length > 1) {
      for (const vRegion of vRegions) {
        const photoCanvas = createCanvas(vRegion.width, hRegion.height);
        const photoCtx = photoCanvas.getContext("2d");
        photoCtx.drawImage(
          stripCanvas,
          vRegion.x,
          0,
          vRegion.width,
          hRegion.height,
          0,
          0,
          vRegion.width,
          hRegion.height
        );
        const trimmed = trimWhiteBorders(photoCanvas);
        allPhotos.push(trimmed);
      }
    } else {
      const trimmed = trimWhiteBorders(stripCanvas);
      allPhotos.push(trimmed);
    }
  }

  if (allPhotos.length === 0) {
    return [trimWhiteBorders(canvas)];
  }

  return allPhotos;
}

/**
 * Extract color photos from a PDF buffer
 * Uses pdfimages tool, filters for color photos, splits composite images, trims borders
 * @param pdfBuffer - PDF file as Buffer
 * @param documentId - Unique identifier for this document (used in S3 keys)
 * @returns Array of extracted photos with S3 keys
 */
async function extractPhotosFromPdf(
  pdfBuffer: Buffer,
  documentId: string
): Promise<ExtractedPhoto[]> {
  const tempDir = path.join(os.tmpdir(), `pdfimages-${crypto.randomUUID()}`);

  try {
    fs.mkdirSync(tempDir, { recursive: true });

    // Write PDF to temp file
    const pdfPath = path.join(tempDir, "document.pdf");
    fs.writeFileSync(pdfPath, pdfBuffer);

    // Use pdfimages tool to extract raw JPEG images
    logger.log("Extracting images from PDF with pdfimages", { documentId });
    try {
      execSync(`pdfimages -j "${pdfPath}" "${tempDir}/img"`, { stdio: "pipe" });
    } catch (error) {
      logger.warn("pdfimages command failed", error, { documentId });
      return [];
    }

    // Get all extracted JPEG files
    const jpegFiles = fs
      .readdirSync(tempDir)
      .filter((f) => f.endsWith(".jpg"))
      .sort();

    logger.log("Found raw images in PDF", { documentId, count: jpegFiles.length });

    const extractedPhotos: ExtractedPhoto[] = [];
    let photoIndex = 0;

    for (const file of jpegFiles) {
      const srcPath = path.join(tempDir, file);

      try {
        const analysis = await analyzeImageFile(srcPath);

        if (analysis.isPhoto && analysis.hasColor) {
          const photos = await splitIntoPhotos(srcPath);

          logger.log("Found color photo in PDF", {
            documentId,
            file,
            variance: Math.round(analysis.variance),
            brightness: Math.round(analysis.avgBrightness),
            saturation: Math.round(analysis.avgSaturation),
            splitCount: photos.length,
          });

          for (const photoCanvas of photos) {
            const buffer = photoCanvas.toBuffer("image/jpeg", { quality: 0.9 });
            const s3Key = `images/${documentId}-photo-${photoIndex}.jpg`;

            await S3Service.uploadFile(buffer, s3Key, "image/jpeg");

            extractedPhotos.push({
              s3Key,
              width: photoCanvas.width,
              height: photoCanvas.height,
              index: photoIndex,
            });

            photoIndex++;
          }
        }
      } catch (err) {
        logger.warn("Error analyzing image from PDF", err, { documentId, file });
      }
    }

    logger.log("PDF photo extraction complete", {
      documentId,
      totalRawImages: jpegFiles.length,
      extractedPhotos: extractedPhotos.length,
    });

    return extractedPhotos;
  } finally {
    // Cleanup temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

export const PdfImageService = {
  extractPhotosFromPdf,
};
