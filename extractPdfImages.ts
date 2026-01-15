import * as fs from "fs";
import * as path from "path";
import { createCanvas, loadImage } from "canvas";
import { execSync } from "child_process";

const PDF_PATH = "n-41-2023-izvedensko-poroilo-1.pdf";
const OUTPUT_DIR = "extracted-images";
const TEMP_DIR = "pdfimages-temp";

// Thresholds for filtering out mostly-white/empty images
const MIN_COLOR_VARIANCE = 1500; // Minimum variance to be considered a photo
const MAX_BRIGHTNESS = 240; // Maximum average brightness (255 = white)
const MIN_COLOR_SATURATION = 5; // Minimum average saturation to be considered color (not grayscale)

/**
 * Analyze image to determine if it's mostly white/empty or contains actual photo content
 * Also checks if the image has color (not grayscale)
 */
async function analyzeImageFile(
  imagePath: string
): Promise<{
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
        const filename = `page${pageNum.toString().padStart(2, "0")}.jpg`;
        const destPath = path.join(OUTPUT_DIR, filename);

        fs.copyFileSync(srcPath, destPath);

        // Get image dimensions
        const img = await loadImage(srcPath);

        extractedImages.push({
          page: pageNum,
          index: 0,
          width: img.width,
          height: img.height,
          filename,
          variance: Math.round(analysis.variance),
          avgBrightness: Math.round(analysis.avgBrightness),
        });

        console.log(
          `  ✓ COLOR PHOTO: var=${Math.round(analysis.variance)}, bright=${Math.round(analysis.avgBrightness)}, sat=${Math.round(analysis.avgSaturation)} -> Saved: ${filename}`
        );
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
