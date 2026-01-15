import { ProstorService } from "../services/ProstorService.js";

async function test() {
  console.log("Capturing parcel screenshot...\n");

  // const result = await ParcelScreenshotService.captureParcelScreenshot({
  //   type: "parcel",
  //   cadastralMunicipality: "1672",
  //   number: "90/6",
  // });

  const result = await ProstorService.processProperty({
    type: "parcel",
    cadastralMunicipality: "2302",
    number: "305/5",
  });

  await ProstorService.closeBrowser();

  if (result) {
    console.log(`Screenshot saved to: ${result.outputPath}`);
  } else {
    console.error("Failed to capture screenshot");
  }

  // Process buildings if available
  if (result?.buildings?.length > 0) {
    console.log("\nFound buildings on parcel:\n", JSON.stringify(result.buildings, null, 2), "\n");
  }
}

test().catch(console.error);
