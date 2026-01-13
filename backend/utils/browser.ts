import { chromium, Browser, Page } from "playwright-core";
import chromiumBinary from "@sparticuz/chromium";

/**
 * Launch a browser and return a page. Uses @sparticuz/chromium in Lambda, regular playwright locally.
 */
export async function launchBrowser(): Promise<{ browser: Browser; page: Page }> {
  const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
  let browser: Browser;

  if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const executablePath = await chromiumBinary.executablePath();

    console.log("ARGS: ", chromiumBinary.args);

    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: [
        //"--no-sandbox",
        "--no-zygote",
        //"--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });
  } else {
    //try {
    const playwright = await import("playwright");
    browser = await playwright.chromium.launch({
      headless,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    // } catch {
    //   browser = await chromium.launch({
    //     headless,
    //     args: ["--disable-blink-features=AutomationControlled"],
    //     channel: "chrome",
    //   });
    // }
  }

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  return { browser, page };
}
