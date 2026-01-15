import * as fs from "fs";
import * as path from "path";
import { PdfImageService } from "../services/PdfImageService.js";

//const PDF_PATH = path.join(process.cwd(), "..", "n-41-2023-izvedensko-poroilo-1.pdf");
//const PDF_PATH = path.join(process.cwd(), "..", "4136-puc-postojna-odgovori-.pdf");
//const PDF_PATH = path.join(process.cwd(), "..", "4136-puc-postojna.pdf");
//const PDF_PATH = path.join(process.cwd(),"..","cenilno-poroilo-z-dne-10.-4.-2024-i-2243-2021.pdf");
//const PDF_PATH = path.join(process.cwd(), "..", "cenitveno-porocilo-gotovlje-zalec.pdf");
//const PDF_PATH = path.join(process.cwd(), "..", "i-203.2021-cenilno-porocilo.pdf");
//const PDF_PATH = path.join(process.cwd(), "..", "i-2523-2023-cp-4032-31.pdf");
const PDF_PATH = path.join(process.cwd(), "..", "i249-2025-cenitev.pdf");

async function testPdfImageExtraction() {
  console.log("Testing PDF Image Extraction...");
  console.log(`PDF Path: ${PDF_PATH}`);
  console.log("");

  // Check if file exists
  if (!fs.existsSync(PDF_PATH)) {
    console.error(`PDF file not found: ${PDF_PATH}`);
    console.log("Make pdf is in the project root directory");
    process.exit(1);
  }

  // Read PDF file
  const pdfBuffer = fs.readFileSync(PDF_PATH);
  console.log(`PDF size: ${(pdfBuffer.length / 1024).toFixed(2)} KB`);
  console.log("");

  // Extract photos
  const documentId = "test-pdf-extraction";
  console.log("Extracting photos from PDF...\n");

  const startTime = Date.now();
  const photos = await PdfImageService.extractPhotosFromPdf(pdfBuffer, documentId);
  const duration = Date.now() - startTime;

  console.log("\n=== Results ===");
  console.log(`Total photos extracted: ${photos.length}`);
  console.log(`Duration: ${(duration / 1000).toFixed(2)} seconds`);
  console.log("");

  if (photos.length > 0) {
    console.log("=== Extracted Photos ===");
    for (const photo of photos) {
      console.log(`  ${photo.index}: ${photo.s3Key} (${photo.width}x${photo.height})`);
    }
  } else {
    console.log("No photos were extracted from the PDF.");
  }
}

testPdfImageExtraction().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
