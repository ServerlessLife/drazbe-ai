import { chromium, Browser, Page } from "playwright";
import { PropertyKey } from "./types/PropertyIdentifier.js";

async function captureParcelScreenshot(query: PropertyKey): Promise<string | null> {
  let browser: Browser | null = null;

  try {
    // Launch browser
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page: Page = await context.newPage();

    // 1. Open the page
    await page.goto("https://ipi.eprostor.gov.si/jv/", { waitUntil: "networkidle" });

    // 2. Click the welcome dialog enter button
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
    await page.waitForSelector('input[type="text"]', { timeout: 5000 });
    await page.fill('input[type="text"]', parcelInput);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);

    // 4. Click first .btn-link under the appropriate section (wait for search results)
    // For parcels: click under "Parcele" section
    // For building/building_part: click under "Stavbe" section
    await page.waitForTimeout(2000);

    if (query.type === "parcel") {
      // Find the "Parcele" section and click first button within it
      const parcelSection = page
        .locator('.search-list-title:has-text("Parcele")')
        .locator("..")
        .locator(".btn-link")
        .first();
      await parcelSection.waitFor({ timeout: 10000 });
      await parcelSection.click();
    } else {
      // Find the "Stavbe" section and click first button within it
      const buildingSection = page
        .locator('.search-list-title:has-text("Stavbe")')
        .locator("..")
        .locator(".btn-link")
        .first();
      await buildingSection.waitFor({ timeout: 10000 });
      await buildingSection.click();
    }

    // Wait a bit for the map to load
    await page.waitForTimeout(1000);

    // 5. Click zoom in icon once
    await page.click(".icon-lupa-plus");

    // Wait for zoom animation
    await page.waitForTimeout(1000);

    // 6. Take screenshot and crop to map area
    const outputPath = "parcel-screenshot.png";
    await page.screenshot({
      path: outputPath,
      clip: { x: 119, y: 173, width: 785, height: 466 },
    });

    await browser.close();

    return outputPath;
  } catch (error) {
    if (browser) {
      await browser.close();
    }
    console.error("Error capturing parcel screenshot:", error);
    return null;
  }
}

export const ParcelScreenshotService = { captureParcelScreenshot };
