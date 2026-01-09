import { chromium, Page, Browser, BrowserContext } from "playwright";
import crypto from "crypto";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import pdf2mdModule from "@opendocsg/pdf2md";
import mammoth from "mammoth";
import TurndownService from "turndown";
import * as cheerio from "cheerio";
import { minify } from "html-minifier-terser";
import { createWorker } from "tesseract.js";
import { createCanvas } from "canvas";
// @ts-ignore
import * as pdfjsLib from "pdfjs-dist";
import { SodneDrazbeService } from "./SodneDrazbeService.js";
import { AuctionRepository } from "./AuctionRepository.js";
import { VisitedUrlRepository } from "./VisitedUrlRepository.js";
import { GursValuationService } from "./GursValuationService.js";
import { Source } from "../types/Source.js";
import { AuctionBase, auctionsBaseSchema } from "../types/AuctionBase.js";
import { Auction, AuctionProperty } from "../types/Auction.js";
import { AuctionDocument } from "../types/AuctionDocument.js";
import { linksSchema, Link } from "../types/Link.js";
import { DocumentResult } from "../types/DocumentResult.js";
import { logger } from "../utils/logger.js";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let openai: OpenAI | undefined;

/**
 * Get or create the OpenAI client instance (singleton pattern)
 */
function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI();
  }
  return openai;
}

/**
 * Convert a relative URL to an absolute URL using the base URL
 */
function buildFullUrl(link: string, baseUrl: string): string {
  if (link.startsWith("http")) {
    return link;
  }
  const origin = new URL(baseUrl).origin;
  return `${origin}${link.startsWith("/") ? "" : "/"}${link}`;
}

/**
 * Extract document links from markdown content
 * Looks for links in the "Priloge" (Attachments) section
 */
function extractDocumentLinks(markdown: string): Array<{ description: string; url: string }> {
  const prilogeSection = markdown.includes("## Priloge:")
    ? markdown.split("## Priloge:")[1]
    : markdown;

  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/gi;
  const linksToDocuments: Array<{ description: string; url: string }> = [];
  let match;

  while ((match = linkRegex.exec(prilogeSection)) !== null) {
    const description = match[1];
    const url = match[2];
    if (!linksToDocuments.some((l) => l.url === url)) {
      linksToDocuments.push({ description, url });
    }
  }

  return linksToDocuments;
}

/**
 * Get or create a browser instance with a page (singleton pattern)
 * Uses Playwright with Chrome user agent to avoid bot detection
 */
async function ensureBrowser(): Promise<Page> {
  if (!browser) {
    // Use headless mode from env (defaults to true)
    const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
    browser = await chromium.launch({
      headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        // "--disable-features=IsolateOrigins,site-per-process",
        // "--no-sandbox",
        // "--disable-setuid-sandbox",
        // "--disable-dev-shm-usage",
        // "--disable-accelerated-2d-canvas",
        // "--disable-gpu",
      ],
    });
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      // viewport: { width: 1920, height: 1080 },
      // locale: "sl-SI",
      // timezoneId: "Europe/Ljubljana",
      // extraHTTPHeaders: {
      //   "Accept-Language": "sl-SI,sl;q=0.9,en;q=0.8",
      //   Accept:
      //     "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      //   "Sec-Fetch-Dest": "document",
      //   "Sec-Fetch-Mode": "navigate",
      //   "Sec-Fetch-Site": "none",
      //   "Sec-Fetch-User": "?1",
      //   "Upgrade-Insecure-Requests": "1",
      // },
    });

    // Remove webdriver property to avoid detection
    // await context.addInitScript(() => {
    //   Object.defineProperty(navigator, "webdriver", {
    //     get: () => undefined,
    //   });
    //   // Override plugins
    //   Object.defineProperty(navigator, "plugins", {
    //     get: () => [1, 2, 3, 4, 5],
    //   });
    //   // Override languages
    //   Object.defineProperty(navigator, "languages", {
    //     get: () => ["sl-SI", "sl", "en-US", "en"],
    //   });
    // });

    page = await context.newPage();
  }
  return page!;
}

/**
 * Close the browser instance and clean up resources
 */
async function close(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    page = null;
  }
}

/**
 * Minify HTML to reduce token usage when sending to AI models
 * Falls back to original HTML if minification fails
 */
async function compactHtml(
  html: string,
  dataSourceCode: string,
  sourceUrl: string
): Promise<string> {
  try {
    return await minify(html, {
      collapseWhitespace: true,
      removeComments: true,
      removeEmptyAttributes: true,
      removeScriptTypeAttributes: true,
      removeStyleLinkTypeAttributes: true,
      minifyCSS: true,
      minifyJS: false,
      removeTagWhitespace: true,
    });
  } catch (error) {
    logger.warn("HTML minification failed, using original HTML", {
      dataSourceCode,
      sourceUrl,
    });
    return html;
  }
}

/**
 * Extract and clean HTML content using a CSS selector
 * Removes script/style tags and minifies the result
 * Falls back to full HTML if selector is not found or processing fails
 */
async function extractContent(
  html: string,
  selector?: string,
  dataSourceCode?: string,
  sourceUrl?: string
): Promise<string> {
  try {
    // Remove script and style tags first
    const $ = cheerio.load(html);
    $("script").remove();
    $("style").remove();
    $("noscript").remove();

    let content: string;
    if (selector) {
      const selectedContent = $(selector).html();
      if (!selectedContent) {
        logger.warn(`Selector "${selector}" not found, using full HTML`, {
          selector,
          htmlLength: html.length,
          dataSourceCode,
          sourceUrl,
        });
        content = $.html();
      } else {
        content = selectedContent;
      }
    } else {
      content = $.html();
    }

    return await compactHtml(content, dataSourceCode, sourceUrl);
  } catch (error) {
    logger.error("Failed to extract content, using original HTML", error, {
      htmlLength: html.length,
      dataSourceCode,
      sourceUrl,
    });
    return html;
  }
}

/**
 * Extract announcement links from HTML using AI
 * Filters for suitable property sale announcements and excludes expired listings
 */
async function extractLinks(
  pageHtml: string,
  sourceUrl: string,
  dataSourceCode: string,
  linksSelector?: string
): Promise<Link[]> {
  const activeOnly = true;
  logger.log("Extracting links from page", {
    dataSourceCode,
    sourceUrl,
    hasSelector: !!linksSelector,
  });

  const contentHtml = await extractContent(pageHtml, linksSelector, dataSourceCode, sourceUrl);

  // Log extracted HTML to export folder for debugging
  logger.logContent(
    "HTML content extracted",
    { dataSourceCode, sourceUrl, selector: linksSelector },
    { content: contentHtml, prefix: dataSourceCode, suffix: "links-source", extension: "html" }
  );

  // Adjust system prompt based on whether content was filtered
  const contextNote = linksSelector
    ? "Dobiš samo del HTML strani, ki vsebuje seznam povezav do objav. Vse povezave v tem delu so relevantne."
    : "Osredotočite se na glavno vsebino, ne na navigacijo, glave, noge in druge elemente, ki niso povezani z vsebino.";

  try {
    const response = await getOpenAI().chat.completions.create({
      //model: "gpt-5-mini",
      model: "gpt-5.2",
      messages: [
        {
          role: "system",
          content: `Si pomočnik, ki analizira HTML in izvleče ustrezne povezave do objav.
        Ustrezne so objave tipa:
        - 'dražba' (javna dražba za prodajo)
        - 'namera za sklenitev neposredne pogodbe' za PRODAJO (ne za najem/oddajo/menjavo)
        - 'javno zbiranje ponudb' za PRODAJO (ne za najem/oddajo/menjavo)

        ${contextNote}

        POMEMBNO:
        ${activeOnly ? `- Izključi pretečene objave (kjer je rok veljavnosti že potekel - danes je ${new Date().toISOString().split("T")[0]})` : ""}
        - Izključi duplikate (če je ista objava navedena večkrat, vrni samo enkrat)
        - Navedi polni URL. Če je povezava relativna, jo pretvori v polno z uporabo izvornega URL-ja: ${sourceUrl}. Morda moraš vzeti samo domeno in osnovno pot iz izvornega URL-ja.

        Vrni JSON objekt z poljem "links", ki vsebuje VSE najdene povezave.
        Vsaka povezava naj ima polja: title, link (polni URL), suitable (boolean), reason (zakaj je ustrezna ali neustrezna).

        Prepričaj se, da nisi spustil nobene povezave!!!
        `,
        },
        {
          role: "user",
          content: `Analiziraj naslednji HTML in vrni vse povezave do objav o prodaji nepremičnin:\n\n${contentHtml}`,
        },
      ],
      response_format: zodResponseFormat(linksSchema, "links"),
    });

    const filterResult = linksSchema.parse(JSON.parse(response.choices[0].message.content || "{}"));

    logger.log("Links extracted", {
      total: filterResult.links.length,
      suitable: filterResult.links.filter((l) => l.suitable).length,
      unsuitable: filterResult.links.filter((l) => !l.suitable).length,
    });

    return filterResult.links;
  } catch (error) {
    logger.error("Failed to extract links", error, {
      dataSourceCode,
      sourceUrl,
    });
    throw error;
  }
}

/**
 * Convert HTML to clean markdown format using AI (GPT-5-mini)
 * Extracts main content, images, and document attachments
 */
async function convertHtmlToMarkdown(
  pageHtml: string,
  sourceUrl: string,
  contentSelector?: string,
  dataSourceCode?: string
): Promise<string> {
  logger.log("Converting HTML to markdown", {
    hasSelector: !!contentSelector,
    htmlLength: pageHtml.length,
    dataSourceCode,
    sourceUrl,
  });

  // Extract content using selector if provided
  const contentHtml = await extractContent(pageHtml, contentSelector, dataSourceCode, sourceUrl);
  logger.log("Content extracted for conversion", {
    contentLength: contentHtml.length,
  });

  // Adjust system prompt based on whether content was filtered
  const contextNote = contentSelector
    ? "Dobiš samo del HTML strani, ki vsebuje glavno vsebino objave. Celotna vsebina je relevantna."
    : "Osredotoči se na glavno vsebino objave. Odstrani navigacijo, glave, noge in druge elemente, ki niso del vsebine.";

  try {
    const markdownResponse = await getOpenAI().chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: `Pretvori naslednji HTML v čist markdown format.
            ${contextNote}

            SLIKE:
            Za slike uporabi format ![opis](url_slike).
            Ne vključi slik, ki so del glave, navigacije, logotipov, dekorativnih elementov ali ikone.
            Navedi polni URL. Če je povezava relativna, jo pretvori v polno z uporabo izvornega URL-ja: ${sourceUrl}. Morda moraš vzeti samo domeno in osnovno pot iz izvornega URL-ja.
            Povezava naj se začne z https, ne z http.
            Izloči podvojene slike.
            Navedi jih ločenem razdelku z naslovom "## Slike:".

            DOKUMENTI:
            Vključi vse povezave do dokumentov (PDF-jev).
            Ne vključi dokumentov:
             - Obrazec za prijavo
             - Energetska izkaznica
             - Pooblastilo
             - Izjava (podatki solatnika, nepovezanosti, MSP)
             - Lokacijski načrt
             - Zazidalne površine
             - Komunalni vodi
             - Pogodba ali osnutek pogodbe
             - GDPR
            Navedi polni URL. Če je povezava relativna, jo pretvori v polno z uporabo izvornega URL-ja: ${sourceUrl}. Morda moraš vzeti samo domeno in osnovno pot iz izvornega URL-ja.
            Dokumentov, ki jih izpustiš, ne omenjaj v besedilu.
            Povezane dokumente navedi čisto na koncu v ločenem razdelku z naslovom "## Priloge:".
            Dokumente navedi v formatu [opis](url_dokumenta).
            Pazi, da za cenitveno poročilo vedno uporabiš besedilo "Cenitveno poročilo", tudi če je v izvoru drugače.
            `,
        },
        {
          role: "user",
          content: contentHtml,
        },
      ],
    });

    const markdown = markdownResponse.choices[0].message.content || "";
    logger.log("Converted to markdown", {
      markdownLength: markdown.length,
    });

    return markdown;
  } catch (error) {
    logger.error("Failed to convert HTML to markdown", error);
    throw error;
  }
}

/**
 * Extract structured property details from markdown using AI (GPT-5.2)
 * Identifies parcels, buildings, prices, and other auction details
 */
async function extractAuctionDetails(markdown: string): Promise<AuctionBase[]> {
  const detailResponse = await getOpenAI().chat.completions.parse({
    model: "gpt-5.2",
    messages: [
      {
        role: "system",
        content: `Izvleci podrobnosti iz objave o prodaji nepremičnin.

            Bodi natančen pri izvlačevanju parcel/stavb - poišči vse navedene v besedilu. Pazi, da ne podvojiš.
            Vedno vključi celotno šifro!!! Kadar gre za del stavbe ne more biti vključen še celotna stavba.
            Ne omenjaj povezane zemljiške parcele, kadar to ni relevantno.

            Kadar gre za stavbo poskusi izluščiti tudi leto izgradnje.

            Cena je lahko podatna na m2 ali kot skupna cena. Če je cena podana na m2, izračunaj skupno ceno, če imaš podatek o površini.

            Lahko gre več objav v enem samem besedilu. V tem primeru naredi več zapisov in podvoji podatke, ki so enaki za vse.

            Podatke o parceli in stavbe loči in pripiši ustrezni objavi v polje "property".

            Podi pozoren na morebitne ločene sklope v dokumentu "Odredba o prodaji", če je priložen!!!
            `,
      },
      {
        role: "user",
        content: markdown,
      },
    ],
    response_format: zodResponseFormat(auctionsBaseSchema, "auction_details"),
  });

  return detailResponse.choices[0].message.parsed!.auctions;
}

/**
 * Navigate to a page with Playwright and convert its content to markdown
 * Waits for network idle before extracting HTML
 */
async function fetchPageMarkdown(
  page: Page,
  announcementUrl: string,
  sourceUrl: string,
  contentSelector?: string,
  dataSourceCode?: string
): Promise<string> {
  logger.log("Fetching page", {
    pageUrl: announcementUrl,
    dataSourceCode,
  });

  await page.goto(announcementUrl);
  try {
    await page.waitForLoadState("networkidle", { timeout: 4000 });
  } catch (err) {
    logger.warn("Network idle timeout, continuing anyway", {
      pageUrl: announcementUrl,
      dataSourceCode,
    });
  }
  const pageHtml = await page.evaluate(() => document.body.innerHTML);
  return convertHtmlToMarkdown(pageHtml, sourceUrl, contentSelector, dataSourceCode);
}

/**
 * Download a document (PDF/DOCX) and convert to markdown
 * Uses OCR for scanned PDFs if needed
 * Skips valuation reports (cenitveno poročilo)
 */
async function fetchDocument(
  doc: {
    description: string;
    url: string;
  },
  announcementUrl: string,
  dataSourceCode: string,
  cookies?: string
): Promise<DocumentResult | null> {
  try {
    if (doc.description.toLowerCase().includes("cenitveno poročilo")) {
      logger.log("Skipping valuation report", {
        document: doc.description,
        announcementUrl,
        dataSourceCode,
      });
      return null;
    }

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
      logger.error("Failed to download document", new Error(`HTTP ${docResponse.status}`), {
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

    // // Save buffer to file for diagnostics
    // ensureExportFolder();
    // const timestamp = new Date().toISOString().replace(/:/g, "-");
    // const extension = contentType.includes("pdf")
    //   ? "pdf"
    //   : contentType.includes("word")
    //     ? "docx"
    //     : "bin";
    // const diagnosticFileName = `export/diagnostic-${timestamp}.${extension}`;
    // fs.writeFileSync(diagnosticFileName, buffer);
    // logger.log(`Diagnostic file saved: ${diagnosticFileName}`);

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
      const pdfResult = await pdfToMarkdown(buffer);
      content = pdfResult.content;
      ocrUsed = pdfResult.ocrUsed;
    }

    if (content) {
      logger.log(`Document converted to markdown${ocrUsed ? " (OCR)" : ""}`, {
        document: doc.description,
        announcementUrl,
        dataSourceCode,
      });
    } else {
      logger.warn(`Failed to convert document to markdown`, {
        document: doc.description,
        documentUrl: doc.url,
        docType,
        bufferSize: buffer.length,
        announcementUrl,
        dataSourceCode,
      });
    }

    // Generate local URL using UUID
    const uuid = crypto.randomUUID();
    const extension = docType === "docx" ? "docx" : "pdf";
    const localUrl = `documents/${uuid}.${extension}`;

    // // TODO: Upload buffer to S3 using localUrl
    // logger.log("Document ready for S3 upload", {
    //   document: doc.description,
    //   localUrl,
    //   announcementUrl,
    //   dataSourceCode,
    // });

    return {
      description: doc.description,
      url: doc.url,
      localUrl,
      type: docType,
      ocrUsed,
      markdown: content,
    };
  } catch (docErr: any) {
    logger.error("Document processing error", docErr, {
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
 */
async function fetchDocuments(
  linksToDocuments: Array<{ description: string; url: string }>,
  announcementUrl: string,
  dataSourceCode: string,
  cookies?: string
): Promise<DocumentResult[]> {
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
          contentLength: result.markdown?.length || 0,
          ocrUsed: result.ocrUsed,
          announcementUrl,
          dataSourceCode,
        });
      }
      return result;
    } catch (error) {
      logger.error("Failed to process document", error, {
        document: doc.description,
        announcementUrl,
        dataSourceCode,
      });
      return null;
    }
  });

  const settledResults = await Promise.all(promises);
  const results = settledResults.filter((r): r is DocumentResult => r !== null);

  logger.log("All documents processed", {
    total: linksToDocuments.length,
    successful: results.length,
    failed: linksToDocuments.length - results.length,
    announcementUrl,
    dataSourceCode,
  });

  return results;
}

/**
 * Convert PDF to markdown
 * First attempts text extraction, falls back to OCR (Tesseract) if PDF is scanned
 */
async function pdfToMarkdown(buffer: Buffer): Promise<{ content: string; ocrUsed: boolean }> {
  // First try normal text extraction
  const pdfMarkdown = await pdf2mdModule(buffer);

  // Check if text was extracted (more than just whitespace)
  const textContent = pdfMarkdown.replace(/\s+/g, "").trim();
  if (textContent.length > 50) {
    return { content: pdfMarkdown, ocrUsed: false };
  }

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
      return { content: ocrResults.join("\n\n"), ocrUsed: true };
    }

    logger.warn("OCR found no text", { totalPages: pdfDoc.numPages });
    return { content: pdfMarkdown, ocrUsed: false };
  } catch (ocrErr) {
    logger.error("OCR error", ocrErr);
    return { content: pdfMarkdown, ocrUsed: false };
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
 * Process a single auction: fetch content, extract documents, and parse details
 * Fetches valuations, saves to DynamoDB, and returns structured auction data
 * Returns empty array if processing fails
 */
async function processAuction(page: Page, objava: Link, dataSource: Source): Promise<Auction[]> {
  try {
    const announcementUrl = buildFullUrl(objava.url, dataSource.url);

    // Check if this URL was already visited
    if (await VisitedUrlRepository.isVisited(announcementUrl)) {
      logger.log(
        `Skipping already visited URL for data source ${dataSource.code}, title "${objava.title}"`,
        {
          title: objava.title,
          url: announcementUrl,
          dataSourceCode: dataSource.code,
        }
      );
      return [];
    }

    logger.log(
      `Processing announcement for data source ${dataSource.code}, title "${objava.title}"`,
      {
        title: objava.title,
        url: objava.url,
        dataSourceCode: dataSource.code,
      }
    );

    const safeTitle = objava.title.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
    let markdown: string = "";

    // Fetch content based on source type
    if (SodneDrazbeService.isSodneDrazbeUrl(announcementUrl)) {
      try {
        markdown = await SodneDrazbeService.fetchMarkdown(announcementUrl);
      } catch (err) {
        logger.error(
          `Failed to fetch auction data from sodnedrazbe.si for "${objava.title}"`,
          err,
          {
            url: announcementUrl,
            dataSourceCode: dataSource.code,
          }
        );
      }
    } else {
      markdown = await fetchPageMarkdown(
        page,
        announcementUrl,
        dataSource.url,
        dataSource.contentSelector,
        dataSource.code
      );
    }

    // Extract cookies from browser context. Needed for authenticated document access.
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Extract and fetch document content
    const linksToDocuments = extractDocumentLinks(markdown);
    logger.log(
      `Found ${linksToDocuments.length} document links for data source ${dataSource.code}, title "${objava.title}"`,
      {
        url: announcementUrl,
        dataSourceCode: dataSource.code,
        count: linksToDocuments.length,
        documents: linksToDocuments.map((d) => d.description),
      }
    );

    const documents = await fetchDocuments(
      linksToDocuments,
      announcementUrl,
      dataSource.code,
      cookieHeader
    );

    // Check if initial content is short
    const isShortContent = markdown.length < 3000;

    // Check if there are non-OCR documents with sufficient content
    const hasOtherDocumentsWithContent = documents.some(
      (doc) => !doc.ocrUsed && doc.markdown && doc.markdown.replace(/\s+/g, "").length > 100
    );

    // Track which documents were used for extraction
    const usedDocumentUrls = new Set<string>();

    // Append documents to markdown
    for (const doc of documents) {
      if (!doc.markdown) continue;

      // Skip OCR documents unless content is short AND there are no other documents with content
      if (doc.ocrUsed && (!isShortContent || hasOtherDocumentsWithContent)) {
        logger.log("Skipping OCR document (sufficient content from other sources)", {
          document: doc.description,
        });
        continue;
      }

      markdown += `\n\n---\n\n## Dokument: ${doc.description}\n\n${doc.markdown}`;
      usedDocumentUrls.add(doc.url);
    }

    logger.logContent(
      `Announcement markdown ready for data source ${dataSource.code}, title "${objava.title}"`,
      { dataSourceCode: dataSource.code, title: objava.title },
      { content: markdown, prefix: dataSource.code, suffix: safeTitle, extension: "md" }
    );

    // Extract structured details
    const auctions = await extractAuctionDetails(markdown);

    // Map to results with valuations
    const results: Auction[] = [];

    for (const auction of auctions) {
      // Fetch valuations for each property
      let propertiesWithValuations: AuctionProperty[] | null = null;
      if (auction.property) {
        propertiesWithValuations = [];
        for (const property of auction.property) {
          property.number = property.number.trim().replace(/[- ]/g, "/");

          let valuation = undefined;
          try {
            valuation = (await GursValuationService.getValuation(property)) ?? undefined;
            if (valuation) {
              logger.log("Property valuation fetched", {
                dataSourceCode: dataSource.code,
                propertyType: property.type,
                cadastralMunicipality: property.cadastralMunicipality,
                number: property.number,
                value: "value" in valuation ? valuation.value : undefined,
              });
            }
          } catch (valuationErr) {
            logger.warn("Failed to fetch valuation for property", {
              dataSourceCode: dataSource.code,
              propertyType: property.type,
              cadastralMunicipality: property.cadastralMunicipality,
              number: property.number,
              error: valuationErr instanceof Error ? valuationErr.message : String(valuationErr),
            });
          }
          propertiesWithValuations.push({ ...property, valuation });
        }
      }

      // Skip non-sale auctions (rentals, exchanges, etc.)
      if (!auction.isSale) {
        logger.log("Skipping non-sale auction", {
          dataSourceCode: dataSource.code,
          title: auction.title,
          type: auction.type,
        });
        continue;
      }

      // Calculate price to value ratio (Relativna cena) as discount percentage
      const price = auction.price ?? null;
      const estimatedValue = auction.estimatedValue ?? null;

      // Calculate discount from estimated value (higher = better deal)
      let toEstimatedValue: number | null = null;
      if (price !== null && estimatedValue !== null && estimatedValue > 0) {
        toEstimatedValue = Math.round(((estimatedValue - price) / estimatedValue) * 100);
      }

      // Calculate discount from sum of property valuations
      let toPropertyValuations: number | null = null;
      if (price !== null && propertiesWithValuations && propertiesWithValuations.length > 0) {
        const totalValuation = propertiesWithValuations.reduce((sum, prop) => {
          if (prop.valuation && "value" in prop.valuation) {
            return sum + prop.valuation.value;
          }
          return sum;
        }, 0);
        if (totalValuation > 0) {
          toPropertyValuations = Math.round(((totalValuation - price) / totalValuation) * 100);
        }
      }

      const result: Auction = {
        announcementId: auction.announcementId ?? null,
        title: auction.title,
        aiTitle: null,
        aiWarning: null,
        aiSuitability: null,
        type: auction.type,
        isVacant: auction.isVacant ?? null,
        publicationDate: auction.publicationDate ?? null,
        dueDate: auction.dueDate ?? null,
        description: auction.description ?? null,
        location: auction.location ?? null,
        price: price,
        estimatedValue: estimatedValue,
        ownershipShare: auction.ownershipShare ?? null,
        yearBuilt: auction.yearBuilt ?? null,
        dataSourceCode: dataSource.code,
        urlSources: [announcementUrl],
        properties: propertiesWithValuations,
        documents:
          auction.documents?.map((doc) => {
            const foundDoc = documents.find((d) => d.url === doc.sourceUrl);
            return {
              description: doc.description,
              sourceUrl: doc.sourceUrl,
              localUrl: foundDoc?.localUrl,
              type: foundDoc?.type,
              ocrUsed: foundDoc?.ocrUsed,
              usedForExtraction: usedDocumentUrls.has(doc.sourceUrl),
            };
          }) ?? [],
        images:
          auction.images?.map((img) => ({
            description: img.description,
            sourceUrl: img.sourceUrl,
          })) ?? null,
        priceToValueRatio: {
          toEstimatedValue,
          toPropertyValuations,
        },
      };

      // Save to DynamoDB
      await AuctionRepository.save(result);
      results.push(result);
    }

    logger.log(
      `Announcement processed for data source ${dataSource.code}, title "${objava.title}"`,
      {
        dataSourceCode: dataSource.code,
        title: objava.title,
        resultsExtracted: results.length,
      }
    );

    // Mark URL as visited after successful processing
    await VisitedUrlRepository.markVisited(announcementUrl, dataSource.code);

    return results;
  } catch (err: any) {
    logger.error(
      `Failed to process announcement for data source ${dataSource.code}, title "${objava.title}"`,
      err,
      {
        dataSourceCode: dataSource.code,
        title: objava.title,
        url: objava.url,
      }
    );
    return [];
  }
}

/**
 * Main entry point: process a source to extract property sale auctions
 * Steps: navigate to source → extract links → process each auction → save results
 * Returns sale auction results (non-sale auctions are filtered out during processing)
 */
async function processSource(dataSource: Source): Promise<Auction[]> {
  logger.log(`Processing source: ${dataSource.name}`, {
    code: dataSource.code,
    url: dataSource.url,
    skipSearching: dataSource.skipSearchingForLinks,
  });

  const page = await ensureBrowser();
  let allLinks: Link[];

  // Use url directly if skipSearchingForLinks is true, otherwise extract from page
  if (dataSource.skipSearchingForLinks) {
    logger.log(`Using direct link for ${dataSource.name} (skipping link search)`, {
      dataSourceCode: dataSource.code,
      url: dataSource.url,
    });
    allLinks = [
      {
        title: dataSource.name,
        url: dataSource.url,
        suitable: true,
        reason: "Neposredno podana povezava",
      },
    ];
  } else {
    logger.log(`Navigating to source page: ${dataSource.name}`, {
      dataSourceCode: dataSource.code,
      url: dataSource.url,
      linksSelector: dataSource.linksSelector || "(none)",
    });
    await page.goto(dataSource.url);
    await page.waitForLoadState("networkidle");

    const pageHtml = await page.evaluate(() => document.body.innerHTML);
    allLinks = await extractLinks(
      pageHtml,
      dataSource.url,
      dataSource.code,
      dataSource.linksSelector
    );

    logger.logContent(
      `Extracted ${allLinks.length} links from ${dataSource.name}`,
      { dataSourceCode: dataSource.code, total: allLinks.length },
      {
        content: JSON.stringify(allLinks, null, 2),
        prefix: dataSource.code,
        suffix: "vse-povezave",
        extension: "json",
      }
    );
  }

  // Filter to get only suitable links
  let suitableLinks = allLinks.filter((l) => l.suitable);
  logger.log(`Filtered ${suitableLinks.length} suitable links from ${allLinks.length} total`, {
    dataSourceCode: dataSource.code,
    total: allLinks.length,
    suitable: suitableLinks.length,
    unsuitable: allLinks.length - suitableLinks.length,
  });

  // TEMP: Only process first link for testing
  if (suitableLinks.length > 0) {
    logger.warn("Processing only first link (TEMP limitation)");
    suitableLinks = [suitableLinks[0]];
  }

  // Step 2: Process each announcement
  logger.log(`Processing ${suitableLinks.length} actions from ${dataSource.name}`, {
    dataSourceCode: dataSource.code,
    count: suitableLinks.length,
  });
  const rezultati: Auction[] = [];

  for (const objava of suitableLinks) {
    const auctionResults = await processAuction(page, objava, dataSource);
    rezultati.push(...auctionResults);
  }

  // Step 3: Save results
  logger.logContent(
    `Saved ${rezultati.length} sale announcements for ${dataSource.name}`,
    { dataSourceCode: dataSource.code, totalResults: rezultati.length },
    {
      content: JSON.stringify(rezultati, null, 2),
      prefix: dataSource.code,
      suffix: "objave-prodaja",
      extension: "json",
    }
  );

  logger.log(`Processing complete for ${dataSource.name}`, {
    dataSourceCode: dataSource.code,
    totalResults: rezultati.length,
  });

  return rezultati;
}

export const AiExtractService = {
  processSource,
  close,
  fetchAndAppendDocument: fetchDocument,
};
