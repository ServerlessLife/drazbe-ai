import * as fs from "fs";
import * as path from "path";
import { createCanvas, loadImage, type Canvas } from "canvas";
import { execSync } from "child_process";

const PDF_PATH = "n-41-2023-izvedensko-poroilo-1.pdf";
const OUTPUT_DIR = "extracted-images";
const TEMP_DIR = "pdfimages-temp";

// Thresholds for filtering out mostly-white/empty images
const MIN_COLOR_VARIANCE = 1500; // Minimum variance to be considered a photo
const MAX_BRIGHTNESS = 240; // Maximum average brightness (255 = white)
const MIN_COLOR_SATURATION = 5; // Minimum average saturation to be considered color (not grayscale)

// Thresholds for splitting photos
const SPLIT_LINE_BRIGHTNESS = 240; // Brightness threshold to consider a line as separator
const MIN_SEPARATOR_HEIGHT = 5; // Minimum height of separator region
const MIN_PHOTO_HEIGHT = 50; // Minimum height for a valid photo region

/**
 * Analyze image to determine if it's mostly white/empty or contains actual photo content
 * Also checks if the image has color (not grayscale)
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

  // Sample pixels for speed
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

    // Calculate saturation (difference between max and min RGB)
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

interface PhotoRegion {
  y: number;
  height: number;
}

/**
 * Detect horizontal separator lines and split image into individual photos
 * Returns array of { y, height } regions
 */
function detectPhotoRegions(canvas: Canvas): PhotoRegion[] {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  // Calculate average brightness for each row
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

  // Find separator regions (consecutive bright rows)
  const isSeparator: boolean[] = rowBrightness.map((b) => b >= SPLIT_LINE_BRIGHTNESS);

  // Find photo regions between separators
  const regions: PhotoRegion[] = [];
  let regionStart = -1;
  let separatorCount = 0;

  for (let y = 0; y < height; y++) {
    if (isSeparator[y]) {
      separatorCount++;
      if (regionStart !== -1 && separatorCount >= MIN_SEPARATOR_HEIGHT) {
        // End of a photo region
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

  // Handle last region
  if (regionStart !== -1) {
    const regionHeight = height - regionStart;
    if (regionHeight >= MIN_PHOTO_HEIGHT) {
      regions.push({ y: regionStart, height: regionHeight });
    }
  }

  return regions;
}

/**
 * Detect vertical separator lines to split side-by-side photos
 * Returns array of { x, width } regions
 */
function detectVerticalRegions(canvas: Canvas): { x: number; width: number }[] {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  // Calculate average brightness for each column
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

  // Find separator regions (consecutive bright columns)
  const isSeparator: boolean[] = colBrightness.map((b) => b >= SPLIT_LINE_BRIGHTNESS);

  // Find photo regions between separators
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

  // Handle last region
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
 * Uses percentage-based detection to handle noise pixels
 */
function trimWhiteBorders(canvas: Canvas): Canvas {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  const TRIM_THRESHOLD = 245; // Brightness threshold for white
  const MIN_CONTENT_PERCENT = 0.05; // 5% of pixels must be non-white to count as content

  // Helper to check if a row has enough content
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

  // Helper to check if a column has enough content
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

  // Find bounds
  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;

  // Find top edge
  for (let y = 0; y < height; y++) {
    if (rowHasContent(y)) {
      top = y;
      break;
    }
  }

  // Find bottom edge
  for (let y = height - 1; y >= 0; y--) {
    if (rowHasContent(y)) {
      bottom = y;
      break;
    }
  }

  // Find left edge
  for (let x = 0; x < width; x++) {
    if (colHasContent(x, top, bottom)) {
      left = x;
      break;
    }
  }

  // Find right edge
  for (let x = width - 1; x >= 0; x--) {
    if (colHasContent(x, top, bottom)) {
      right = x;
      break;
    }
  }

  // Ensure valid bounds
  const newWidth = Math.max(1, right - left + 1);
  const newHeight = Math.max(1, bottom - top + 1);

  // If barely any trimming needed, return original
  if (newWidth >= width - 4 && newHeight >= height - 4) {
    return canvas;
  }

  // Create trimmed canvas
  const trimmedCanvas = createCanvas(newWidth, newHeight);
  const trimmedCtx = trimmedCanvas.getContext("2d");
  trimmedCtx.drawImage(canvas, left, top, newWidth, newHeight, 0, 0, newWidth, newHeight);

  return trimmedCanvas;
}

/**
 * Split an image into multiple photos if separators are detected
 * Returns array of canvas objects for each photo
 */
async function splitIntoPhotos(imagePath: string): Promise<Canvas[]> {
  const img = await loadImage(imagePath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);

  // First split horizontally
  const hRegions = detectPhotoRegions(canvas);

  const allPhotos: Canvas[] = [];

  // For each horizontal region, check for vertical splits
  const regionsToProcess = hRegions.length > 0 ? hRegions : [{ y: 0, height: img.height }];

  for (const hRegion of regionsToProcess) {
    // Extract horizontal strip
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

    // Check for vertical splits in this strip
    const vRegions = detectVerticalRegions(stripCanvas);

    if (vRegions.length > 1) {
      // Multiple photos side by side
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
        // Trim white borders
        const trimmed = trimWhiteBorders(photoCanvas);
        allPhotos.push(trimmed);
      }
    } else {
      // Single photo in this strip, trim borders
      const trimmed = trimWhiteBorders(stripCanvas);
      allPhotos.push(trimmed);
    }
  }

  // If no splitting happened, return trimmed original
  if (allPhotos.length === 0) {
    return [trimWhiteBorders(canvas)];
  }

  return allPhotos;
}

interface ImageInfo {
  page: number;
  index: number;
  width: number;
  height: number;
  filename: string;
  variance: number;
  avgBrightness: number;
}

async function extractImagesFromPdf(pdfPath: string): Promise<ImageInfo[]> {
  console.log(`Extracting images from PDF: ${pdfPath}`);

  // Create output directories
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  // Use pdfimages tool to extract raw JPEG images
  console.log("Using pdfimages tool to extract raw images...");
  try {
    execSync(`pdfimages -j "${pdfPath}" "${TEMP_DIR}/img"`, { stdio: "pipe" });
  } catch (error) {
    console.error("Error running pdfimages. Make sure poppler-utils is installed.");
    throw error;
  }

  // Get all extracted JPEG files
  const jpegFiles = fs
    .readdirSync(TEMP_DIR)
    .filter((f) => f.endsWith(".jpg"))
    .sort();

  console.log(`Found ${jpegFiles.length} raw images`);
  console.log(
    `Filtering: variance > ${MIN_COLOR_VARIANCE}, brightness < ${MAX_BRIGHTNESS}, saturation > ${MIN_COLOR_SATURATION}\n`
  );

  const extractedImages: ImageInfo[] = [];
  const skippedImages: {
    file: string;
    reason: string;
    variance: number;
    brightness: number;
    saturation: number;
  }[] = [];

  for (let i = 0; i < jpegFiles.length; i++) {
    const file = jpegFiles[i];
    const srcPath = path.join(TEMP_DIR, file);

    // Extract page number from filename (img-XXX.jpg)
    const match = file.match(/img-(\d+)\.jpg/);
    const pageNum = match ? parseInt(match[1]) + 1 : i + 1;

    console.log(`Analyzing ${file} (page ~${pageNum})...`);

    try {
      const analysis = await analyzeImageFile(srcPath);

      if (analysis.isPhoto && analysis.hasColor) {
        // Split into individual photos if multiple are detected
        const photos = await splitIntoPhotos(srcPath);

        console.log(
          `  ✓ COLOR PHOTO: var=${Math.round(analysis.variance)}, bright=${Math.round(analysis.avgBrightness)}, sat=${Math.round(analysis.avgSaturation)}`
        );

        if (photos.length > 1) {
          console.log(`    → Detected ${photos.length} separate photos, splitting...`);
        }

        for (let photoIdx = 0; photoIdx < photos.length; photoIdx++) {
          const photoCanvas = photos[photoIdx];
          const suffix = photos.length > 1 ? String.fromCharCode(97 + photoIdx) : ""; // a, b, c...
          const filename = `page${pageNum.toString().padStart(2, "0")}${suffix}.jpg`;
          const destPath = path.join(OUTPUT_DIR, filename);

          const buffer = photoCanvas.toBuffer("image/jpeg", { quality: 0.95 });
          fs.writeFileSync(destPath, buffer);

          extractedImages.push({
            page: pageNum,
            index: photoIdx,
            width: photoCanvas.width,
            height: photoCanvas.height,
            filename,
            variance: Math.round(analysis.variance),
            avgBrightness: Math.round(analysis.avgBrightness),
          });

          console.log(`    → Saved: ${filename} (${photoCanvas.width}x${photoCanvas.height})`);
        }
      } else {
        const reason = !analysis.isPhoto ? "white/low-var" : "grayscale";
        skippedImages.push({
          file,
          reason,
          variance: Math.round(analysis.variance),
          brightness: Math.round(analysis.avgBrightness),
          saturation: Math.round(analysis.avgSaturation),
        });
        console.log(
          `  ✗ SKIP (${reason}): var=${Math.round(analysis.variance)}, bright=${Math.round(analysis.avgBrightness)}, sat=${Math.round(analysis.avgSaturation)}`
        );
      }
    } catch (err) {
      console.log(`  ✗ ERROR: Could not analyze ${file}: ${err}`);
    }
  }

  // Cleanup temp directory
  console.log("\nCleaning up temporary files...");
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log(`\n--- Summary ---`);
  console.log(`Total raw images: ${jpegFiles.length}`);
  console.log(`Color photos extracted: ${extractedImages.length}`);
  console.log(`Skipped: ${skippedImages.length}`);

  return extractedImages;
}

async function main() {
  console.log("PDF Image Extractor");
  console.log("===================\n");

  try {
    const images = await extractImagesFromPdf(PDF_PATH);

    console.log("\n===================");
    console.log(`Extraction complete!`);
    console.log(`Total images extracted: ${images.length}`);
    console.log(`Output directory: ${OUTPUT_DIR}/`);

    if (images.length > 0) {
      console.log("\nExtracted images:");
      for (const img of images) {
        console.log(`  - ${img.filename}: ${img.width}x${img.height} (page ${img.page})`);
      }
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
