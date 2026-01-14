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
    cadastralMunicipality: "1959",
    number: "670/20",
  });

  await ProstorService.closeBrowser();

  if (result) {
    console.log(`Screenshot saved to: ${result}`);
  } else {
    console.error("Failed to capture screenshot");
  }
}

test().catch(console.error);
