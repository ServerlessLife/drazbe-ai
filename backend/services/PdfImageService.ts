import { createCanvas, type Canvas, loadImage } from "canvas";
// @ts-ignore
import * as pdfjsLib from "pdfjs-dist";
// @ts-ignore
import { OPS } from "pdfjs-dist/lib/core/primitives.js";
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

// Thresholds for image size/shape filtering
const MIN_IMAGE_WIDTH = 200;
const MIN_IMAGE_HEIGHT = 200;
const MAX_ASPECT_RATIO = 4; // Reject images with aspect ratio > 4:1 (strips)
const MIN_IMAGE_PIXELS = 100000; // Minimum 100k pixels (e.g., ~316x316)

interface PhotoRegion {
  y: number;
  height: number;
}

/**
 * Analyze canvas to determine if it's a color photo
 */
function analyzeCanvas(canvas: Canvas): {
  isPhoto: boolean;
  hasColor: boolean;
  avgBrightness: number;
  variance: number;
  avgSaturation: number;
} {
  const ctx = canvas.getContext("2d");
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
 * Split a canvas into multiple photos if separators are detected
 */
function splitIntoPhotos(canvas: Canvas): Canvas[] {
  const hRegions = detectPhotoRegions(canvas);
  const allPhotos: Canvas[] = [];
  const regionsToProcess = hRegions.length > 0 ? hRegions : [{ y: 0, height: canvas.height }];

  for (const hRegion of regionsToProcess) {
    const stripCanvas = createCanvas(canvas.width, hRegion.height);
    const stripCtx = stripCanvas.getContext("2d");
    stripCtx.drawImage(
      canvas,
      0,
      hRegion.y,
      canvas.width,
      hRegion.height,
      0,
      0,
      canvas.width,
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
 * Convert raw image data to a canvas
 */
function imageDataToCanvas(imgData: any): Canvas | null {
  try {
    const { width, height, data } = imgData;
    if (!width || !height || !data) return null;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(width, height);

    // Handle different data formats
    if (data.length === width * height * 4) {
      // RGBA format
      imageData.data.set(data);
    } else if (data.length === width * height * 3) {
      // RGB format - convert to RGBA
      for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
        imageData.data[j] = data[i]; // R
        imageData.data[j + 1] = data[i + 1]; // G
        imageData.data[j + 2] = data[i + 2]; // B
        imageData.data[j + 3] = 255; // A
      }
    } else if (data.length === width * height) {
      // Grayscale - convert to RGBA
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        imageData.data[j] = data[i]; // R
        imageData.data[j + 1] = data[i]; // G
        imageData.data[j + 2] = data[i]; // B
        imageData.data[j + 3] = 255; // A
      }
    } else {
      return null;
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  } catch {
    return null;
  }
}

/**
 * Extract color photos from a PDF buffer
 * Extracts embedded images directly from the PDF (preserving native orientation)
 * @param pdfBuffer - PDF file as Buffer
 * @param documentId - Unique identifier for this document (used in S3 keys)
 * @returns Array of extracted photos with S3 keys
 */
async function extractPhotosFromPdf(
  pdfBuffer: Buffer,
  documentId: string
): Promise<ExtractedPhoto[]> {
  logger.log("Extracting images from PDF with pdfjs", { documentId });

  try {
    // Load PDF with pdfjs-dist
    const pdfDoc = await pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
    }).promise;

    logger.log("PDF loaded for image extraction", { documentId, numPages: pdfDoc.numPages });

    const extractedPhotos: ExtractedPhoto[] = [];
    let photoIndex = 0;
    const processedImages = new Set<string>();

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      try {
        const page = await pdfDoc.getPage(pageNum);
        const operatorList = await page.getOperatorList();

        // Find all image paint operations
        for (let i = 0; i < operatorList.fnArray.length; i++) {
          const fn = operatorList.fnArray[i];

          // Check for paintImageXObject operation (value 85 in pdfjs)
          if (fn === 85) {
            const imgName = operatorList.argsArray[i][0];

            // Skip if we've already processed this image
            if (processedImages.has(imgName)) continue;
            processedImages.add(imgName);

            try {
              // Get the image object
              const imgObj = await new Promise<any>((resolve, reject) => {
                page.objs.get(imgName, (obj: any) => {
                  if (obj) resolve(obj);
                  else reject(new Error("Image not found"));
                });
              });

              if (!imgObj || !imgObj.width || !imgObj.height) continue;

              // Skip images that don't meet size/shape requirements
              const width = imgObj.width;
              const height = imgObj.height;
              const aspectRatio = Math.max(width, height) / Math.min(width, height);
              const totalPixels = width * height;

              // Skip small images
              if (width < MIN_IMAGE_WIDTH || height < MIN_IMAGE_HEIGHT) continue;

              // Skip strip-like images (very narrow or very wide)
              if (aspectRatio > MAX_ASPECT_RATIO) continue;

              // Skip images with too few pixels
              if (totalPixels < MIN_IMAGE_PIXELS) continue;

              // Convert image data to canvas
              const canvas = imageDataToCanvas(imgObj);
              if (!canvas) continue;

              // Analyze if it's a color photo
              const analysis = analyzeCanvas(canvas);

              if (analysis.isPhoto && analysis.hasColor) {
                // Split into individual photos if needed
                const photos = splitIntoPhotos(canvas);

                logger.log("Found color photo in PDF", {
                  documentId,
                  pageNum,
                  imageName: imgName,
                  variance: Math.round(analysis.variance),
                  brightness: Math.round(analysis.avgBrightness),
                  saturation: Math.round(analysis.avgSaturation),
                  splitCount: photos.length,
                });

                for (const photoCanvas of photos) {
                  // Apply size/shape filters to split photos too
                  const pWidth = photoCanvas.width;
                  const pHeight = photoCanvas.height;
                  const pAspectRatio = Math.max(pWidth, pHeight) / Math.min(pWidth, pHeight);
                  const pTotalPixels = pWidth * pHeight;

                  // Skip split photos that are too small or strip-like
                  if (pWidth < MIN_IMAGE_WIDTH || pHeight < MIN_IMAGE_HEIGHT) continue;
                  if (pAspectRatio > MAX_ASPECT_RATIO) continue;
                  if (pTotalPixels < MIN_IMAGE_PIXELS) continue;

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
            } catch (imgErr) {
              // Skip images that can't be processed
            }
          }
        }
      } catch (pageErr) {
        logger.warn("Error processing PDF page for images", pageErr, { documentId, pageNum });
      }
    }

    logger.log("PDF photo extraction complete", {
      documentId,
      totalPages: pdfDoc.numPages,
      extractedPhotos: extractedPhotos.length,
    });

    return extractedPhotos;
  } catch (err) {
    logger.warn("Failed to extract photos from PDF", err, { documentId });
    return [];
  }
}

export const PdfImageService = {
  extractPhotosFromPdf,
};
