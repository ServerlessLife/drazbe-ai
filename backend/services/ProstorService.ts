import { Browser, Page } from "playwright-core";
import { launchBrowser } from "../utils/browser.js";
import { PropertyKey } from "../types/PropertyIdentifier.js";
import { logger } from "../utils/logger.js";

let browser: Browser | null = null;
let page: Page | null = null;

async function processProperty(query: PropertyKey): Promise<{
  outputPath?: string;
  buildings: PropertyKey[];
} | null> {
  logger.log("Capturing parcel screenshot", {
    type: query.type,
    municipality: query.cadastralMunicipality,
    number: query.number,
  });

  try {
    if (!browser) {
      const result = await launchBrowser();
      browser = result.browser;
      page = result.page;
    }

    // 1. Open the page
    logger.log("Opening eProstor page");
    await page.goto("https://ipi.eprostor.gov.si/jv/", { waitUntil: "networkidle" });

    // 2. Click the welcome dialog enter button
    logger.log("Clicking welcome dialog");
    await page.waitForSelector(".welcome-dialog__enter-button", { timeout: 10000 });
    await page.click(".welcome-dialog__enter-button");
    await page.waitForTimeout(1000);

    // 3. Enter the parcel number in search input
    // For building_part, extract only the building number (remove the part after /)
    let searchNumber = query.number;
    if (query.type === "building_part" && query.number.includes("/")) {
      searchNumber = query.number.split("/")[0];
    }
    const parcelInput = `${query.cadastralMunicipality}-${searchNumber}`;
    logger.log("Searching for property", { input: parcelInput });
    await page.waitForSelector('input[type="text"]', { timeout: 5000 });
    await page.fill('input[type="text"]', parcelInput);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);

    // 4. Click first .btn-link under the appropriate section (wait for search results)
    // For parcels: click under "Parcele" section
    // For building/building_part: click under "Stavbe" section
    // await page.waitForTimeout(2000);

    if (query.type === "parcel") {
      // Find the "Parcele" section and click first button within it
      logger.log("Selecting from Parcele section");
      const parcelSection = page
        .locator('.search-list-title:has-text("Parcele")')
        .locator("..")
        .locator(".btn-link")
        .first();
      await parcelSection.waitFor({ timeout: 10000 });
      await parcelSection.click();
    } else {
      // Find the "Stavbe" section and click first button within it
      logger.log("Selecting from Stavbe section");
      const buildingSection = page
        .locator('.search-list-title:has-text("Stavbe")')
        .locator("..")
        .locator(".btn-link")
        .first();
      await buildingSection.waitFor({ timeout: 10000 });
      await buildingSection.click();
    }

    // // Wait a bit for the map to load
    // await page.waitForTimeout(1000);

    // // 5. Click zoom in icon once
    // await page.click(".icon-lupa-plus");

    // Wait for zoom animation
    await page.waitForTimeout(3000);

    // 6. Take screenshot and crop to map area
    // Use /tmp for Lambda (read-only filesystem except /tmp)
    const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;
    const outputPath = isLambda ? "/tmp/parcel-screenshot.png" : "parcel-screenshot.png";
    logger.log(`Capturing screenshot at ${outputPath}`);
    await page.screenshot({
      path: outputPath,
      clip: { x: 119, y: 173, width: 785, height: 466 },
    });

    //await browser.close(); // do not close browser after each screenshot to improve performance
    logger.log("Screenshot captured successfully", { path: outputPath });

    const buildings: PropertyKey[] = [];

    if (query.type === "parcel") {
      const sectionTitle = page.locator(".plot-title-group", { hasText: "Stavbe na parceli" });
      //await expect(sectionTitle).toBeVisible();

      // 2) The table is inside the next ".list-group-item" container
      const sectionContainer = sectionTitle.locator(
        "xpath=ancestor::ul[contains(@class,'list-group-item')][1]"
      );

      // 3) Find the table for this section and extract numbers from the "Številka stavbe" column.
      const rows = sectionContainer.locator("table").locator("tbody tr");
      const rowCount = await rows.count();

      for (let i = 0; i < rowCount; i++) {
        const numberText = await rows
          .nth(i)
          .locator("td")
          .nth(1) // 2nd column == "Številka stavbe"
          .locator("button.link-button")
          .innerText();

        const n = Number(numberText.trim().replace(/\s+/g, ""));
        logger.log("Extracted building number", { number: n });
        buildings.push({
          type: "building",
          cadastralMunicipality: query.cadastralMunicipality,
          number: n.toString() + "/1",
        });
      }
    }

    return { outputPath, buildings };
  } catch (error) {
    if (browser) {
      await browser.close();
      browser = null;
    }
    logger.warn("Failed to capture screenshot", error, {
      propertyType: query.type,
      cadastralMunicipality: query.cadastralMunicipality,
      propertyNumber: query.number,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// function to close browser if still open
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export const ProstorService = { processProperty, closeBrowser };
