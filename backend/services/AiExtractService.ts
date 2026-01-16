import { Page, Browser } from "playwright-core";
import { launchBrowser } from "../utils/browser.js";
import * as fs from "fs";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import TurndownService from "turndown";
import * as cheerio from "cheerio";
import { minify } from "html-minifier-terser";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SodneDrazbeService } from "./SodneDrazbeService.js";
import { AuctionRepository } from "./AuctionRepository.js";
import { VisitedUrlRepository } from "./VisitedUrlRepository.js";
import { GursValuationService } from "./GursValuationService.js";
import { ProstorService } from "./ProstorService.js";
import { S3Service } from "./S3Service.js";
import { DocumentService } from "./DocumentService.js";
import { Source } from "../types/Source.js";
import { AuctionBase, auctionsBaseSchema } from "../types/AuctionBase.js";
import { Auction, AuctionProperty } from "../types/Auction.js";
import { linksSchema, Link } from "../types/Link.js";
import { DocumentResult, ExtractedPhoto } from "../types/DocumentResult.js";
import { AuctionQueueMessage } from "../types/QueueMessages.js";
import { logger } from "../utils/logger.js";
import { config } from "../utils/config.js";
import { PropertyKey } from "../types/PropertyIdentifier.js";

const sqsClient = new SQSClient({});
const AUCTION_QUEUE_URL = process.env.AUCTION_QUEUE_URL;
const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

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
        logger.logContent(
          `Selector "${selector}" not found, using full HTML`,
          {
            selector,
            dataSourceCode,
            sourceUrl,
          },
          {
            content: html,
            prefix: dataSourceCode,
            suffix: "links-source-fails",
            extension: "html",
          }
        );
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
- "Stanovanje v enostanovanjski stavbi" pomeni hišo. Ne upodabljaj termina "Stanovanje v enostanovanjski stavbi".

## NEPREMIČNINE (properties)
Natančno izvleci vse parcele in dele stavb:
- Vključi CELOTNO šifro (katastrska občina + številka)
- Pri delu stavbe NE vključi še celotne stavbe
- Pri hiši VEDNO poišči oznako stavbe/dela stavbe, ne le parcele
- Ne omenjaj povezane zemljiške parcele, kadar to ni relevantno.
- Ne podvajaj - vsako nepremičnino navedi enkrat
- Podatke o nepremičninah pripiši ustrezni objavi, če jih je več.
- Če je za vsak del navedena svoja cena, gre zagotovo za ločene dražbe.

## DELEŽ LASTNIŠTVA
- Pozorno preberi delež lastništva za vsako nepremičnino
- Delež je lahko podan kot ulomek (1/2) ali odstotek (50%)
- Če ni naveden, predpostavi 100%
- Kadar se prodaja hiša bodi pozoren na delež. Če se parcela ne prodaja v celoti se zagotovo tudi hiša ne.

## NEUSTREZNE OBJAVE!!!
- Če objava ni za prodajo/dražbo nepremičnine, označi isRealEstateSale=false
- Če gre za najem, oddajo, menjavo, označi isRealEstateSale=false
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
 * Process a single auction: fetch content, extract documents, and parse details
 * Fetches valuations, saves to DynamoDB, and returns structured auction data
 * Returns empty array if processing fails
 */
async function processAuction(objava: Link, dataSource: Source): Promise<Auction[]> {
  try {
    logger.log(`Starting processing for announcement: ${objava.title}`, {
      title: objava.title,
      url: objava.url,
      dataSourceCode: dataSource.code,
    });

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

    await ensurePage();

    if (dataSource.code === "ajpes") {
      // In case of AJPES, this is used to set cookies before processing auctions,
      // else individual auctions links do not work
      await openAjpesPage();
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
    const isPdfUrl = announcementUrl.toLowerCase().endsWith(".pdf");

    // If the announcement URL is a PDF, skip fetching page - we'll process the PDF as a document
    if (isPdfUrl) {
      logger.log("Announcement URL is a PDF, will process as document", {
        url: announcementUrl,
        dataSourceCode: dataSource.code,
      });
      // markdown stays empty - content will come from the PDF document
    } else if (SodneDrazbeService.isSodneDrazbeUrl(announcementUrl)) {
      // Fetch content based on source type
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
    // For PDF URLs, use the PDF itself as the only document
    let linksToDocuments: Array<{ description: string; url: string }>;
    if (isPdfUrl) {
      linksToDocuments = [{ description: objava.title || "Dokument", url: announcementUrl }];
    } else {
      linksToDocuments = extractDocumentLinks(markdown);
    }
    logger.log(
      `Found ${linksToDocuments.length} document links for data source ${dataSource.code}, title "${objava.title}"`,
      {
        url: announcementUrl,
        dataSourceCode: dataSource.code,
        count: linksToDocuments.length,
        documents: linksToDocuments.map((d) => d.description),
      }
    );

    const documents = await DocumentService.fetchDocuments(
      linksToDocuments,
      announcementUrl,
      dataSource.code,
      cookieHeader
    );

    // Extract photos from documents are in documents.photos

    // Check if initial content is short
    const isShortMainContent = markdown.length < 3000;

    // Check if there are non-OCR documents with sufficient content
    const weHaveAtLeastOneDocumentsWithContent = documents.documents.some(
      (doc) => doc.markdown?.replace(/\s+/g, "").length > 100
    );

    // Track which documents were used for extraction
    const usedDocumentUrls = new Set<string>();

    // Append documents to markdown
    for (const doc of documents.documents) {
      const isThisDocumentShort = !doc.markdown || doc.markdown.length <= 100;

      if (!isThisDocumentShort) {
        logger.log("Including document with sufficient content", {
          dataSourceCode: dataSource.code,
          document: doc.description,
          url: doc.url,
          markdownLength: doc.markdown?.length ?? 0,
        });

        markdown += `\n\n---\n\n## Dokument: ${doc.description}\n\n${doc.markdown}`;
        usedDocumentUrls.add(doc.url);
      } else {
        logger.log("Document has short content", {
          dataSourceCode: dataSource.code,
          document: doc.description,
          url: doc.url,
          markdownLength: doc.markdown?.length ?? 0,
        });

        // do not OCR document if you already have enough content

        // if isShortMainContent and !weHaveAtLeastOneDocumentsWithContent then OCR this document and include it
        // always include "Cenitveno poročilo"
        const isCenitvenoPorocilo = doc.description.toLowerCase().includes("cenitveno poročilo");
        const shouldIOcrDocument =
          (isShortMainContent && !weHaveAtLeastOneDocumentsWithContent) || isCenitvenoPorocilo;

        if (shouldIOcrDocument) {
          const reason = isCenitvenoPorocilo
            ? "Cenitveno poročilo - always included"
            : "Short content and no documents with content";

          logger.log("Document selected for OCR extraction", {
            dataSourceCode: dataSource.code,
            document: doc.description,
            url: doc.url,
            reason,
            isShortMainContent,
            hasDocumentsWithContent: weHaveAtLeastOneDocumentsWithContent,
            isThisDocumentShort,
            markdownLength: doc.markdown?.length ?? 0,
          });

          // use ocrPdfToMarkdown with the tmp file
          if (doc.tmpFilePath) {
            logger.log("Starting OCR for document", {
              dataSourceCode: dataSource.code,
              document: doc.description,
              tmpFilePath: doc.tmpFilePath,
            });

            try {
              const ocrResult = await DocumentService.ocrPdfToMarkdown(
                await fs.promises.readFile(doc.tmpFilePath)
              );

              logger.log("OCR completed for document", {
                dataSourceCode: dataSource.code,
                document: doc.description,
                ocrContentLength: ocrResult.content.length,
              });

              markdown += `\n\n---\n\n## Dokument: ${doc.description}\n\n${ocrResult.content}`;
              usedDocumentUrls.add(doc.url);
            } catch (ocrErr) {
              logger.warn("OCR failed for document", ocrErr, {
                dataSourceCode: dataSource.code,
                document: doc.description,
                tmpFilePath: doc.tmpFilePath,
              });
            }
          } else {
            logger.warn("Cannot OCR document - no tmpFilePath available", {
              dataSourceCode: dataSource.code,
              document: doc.description,
              url: doc.url,
            });
          }
        }
      }
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
      logger.log(`Value of isRealEstateSale: ${auction.isRealEstateSale}`, {
        dataSourceCode: dataSource.code,
        title: auction.title,
        type: auction.type,
      });

      if (!auction.isRealEstateSale) {
        logger.log("Skipping non-sale auction", {
          dataSourceCode: dataSource.code,
          title: auction.title,
          type: auction.type,
        });
        continue;
      }

      // check if the due date is in the past - if yes, skip
      if (auction.dueDate) {
        const dueDate = new Date(auction.dueDate);
        const now = new Date();
        if (dueDate < now) {
          logger.log("Skipping expired auction", {
            dataSourceCode: dataSource.code,
            title: auction.title,
            dueDate: auction.dueDate,
          });
          continue;
        }
      }

      // if dure date is not set, set it to 6 months from now
      if (!auction.dueDate) {
        const sixMonthsFromNow = new Date();
        sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
        auction.dueDate = sixMonthsFromNow.toISOString().split("T")[0];
        logger.log("Due date not set, defaulting to 6 months from now", {
          dataSourceCode: dataSource.code,
          title: auction.title,
          dueDate: auction.dueDate,
        });
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
            const foundDoc = documents.documents.find((d) => d.url === doc.sourceUrl);
            return {
              description: doc.description,
              sourceUrl: doc.sourceUrl,
              localUrl: foundDoc?.localUrl,
              type: foundDoc?.type,
              usedForExtraction: usedDocumentUrls.has(doc.sourceUrl),
            };
          }) ?? [],
        images: [
          // Original images from the announcement
          ...(auction.images?.map((img) => ({
            description: img.description,
            sourceUrl: img.sourceUrl,
          })) ?? []),
        ],
        priceToValueRatio: {
          toEstimatedValue,
          toPropertyValuations,
          totalPropertyValuation,
          valuationsReducedByOwnershipShare,
        },
        drivingInfo: null,
        publishedAt: null,
      };

      // If there are less than 3 images, extract more from PDF documents
      if ((result.images?.length ?? 0) < 3) {
        logger.log("Extracting additional photos from PDF documents", {
          currentImageCount: result.images?.length ?? 0,
          targetImageCount: 3,
          availableDocuments: documents.documents.length,
          dataSourceCode: dataSource.code,
        });

        for (const doc of documents.documents) {
          if ((result.images?.length ?? 0) >= 3) {
            logger.log("Reached target image count, stopping extraction", {
              imageCount: result.images?.length ?? 0,
              dataSourceCode: dataSource.code,
            });
            break;
          }

          if (doc.type !== "pdf") {
            logger.log("Skipping non-PDF document for photo extraction", {
              document: doc.description,
              type: doc.type,
              dataSourceCode: dataSource.code,
            });
            continue;
          }

          if (!doc.tmpFilePath) {
            logger.log("Skipping document without tmpFilePath", {
              document: doc.description,
              dataSourceCode: dataSource.code,
            });
            continue;
          }

          try {
            logger.log("Extracting photos from PDF document", {
              document: doc.description,
              tmpFilePath: doc.tmpFilePath,
              dataSourceCode: dataSource.code,
            });

            const pdfBuffer = await fs.promises.readFile(doc.tmpFilePath);
            const photos = await DocumentService.extractPhotosFromPdf(pdfBuffer, doc.url);

            logger.log("Photos extracted from PDF", {
              document: doc.description,
              photosFound: photos.length,
              dataSourceCode: dataSource.code,
            });

            for (const photo of photos) {
              result.images.push({
                description: doc.description ? `Foto iz ${doc.description}` : "Foto iz dokumenta",
                localUrl: photo.s3Key,
              });
              logger.log("Added photo to auction images", {
                s3Key: photo.s3Key,
                currentImageCount: result.images?.length ?? 0,
                dataSourceCode: dataSource.code,
              });
            }
          } catch (photoErr) {
            logger.warn("Failed to extract photos from PDF", photoErr, {
              document: doc.description,
              tmpFilePath: doc.tmpFilePath,
              dataSourceCode: dataSource.code,
            });
          }
        }

        logger.log("Photo extraction from documents complete", {
          finalImageCount: result.images?.length ?? 0,
          dataSourceCode: dataSource.code,
        });
      }

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

      // if more then 10 properties, skip processing to avoid timeout
      if (auction.properties.length > 10) {
        continue;
      }
      const ownershipShare = property.ownershipShare ?? auction.ownershipShare;
      const valuation = await fetchPropertyValuation(property, ownershipShare);
      const prostorData = await processPropertyProstor(property, valuation);

      if (prostorData?.buildings?.length > 0) {
        buildings.push(...prostorData.buildings);
      }

      properties.push({ ...property, valuation, mapImageUrl: prostorData?.mapImageUrl });
    }

    // če gre za hišo na poralu sodnedrazbe.si pogoste ne vključujejo oznako stavbe, zato poskusimo zajeti še stavbo iz prostor.si
    if (auction.isHouse && auction.properties.length <= 10) {
      // find buiding or building_part properties
      const hasBuilding = properties.some(
        (p) => p.type === "building" || p.type === "building_part"
      );
      if (!hasBuilding && buildings.length > 0) {
        // take ownership from auction or first property
        const ownershipShare =
          auction.ownershipShare ?? auction.properties[0].ownershipShare ?? null;

        // Process all buildings found on parcels
        for (const buildingKey of buildings) {
          // check if seen
          const key = `${buildingKey.cadastralMunicipality}-${buildingKey.number}`;
          if (!seen.has(key)) {
            seen.add(key);
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
    }

    return properties;
  }

  async function processPropertyProstor(
    property: PropertyKey,
    valuation?: PropertyKey
  ): Promise<{
    mapImageUrl?: string;
    buildings: PropertyKey[];
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

      return { mapImageUrl, buildings: screenshot.buildings };
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

/** Navigate to data source page
 * In case of AJPES, this is used to set cookies before processing auctions,
 * else individual auctions links do not work
 */
async function openAjpesPage() {
  await ensurePage();

  logger.log("Opening AJPES main page to set cookies");

  await page.goto(
    "https://www.ajpes.si/eObjave/rezultati.asp?podrobno=0&id_skupina=51&TipDolznika=-1&TipPostopka=-1&id_SkupinaVrsta=51&id_skupinaPodVrsta=86&Dolznik=&Oblika=&MS=&DS=&StStevilka=&Sodisce=-1&DatumDejanja_od=&DatumDejanja_do=&sys_ZacetekObjave_od=&sys_ZacetekObjave_do=&MAXREC=50"
  );
  await page.waitForLoadState("networkidle");
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

  await ensurePage();
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
    await page.waitForTimeout(2000);

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
  logger.log(`Processing ${suitableLinks.length} auctions from ${dataSource.name}`, {
    dataSourceCode: dataSource.code,
    count: suitableLinks.length,
  });

  // On Lambda with queue configured: send messages to SQS for parallel processing
  // Locally: process directly for easier debugging
  if (isLambda && AUCTION_QUEUE_URL) {
    logger.log("Sending auctions to queue for processing", {
      dataSourceCode: dataSource.code,
      count: suitableLinks.length,
      queueUrl: AUCTION_QUEUE_URL,
    });

    for (const objava of suitableLinks) {
      const message: AuctionQueueMessage = {
        link: objava,
        source: dataSource,
      };

      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: AUCTION_QUEUE_URL,
          MessageBody: JSON.stringify(message),
        })
      );

      logger.log("Sent auction to queue", {
        title: objava.title,
        url: objava.url,
        dataSourceCode: dataSource.code,
      });
    }

    logger.log(`All ${suitableLinks.length} auctions sent to queue for ${dataSource.name}`, {
      dataSourceCode: dataSource.code,
      count: suitableLinks.length,
    });

    // Return empty array - results will be saved by the auction processor Lambda
    return [];
  }

  // Local processing: process auctions directly
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
  processAuction,
  closeBrowser,
};
