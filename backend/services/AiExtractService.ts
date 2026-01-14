import { Page, Browser } from "playwright-core";
import { launchBrowser } from "../utils/browser.js";
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
import { ProstorService } from "./ProstorService.js";
import { S3Service } from "./S3Service.js";
import { Source } from "../types/Source.js";
import { AuctionBase, auctionsBaseSchema } from "../types/AuctionBase.js";
import { Auction, AuctionProperty } from "../types/Auction.js";
import { AuctionDocument } from "../types/AuctionDocument.js";
import { linksSchema, Link } from "../types/Link.js";
import { DocumentResult } from "../types/DocumentResult.js";
import { logger } from "../utils/logger.js";
import { config } from "../utils/config.js";
import { PropertyKey } from "../types/PropertyIdentifier.js";

let browser: Browser | null = null;
let page: Page | null = null;
let openai: OpenAI | undefined;

/**
 * Get or create the OpenAI client instance (singleton pattern)
 * Uses API key from config (SSM in Lambda, .env locally)
 */
async function getOpenAI(): Promise<OpenAI> {
  if (!openai) {
    const apiKey = await config.get("/drazbe-ai/openai-api-key");
    openai = new OpenAI({ apiKey });
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
 * Get or create a browser page (singleton pattern)
 */
async function ensurePage(): Promise<Page> {
  if (!page) {
    const result = await launchBrowser();
    browser = result.browser;
    page = result.page;
  }
  return page;
}

/**
 * Close the browser instance and clean up resources
 */
async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
  }
  browser = null;
  page = null;
  // Also close ParcelScreenshotService browser
  await ProstorService.closeBrowser();
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
    logger.warn("Failed to extract content, using original HTML", error, {
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
    const openaiClient = await getOpenAI();
    const response = await openaiClient.chat.completions.create({
      //model: "gpt-5-mini",
      model: "gpt-5.2",
      messages: [
        {
          role: "system",
          content: `Si pomočnik za analizo HTML in ekstrakcijo povezav do objav o prodaji nepremičnin.

## USTREZNE OBJAVE
Iščemo objave tipa:
- Javna dražba (za prodajo)
- Namera za sklenitev neposredne pogodbe za PRODAJO
- Javno zbiranje ponudb za PRODAJO
- Elektronska dražba

NE iščemo:
- Najem, oddaja, zakup
- Menjava
- Služnostne pravice

## KONTEKST
${contextNote}

## PRAVILA
${activeOnly ? `- Izključi pretečene objave (rok veljavnosti potekel). Današnji datum: ${new Date().toISOString().split("T")[0]}. Če datum ni podadan, predpostavi, da objava ni pretečena.` : ""}.
- Izključi duplikate - vsako objavo vrni samo enkrat
- Pretvori relativne URL-je v absolutne z uporabo izvornega URL-ja: ${sourceUrl}

## IZHOD
Vrni JSON z poljem "links". Vsaka povezava ima:
- title: naslov objave
- link: polni URL
- suitable: boolean (ali ustreza kriterijem)
- reason: kratek razlog za odločitev

Prepričaj se, da zajameš VSE povezave do objav!
`,
        },
        {
          role: "user",
          content: `Analiziraj HTML in izvleci vse povezave do objav o prodaji nepremičnin:\n\n${contentHtml}`,
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
    // logger.error("Failed to extract links", error, {
    //   dataSourceCode,
    //   sourceUrl,
    // });
    throw new Error(`Failed to extract links: ${error}`, { cause: error });
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
    const openaiClient = await getOpenAI();
    const markdownResponse = await openaiClient.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: `Pretvori HTML v čist markdown format.

## KONTEKST
${contextNote}

## SLIKE
- Format: ![opis](url_slike)
- Izključi: logotipe, ikone, navigacijske elemente, dekorativne slike
- Pretvori relativne URL-je v absolutne (izvorni URL: ${sourceUrl})
- Uporabi https (ne http)
- Odstrani duplikate
- Navedi v ločenem razdelku "## Slike:"

## DOKUMENTI
Vključi PDF dokumente, RAZEN:
- Obrazec za prijavo
- Energetska izkaznica
- Pooblastilo
- Izjave (podatki solastnika, nepovezanosti, MSP)
- Lokacijski načrt
- Zazidalne površine
- Komunalni vodi
- Pogodba ali osnutek pogodbe
- GDPR dokumenti

Pravila za dokumente:
- Pretvori relativne URL-je v absolutne (izvorni URL: ${sourceUrl})
- Izpuščenih dokumentov NE omenjaj v besedilu
- Navedi v ločenem razdelku "## Priloge:" na koncu
- Format: [opis](url_dokumenta)
- Za cenilno poročilo vedno uporabi opis "Cenitveno poročilo", tudi če je v izvoru drugače.
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
    //logger.error("Failed to convert HTML to markdown", error);
    throw new Error(`Failed to convert HTML to markdown: ${error}`, { cause: error });
  }
}

/**
 * Extract structured property details from markdown using AI (GPT-5.2)
 * Identifies parcels, buildings, prices, and other auction details
 */
async function extractAuctionDetails(markdown: string): Promise<AuctionBase[]> {
  const openaiClient = await getOpenAI();
  const detailResponse = await openaiClient.chat.completions.parse({
    model: "gpt-5.2",
    messages: [
      {
        role: "system",
        content: `Izvleci strukturirane podrobnosti iz objave o prodaji nepremičnin.

## SPLOŠNA PRAVILA
- Če je v besedilu več ločenih objav/sklopov, ustvari ločen zapis za vsako
- Pri stavbah poskusi izluščiti leto izgradnje
- Cena je lahko podana na m² ali kot skupna - če je na m², izračunaj skupno ceno iz površine
- Pozorno preberi morebitni dokument "Odredba o prodaji" za ločene sklope

## NEPREMIČNINE (properties)
Natančno izvleci vse parcele in dele stavb:
- Vključi CELOTNO šifro (katastrska občina + številka)
- Pri delu stavbe NE vključi še celotne stavbe
- Pri hiši VEDNO poišči oznako stavbe/dela stavbe, ne le parcele
- Ne omenjaj povezane zemljiške parcele, kadar to ni relevantno.
- Ne podvajaj - vsako nepremičnino navedi enkrat
- Podatke o nepremičninah pripiši ustrezni objavi, če jih je več

## DELEŽ LASTNIŠTVA
- Pozorno preberi delež lastništva za vsako nepremičnino
- Delež je lahko podan kot ulomek (1/2) ali odstotek (50%)
- Če ni naveden, predpostavi 100%
- Kadar se prodaja hiša bodi pozoren na delež. Če se parcela ne prodaja v celoti se zagotovo tudi hiša ne.
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

  // Throw an error if it contains message "you have been blocked"
  if (pageHtml.toLowerCase().includes("you have been blocked")) {
    throw new Error("Access blocked: The page indicates that you have been blocked.");
  }

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
    /*
    if (doc.description.toLowerCase().includes("cenitveno poročilo")) {
      logger.log("Skipping valuation report", {
        document: doc.description,
        announcementUrl,
        dataSourceCode,
      });
      return null;
    }
      */

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
      logger.warn("Failed to download document", new Error(`HTTP ${docResponse.status}`), {
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

    // Generate S3 key using UUID and upload to S3
    const uuid = crypto.randomUUID();
    const extension = docType === "docx" ? "docx" : "pdf";
    const s3Key = `documents/${uuid}.${extension}`;
    const contentTypeForS3 =
      docType === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/pdf";

    const localUrl = await S3Service.uploadFile(buffer, s3Key, contentTypeForS3);

    logger.log("Document uploaded to S3", {
      document: doc.description,
      localUrl,
      announcementUrl,
      dataSourceCode,
    });

    return {
      description: doc.description,
      url: doc.url,
      localUrl,
      type: docType,
      ocrUsed,
      markdown: content,
    };
  } catch (docErr: any) {
    logger.warn("Document processing error", docErr, {
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
      logger.warn("Failed to process document", error, {
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
    logger.warn("OCR error", ocrErr);
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
async function processAuction(objava: Link, dataSource: Source): Promise<Auction[]> {
  try {
    const announcementUrl = buildFullUrl(objava.url, dataSource.url);

    // Check if this URL was already visited
    if (await VisitedUrlRepository.isVisited(dataSource.code, announcementUrl)) {
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
        logger.warn(`Failed to fetch auction data from sodnedrazbe.si for "${objava.title}"`, err, {
          url: announcementUrl,
          dataSourceCode: dataSource.code,
        });
      }
    } else {
      markdown = await fetchPageMarkdown(
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
      // do not skip if "Cenitveno poročilo"
      if (
        doc.ocrUsed &&
        (!isShortContent || hasOtherDocumentsWithContent) &&
        !doc.description.toLowerCase().includes("cenitveno poročilo")
      ) {
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
      // Skip non-sale auctions (rentals, exchanges, etc.)
      if (!auction.isRealEstateSale) {
        logger.log("Skipping non-sale auction", {
          dataSourceCode: dataSource.code,
          title: auction.title,
          type: auction.type,
        });
        continue;
      }

      // Fetch valuations for each property
      let properties: AuctionProperty[] | null = await processProperties(auction);

      // Calculate price to value ratio (Relativna cena) as discount percentage
      const price = auction.price;
      const estimatedValue = auction.estimatedValue;

      // Calculate discount from estimated value (higher = better deal)
      let toEstimatedValue: number | null = null;
      if (price !== null && estimatedValue !== null && estimatedValue > 0) {
        toEstimatedValue = Math.round(((estimatedValue - price) / estimatedValue) * 100);
      }

      // Calculate discount from sum of property valuations
      let toPropertyValuations: number | null = null;
      let totalPropertyValuation: number | null = null;
      let valuationsReducedByOwnershipShare = false;
      if (price !== null && properties && properties.length > 0) {
        const totalValuation = properties.reduce((sum, prop) => {
          if (prop.valuation && "value" in prop.valuation) {
            return sum + prop.valuation.value;
          }
          return sum;
        }, 0);
        if (totalValuation > 0) {
          totalPropertyValuation = totalValuation;
          toPropertyValuations = Math.round(((totalValuation - price) / totalValuation) * 100);
        }
        // Check if any valuation was reduced by ownership share
        valuationsReducedByOwnershipShare = properties.some(
          (prop) => prop.valuation?.reducedByOwnershipShare === true
        );
      }

      const result: Auction = {
        announcementId: auction.announcementId,
        title: auction.title,
        aiTitle: auction.aiTitle,
        aiWarning: auction.aiWarning,
        aiGursValuationMakesSense: null,
        aiSuitability: null,
        type: auction.type,
        isVacant: auction.isVacant,
        publicationDate: auction.publicationDate,
        dueDate: auction.dueDate,
        description: auction.description,
        location: auction.location,
        price: price,
        estimatedValue: estimatedValue,
        ownershipShare: auction.ownershipShare,
        yearBuilt: auction.yearBuilt,
        dataSourceCode: dataSource.code,
        urlSources: [announcementUrl],
        properties: properties,
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
        images: auction.images?.map((img) => ({
          description: img.description,
          sourceUrl: img.sourceUrl,
        })),
        priceToValueRatio: {
          toEstimatedValue,
          toPropertyValuations,
          totalPropertyValuation,
          valuationsReducedByOwnershipShare,
        },
        drivingInfo: null,
        publishedAt: null,
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
    await VisitedUrlRepository.markVisited(dataSource.code, announcementUrl);

    return results;
  } catch (err: any) {
    throw new Error(
      `Failed to process announcement for data source ${dataSource.code}, title "${objava.title}": ${err.message}`,
      { cause: err }
    );
    // logger.error(
    //   `Failed to process announcement for data source ${dataSource.code}, title "${objava.title}"`,
    //   err,
    //   {
    //     dataSourceCode: dataSource.code,
    //     title: objava.title,
    //     url: objava.url,
    //   }
    // );
    // return [];
  }

  async function processProperties(auction: AuctionBase): Promise<AuctionProperty[] | null> {
    if (!auction.properties) {
      return null;
    }

    const properties: AuctionProperty[] = [];
    const seen = new Set<string>();
    const buildings: PropertyKey[] = [];

    for (const property of auction.properties) {
      property.number = property.number.trim().replace(/[- ]/g, "/");

      // Skip duplicates based on cadastralMunicipality and number
      const key = `${property.cadastralMunicipality}-${property.number}`;
      if (seen.has(key)) {
        logger.log("Skipping duplicate property", {
          dataSourceCode: dataSource.code,
          propertyType: property.type,
          cadastralMunicipality: property.cadastralMunicipality,
          number: property.number,
        });
        continue;
      }
      seen.add(key);

      const ownershipShare = property.ownershipShare ?? auction.ownershipShare;
      const valuation = await fetchPropertyValuation(property, ownershipShare);
      const prostorData = await processPropertyProstor(property, valuation);

      if (prostorData?.building) {
        buildings.push(prostorData.building);
      }

      properties.push({ ...property, valuation, mapImageUrl: prostorData?.mapImageUrl });
    }

    // če gre za hišo na poralu sodnedrazbe.si pogoste ne vključujejo oznako stavbe, zato poskusimo zajeti še stavbo iz prostor.si
    if (auction.isHouse) {
      // find buiding or building_part properties
      const hasBuilding = properties.some(
        (p) => p.type === "building" || p.type === "building_part"
      );
      if (!hasBuilding && buildings.length > 0) {
        const buildingKey = buildings[0];
        // take ownership from auction or first property
        const ownershipShare =
          auction.ownershipShare ?? auction.properties[0].ownershipShare ?? null;

        // check if seen
        const key = `${buildingKey.cadastralMunicipality}-${buildingKey.number}`;
        if (!seen.has(key)) {
          const valuation = await fetchPropertyValuation(buildingKey, ownershipShare);
          const prostorData = await processPropertyProstor(buildingKey, valuation);

          properties.push({
            ...buildingKey,
            valuation,
            mapImageUrl: prostorData?.mapImageUrl,
          });
        }
      }
    }

    return properties;
  }

  async function processPropertyProstor(
    property: PropertyKey,
    valuation?: PropertyKey
  ): Promise<{
    mapImageUrl?: string;
    building: PropertyKey;
  } | null> {
    // Use valuation data if available (GURS may have corrected values)
    const key: PropertyKey = {
      type: valuation?.type ?? property.type,
      cadastralMunicipality: valuation?.cadastralMunicipality,
      number: valuation?.number,
    };

    try {
      const screenshot = await ProstorService.processProperty(key);

      if (!screenshot?.outputPath) {
        logger.warn("Failed to capture screenshot for property", {
          dataSourceCode: dataSource.code,
          ...key,
        });
        return undefined;
      }

      logger.log("Screenshot captured", {
        dataSourceCode: dataSource.code,
        screenshotPath: screenshot.outputPath,
        ...key,
      });

      // Upload screenshot to S3 (replace / with - in number to avoid path issues)
      const safeNumber = key.number.replace(/\//g, "-");
      const s3Key = `images/${key.cadastralMunicipality}-${safeNumber}.png`;
      const mapImageUrl = await S3Service.uploadFile(screenshot.outputPath, s3Key, "image/png");

      logger.log("Property screenshot uploaded", {
        dataSourceCode: dataSource.code,
        mapImageUrl,
      });

      return { mapImageUrl, building: screenshot.building };
    } catch (error) {
      logger.warn("Failed to capture property screenshot", {
        dataSourceCode: dataSource.code,
        propertyType: property.type,
        cadastralMunicipality: property.cadastralMunicipality,
        number: property.number,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async function fetchPropertyValuation(
    property: {
      type: "parcel" | "building" | "building_part";
      cadastralMunicipality: string;
      number: string;
    },
    ownershipShare: number | null
  ) {
    try {
      const valuation =
        (await GursValuationService.getValuation(property, ownershipShare)) ?? undefined;
      if (valuation) {
        logger.log("Property valuation fetched", {
          dataSourceCode: dataSource.code,
          propertyType: property.type,
          cadastralMunicipality: property.cadastralMunicipality,
          number: property.number,
          value: "value" in valuation ? valuation.value : undefined,
        });
      }
      return valuation;
    } catch (valuationErr) {
      logger.warn("Failed to fetch valuation for property", {
        dataSourceCode: dataSource.code,
        propertyType: property.type,
        cadastralMunicipality: property.cadastralMunicipality,
        number: property.number,
        error: valuationErr instanceof Error ? valuationErr.message : String(valuationErr),
      });
      return undefined;
    }
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

  const page = await ensurePage();
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
  // if (suitableLinks.length > 0) {
  //   logger.warn("Processing only first link (TEMP limitation)");
  //   suitableLinks = [suitableLinks[0]];
  // }

  // Step 2: Process each announcement
  logger.log(`Processing ${suitableLinks.length} actions from ${dataSource.name}`, {
    dataSourceCode: dataSource.code,
    count: suitableLinks.length,
  });
  const rezultati: Auction[] = [];

  for (const objava of suitableLinks) {
    const auctionResults = await processAuction(objava, dataSource);
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
  closeBrowser,
  fetchDocument,
};
