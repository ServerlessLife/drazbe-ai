import { ParcelScreenshotService } from "../services/ParcelScreenshotService.js";

async function test() {
  console.log("Capturing parcel screenshot...\n");

  // const result = await ParcelScreenshotService.captureParcelScreenshot({
  //   type: "parcel",
  //   cadastralMunicipality: "1672",
  //   number: "90/6",
  // });

  const result = await ParcelScreenshotService.captureParcelScreenshot({
    type: "parcel",
    cadastralMunicipality: "1959",
    number: "670/20",
  });

  await ParcelScreenshotService.closeBrowser();

  if (result) {
    console.log(`Screenshot saved to: ${result}`);
  } else {
    console.error("Failed to capture screenshot");
  }
}

test().catch(console.error);
