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
    cadastralMunicipality: "1964",
    number: "109/196",
  });

  await ProstorService.closeBrowser();

  if (result) {
    console.log(`Screenshot saved to: ${result}`);
  } else {
    console.error("Failed to capture screenshot");
  }

  // Process building if available
  if (result?.building) {
    console.log("\nFound building on parcel\n", JSON.stringify(result.building, null, 2), "\n");
  }
}

test().catch(console.error);
