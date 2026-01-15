import { createCanvas, type Canvas } from "canvas";
import crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
// @ts-ignore
import * as pdfjsLib from "pdfjs-dist";
import pdf2mdModule from "@opendocsg/pdf2md";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { createWorker } from "tesseract.js";
import { S3Service } from "./S3Service.js";
import { logger } from "../utils/logger.js";
import { DocumentResult, ExtractedPhoto } from "../types/DocumentResult.js";
import { FetchDocumentResult, FetchDocumentsResult } from "../types/FetchDocumentResult.js";

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
 * @param docUrl - Unique identifier for this document (used in S3 keys)
 * @returns Array of extracted photos with S3 keys
 */
async function extractPhotosFromPdf(pdfBuffer: Buffer, docUrl: string): Promise<ExtractedPhoto[]> {
  logger.log("Extracting images from PDF with pdfjs", { docUrl });

  try {
    // Load PDF with pdfjs-dist
    const pdfDoc = await pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
    }).promise;

    logger.log("PDF loaded for image extraction", {
      docUrl,
      numPages: pdfDoc.numPages,
    });

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
                  docUrl,
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
                  const s3Key = `images/doc-photo-${photoIndex}.jpg`;

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
        logger.warn("Error processing PDF page for images", pageErr, {
          documentId: docUrl,
          pageNum,
        });
      }
    }

    logger.log("PDF photo extraction complete", {
      documentId: docUrl,
      totalPages: pdfDoc.numPages,
      extractedPhotos: extractedPhotos.length,
    });

    return extractedPhotos;
  } catch (err) {
    logger.warn("Failed to extract photos from PDF", err, { documentId: docUrl });
    return [];
  }
}

/**
 * Convert PDF to markdown
 * First attempts text extraction, falls back to OCR (Tesseract) if PDF is scanned
 */
async function pdfToMarkdown(buffer: Buffer): Promise<string | undefined> {
  // First try normal text extraction
  const pdfMarkdown = await pdf2mdModule(buffer);

  // Check if text was extracted (more than just whitespace)
  const textContent = pdfMarkdown.replace(/\s+/g, "").trim();
  if (textContent.length > 50) {
    return pdfMarkdown;
  }
}

async function ocrPdfToMarkdown(buffer: Buffer): Promise<{ content: string }> {
  // No text found, perform OCR
  logger.log("PDF without text, performing OCR...");

  try {
    const ocrResults: string[] = [];

    // Custom canvas factory for pdfjs-dist in Node.js
    const canvasFactory = {
      create: (width: number, height: number) => {
        const canvas = createCanvas(width, height);
        return { canvas, context: canvas.getContext("2d") };
      },
      reset: (canvasAndContext: any, width: number, height: number) => {
        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
      },
      destroy: (canvasAndContext: any) => {
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
      },
    };

    // Load PDF with pdfjs-dist - convert Buffer to Uint8Array
    const pdfDoc = await pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      canvasFactory,
    }).promise;
    const worker = await createWorker("slv");

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      logger.log(`OCR processing page ${pageNum}/${pdfDoc.numPages}`, {
        pageNum,
        totalPages: pdfDoc.numPages,
      });

      const page = await pdfDoc.getPage(pageNum);
      const scale = 2;
      const viewport = page.getViewport({ scale });

      // Create canvas and render page
      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext("2d");

      await page.render({
        // @ts-ignore - canvas context types differ slightly
        canvasContext: context,
        viewport,
        canvasFactory,
      }).promise;

      // Convert canvas to PNG buffer for OCR
      const imageBuffer = canvas.toBuffer("image/png");

      const { data } = await worker.recognize(imageBuffer);
      if (data.text.trim()) {
        ocrResults.push(data.text);
      }
    }

    await worker.terminate();

    if (ocrResults.length > 0) {
      logger.log("OCR successful", { pagesRecognized: ocrResults.length });
      return { content: ocrResults.join("\n\n") };
    }

    logger.warn("OCR found no text", { totalPages: pdfDoc.numPages });
  } catch (ocrErr) {
    logger.warn("OCR error", ocrErr);
  }
}

/**
 * Convert DOCX document to markdown
 * First converts to HTML using mammoth, then to markdown with Turndown
 */
async function docxToMarkdown(buffer: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
    }
  );
  const turndownService = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
  });
  return turndownService.turndown(result.value);
}

/**
 * Download a document (PDF/DOCX) and convert to markdown
 * Uses OCR for scanned PDFs if needed
 */
async function fetchDocument(
  doc: {
    description: string;
    url: string;
  },
  announcementUrl: string,
  dataSourceCode: string,
  cookies?: string
): Promise<FetchDocumentResult | null> {
  try {
    logger.log("Downloading document", {
      document: doc.description,
      documentUrl: doc.url,
      announcementUrl,
      dataSourceCode,
    });

    const headers: HeadersInit = {};
    if (cookies) {
      headers["Cookie"] = cookies;
    }

    const docResponse = await fetch(doc.url, { headers });

    if (!docResponse.ok) {
      logger.warn("Failed to download document", new Error(`HTTP ${docResponse.status}`), {
        document: doc.description,
        documentUrl: doc.url,
        httpStatus: docResponse.status,
        announcementUrl,
        dataSourceCode,
      });
      return null;
    }

    const contentType = docResponse.headers.get("content-type") || "";
    const urlLower = doc.url.toLowerCase();
    const buffer = Buffer.from(await docResponse.arrayBuffer());

    logger.log("Document downloaded", {
      document: doc.description,
      sizeKB: (buffer.length / 1024).toFixed(2),
      contentType,
      announcementUrl,
      dataSourceCode,
    });

    let docType: "pdf" | "docx" | "unknown" = "unknown";
    let content: string | null = null;
    let ocrUsed = false;

    if (
      contentType.includes("wordprocessingml") ||
      contentType.includes("msword") ||
      urlLower.endsWith(".docx") ||
      urlLower.endsWith(".doc")
    ) {
      docType = "docx";
      content = await docxToMarkdown(buffer);
    } else {
      docType = "pdf";
      content = await pdfToMarkdown(buffer);
    }

    if (content) {
      logger.log(`Document converted to markdown${ocrUsed ? " (OCR)" : ""}`, {
        document: doc.description,
        announcementUrl,
        dataSourceCode,
      });
    } else {
      logger.info(`Document has no content`, {
        document: doc.description,
        documentUrl: doc.url,
        docType,
        bufferSize: buffer.length,
        announcementUrl,
        dataSourceCode,
      });
    }

    // Generate S3 key using UUID and upload to S3
    const uuid = crypto.randomUUID();
    const extension = docType === "docx" ? "docx" : "pdf";
    const s3Key = `documents/${uuid}.${extension}`;
    const contentTypeForS3 =
      docType === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/pdf";

    const localUrl = await S3Service.uploadFile(buffer, s3Key, contentTypeForS3);

    // Save document to tmp folder for potential OCR processing later
    const tmpFilePath = path.join(os.tmpdir(), `${uuid}.${extension}`);
    fs.writeFileSync(tmpFilePath, buffer);

    logger.log("Document uploaded to S3 and saved to tmp", {
      document: doc.description,
      localUrl,
      announcementUrl,
      dataSourceCode,
    });

    return {
      document: {
        description: doc.description,
        url: doc.url,
        localUrl,
        type: docType,
        markdown: content,
        tmpFilePath,
      },
    };
  } catch (docErr: any) {
    logger.warn("Document processing error", docErr, {
      document: doc.description,
      documentUrl: doc.url,
      announcementUrl,
      dataSourceCode,
    });
    return null;
  }
}

/**
 * Process multiple documents in parallel
 * Continues processing even if individual documents fail
 * Returns documents and extracted photos separately
 */
async function fetchDocuments(
  linksToDocuments: Array<{ description: string; url: string }>,
  announcementUrl: string,
  dataSourceCode: string,
  cookies: string
): Promise<FetchDocumentsResult> {
  logger.log(`Processing ${linksToDocuments.length} documents in parallel`, {
    count: linksToDocuments.length,
    documents: linksToDocuments.map((d) => d.description),
    announcementUrl,
    dataSourceCode,
  });

  const promises = linksToDocuments.map(async (doc) => {
    try {
      const result = await fetchDocument(doc, announcementUrl, dataSourceCode, cookies);
      if (result) {
        logger.log("Document processed", {
          document: doc.description,
          contentLength: result.document.markdown?.length || 0,
          announcementUrl,
          dataSourceCode,
        });
      }

      return result;
    } catch (error) {
      logger.warn("Failed to process document", error, {
        document: doc.description,
        announcementUrl,
        dataSourceCode,
      });
      return null;
    }
  });

  const settledResults = await Promise.all(promises);
  const validResults = settledResults.filter((r): r is FetchDocumentResult => r !== null);

  const documents = validResults.map((r) => r.document);

  logger.log("All documents processed", {
    total: linksToDocuments.length,
    successful: documents.length,
    failed: linksToDocuments.length - documents.length,
    announcementUrl,
    dataSourceCode,
  });

  return { documents };
}

export const DocumentService = {
  extractPhotosFromPdf,
  fetchDocument,
  fetchDocuments,
  ocrPdfToMarkdown,
};
