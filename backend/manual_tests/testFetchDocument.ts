import { AiExtractService } from "../services/AiExtractService.js";

async function testFetchDocument() {
  const doc = {
    description: "Test Document",
    url: "https://www.ajpes.si/eObjave/datoteka.asp?id=6931551&d=22312262",
  };

  console.log("Testing fetchAndAppendDocument...");
  console.log(`Document URL: ${doc.url}`);
  console.log("");

  const result = await AiExtractService.fetchDocument(
    doc,
    "https://www.ajpes.si/test-announcement",
    "test"
  );

  if (result) {
    console.log("\n=== Result ===");
    console.log(`Description: ${result.description}`);
    console.log(`URL: ${result.url}`);
    console.log(`Type: ${result.type}`);
    console.log(`OCR Used: ${result.ocrUsed}`);
    console.log(`Content Length: ${result.markdown?.length || 0} characters`);
    console.log("\n=== Content Preview (first 500 chars) ===");
    console.log(result.markdown?.substring(0, 500) || "No content");
  } else {
    console.log("Failed to fetch document");
  }

  await AiExtractService.closeBrowser();
}

testFetchDocument().catch(console.error);
