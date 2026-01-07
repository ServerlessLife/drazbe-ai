import { chromium, Page, Browser, BrowserContext } from "playwright";
import fs from "fs";
import https from "https";
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
import { sodneDrazbeToMarkdown } from "../sodneDrazbe.js";
import { Source } from "./types/Source.js";
import { Announcement, AnnouncementResult, detailSchema } from "./types/Announcement.js";
import { suitableLinksSchema, SuitableLink } from "./types/SuitableLink.js";
import { DocumentResult } from "./types/DocumentResult.js";

const pdf2md = pdf2mdModule.default || pdf2mdModule;

// Custom fetch agent that ignores SSL certificate errors
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

// Private state
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
const openai = new OpenAI();

// ============================================================================
// Utility functions
// ============================================================================

function buildFullUrl(link: string, baseUrl: string): string {
  if (link.startsWith("http")) {
    return link;
  }
  const origin = new URL(baseUrl).origin;
  return `${origin}${link.startsWith("/") ? "" : "/"}${link}`;
}

function ensureExportFolder(): void {
  if (!fs.existsSync("export")) {
    fs.mkdirSync("export");
  }
}

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

// ============================================================================
// Browser management
// ============================================================================

async function ensureBrowser(): Promise<Page> {
  if (!browser) {
    browser = await chromium.launch({
      headless: false,
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

async function close(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    page = null;
  }
}

// ============================================================================
// AI extraction functions
// ============================================================================

async function compactHtml(html: string): Promise<string> {
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
    console.log("HTML minification failed, using original HTML");
    return html;
  }
}

async function extractContent(html: string, selector?: string): Promise<string> {
  // Remove script and style tags first
  const $ = cheerio.load(html);
  $("script").remove();
  $("style").remove();
  $("noscript").remove();

  let content: string;
  if (selector) {
    const selectedContent = $(selector).html();
    if (!selectedContent) {
      console.log(`Selector "${selector}" not found, using full HTML`);
      content = $.html();
    } else {
      content = selectedContent;
    }
  } else {
    content = $.html();
  }

  // Compact HTML to reduce token usage
  return await compactHtml(content);
}

async function extractSuitableLinks(
  pageHtml: string,
  sourceUrl: string,
  sourceCode: string,
  linksSelector?: string
): Promise<SuitableLink[]> {
  console.log("Korak 1: Izvlečem vse povezave do objav...");

  // Extract content using selector if provided
  const contentHtml = await extractContent(pageHtml, linksSelector);

  // Log extracted HTML to export folder for debugging
  ensureExportFolder();
  const date = new Date().toISOString().replace(/:/g, "-");
  fs.writeFileSync(`export/${sourceCode}-${date}-links-source.html`, contentHtml);

  // Adjust system prompt based on whether content was filtered
  const contextNote = linksSelector
    ? "Dobiš samo del HTML strani, ki vsebuje seznam povezav do objav. Vse povezave v tem delu so relevantne."
    : "Osredotočite se na glavno vsebino, ne na navigacijo, glave, noge in druge elemente, ki niso povezani z vsebino.";

  const response = await openai.chat.completions.create({
    //model: "gpt-5-mini",
    model: "gpt-5.2",
    messages: [
      {
        role: "system",
        content: `Si pomočnik, ki analizira HTML in izvleče ustrezne povezave do objav.
        Ustrezne so objave tipa:
        - 'dražba' (javna dražba za prodajo)
        - 'namera za sklenitev neposredne pogodbe' za PRODAJO (ne za najem/oddajo/menjavo)

        ${contextNote}

        POMEMBNO:
        - Izključi pretečene objave (kjer je rok veljavnosti že potekel - danes je ${new Date().toISOString().split("T")[0]})
        - Izključi duplikate (če je ista objava navedena večkrat, vrni samo enkrat)
        - Vrni polne URL-je.
        -

        Vrni JSON objekt z poljem "suitableLinks", ki vsebuje samo ustrezne povezave.
        Vsaka povezava naj ima polja: title, link (polni URL).

        Prepričaj se, da nisi spustil nobene ustrezne povezave!!!
        `,
      },
      {
        role: "user",
        content: `Analiziraj naslednji HTML in vrni ustrezne povezave do objav o prodaji nepremičnin:\n\n${contentHtml}`,
      },
    ],
    response_format: zodResponseFormat(suitableLinksSchema, "links"),
  });

  const filterResult = suitableLinksSchema.parse(
    JSON.parse(response.choices[0].message.content || "{}")
  );

  console.log(`Najdenih ${filterResult.suitableLinks.length} ustreznih povezav`);
  return filterResult.suitableLinks;
}

async function convertHtmlToMarkdown(
  pageHtml: string,
  sourceUrl: string,
  contentSelector?: string
): Promise<string> {
  // Extract content using selector if provided
  const contentHtml = await extractContent(pageHtml, contentSelector);

  // Adjust system prompt based on whether content was filtered
  const contextNote = contentSelector
    ? "Dobiš samo del HTML strani, ki vsebuje glavno vsebino objave. Celotna vsebina je relevantna."
    : "Osredotoči se na glavno vsebino objave. Odstrani navigacijo, glave, noge in druge elemente, ki niso del vsebine.";

  const markdownResponse = await openai.chat.completions.create({
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

  return markdownResponse.choices[0].message.content || "";
}

async function extractAnnouncementDetails(markdown: string): Promise<Announcement[]> {
  const detailResponse = await openai.chat.completions.parse({
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
    response_format: zodResponseFormat(detailSchema, "announcement_details"),
  });

  return detailResponse.choices[0].message.parsed!.announcements;
}

// ============================================================================
// Content fetching functions
// ============================================================================

async function fetchSodneDrazbeMarkdown(fullUrl: string): Promise<string> {
  const urlMatch = fullUrl.match(/sodnedrazbe\.si\/single\/([a-f0-9-]+)/i);
  if (!urlMatch) return "";

  const publicationId = urlMatch[1];
  const jsonResponse = await fetch("https://api.sodnedrazbe.si/public/publication/single", {
    method: "POST",
    headers: {
      accept: "application/json",
      "accept-language": "sl-SI",
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: publicationId }),
  });

  if (jsonResponse.ok) {
    return sodneDrazbeToMarkdown(await jsonResponse.json());
  }
  return "";
}

async function fetchPageMarkdown(
  page: Page,
  fullUrl: string,
  sourceUrl: string,
  contentSelector?: string
): Promise<string> {
  await page.goto(fullUrl);
  try {
    await page.waitForLoadState("networkidle", { timeout: 4000 });
  } catch (err) {
    console.log("Network idle timeout, nadaljujem...");
  }
  const pageHtml = await page.evaluate(() => document.body.innerHTML);
  return convertHtmlToMarkdown(pageHtml, sourceUrl, contentSelector);
}

async function fetchAndAppendDocuments(
  linksToDocuments: Array<{ description: string; url: string }>
): Promise<DocumentResult[]> {
  const results: DocumentResult[] = [];

  for (const doc of linksToDocuments) {
    try {
      if (doc.description.toLowerCase().includes("cenitveno poročilo")) {
        console.log(`Preskočim cenitveno poročilo: ${doc.url}`);
        continue;
      }

      console.log(`Prenašam dokument: ${doc.description} - ${doc.url}`);
      // @ts-ignore - Node.js fetch supports agent option
      const docResponse = await fetch(doc.url, { agent: insecureAgent });

      if (!docResponse.ok) {
        console.error(`Napaka pri prenosu: ${doc.url}, status: ${docResponse.status}`);
        continue;
      }

      const contentType = docResponse.headers.get("content-type") || "";
      const urlLower = doc.url.toLowerCase();
      const buffer = Buffer.from(await docResponse.arrayBuffer());

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
        console.log(`Dokument uspešno pretvorjen v markdown${ocrUsed ? " (OCR)" : ""}`);
      } else {
        console.log(`Ni bilo mogoče pretvoriti dokumenta v markdown: ${doc.url}`);
      }

      results.push({
        description: doc.description,
        url: doc.url,
        type: docType,
        ocrUsed,
        content,
      });
    } catch (docErr: any) {
      console.error(`Napaka pri obdelavi dokumenta ${doc.url}:`, docErr);
    }
  }

  return results;
}

async function pdfToMarkdown(buffer: Buffer): Promise<{ content: string; ocrUsed: boolean }> {
  // First try normal text extraction
  const pdfMarkdown = await pdf2md(buffer);

  // Check if text was extracted (more than just whitespace)
  const textContent = pdfMarkdown.replace(/\s+/g, "").trim();
  if (textContent.length > 50) {
    return { content: pdfMarkdown, ocrUsed: false };
  }

  // No text found, perform OCR
  console.log("PDF brez besedila, izvajam OCR...");

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
      console.log(`OCR stran ${pageNum}/${pdfDoc.numPages}...`);

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
      console.log(`OCR uspešen, prepoznanih ${ocrResults.length} strani`);
      return { content: ocrResults.join("\n\n"), ocrUsed: true };
    }

    console.log("OCR ni našel besedila");
    return { content: pdfMarkdown, ocrUsed: false };
  } catch (ocrErr) {
    console.error("Napaka pri OCR:", ocrErr);
    return { content: pdfMarkdown, ocrUsed: false };
  }
}

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

// ============================================================================
// Single announcement processing
// ============================================================================

async function processAnnouncement(
  page: Page,
  objava: SuitableLink,
  source: Source,
  date: string
): Promise<AnnouncementResult[]> {
  console.log(`Obiskujem: ${objava.title}, ${objava.link}`);

  const fullUrl = buildFullUrl(objava.link, source.url);
  let markdown: string = "";

  // Fetch content based on source type
  if (fullUrl.includes("sodnedrazbe.si/single/")) {
    try {
      markdown = await fetchSodneDrazbeMarkdown(fullUrl);
    } catch (jsonErr) {
      console.error("Napaka pri pridobivanju JSON podatkov:", jsonErr);
    }
  } else {
    markdown = await fetchPageMarkdown(page, fullUrl, source.url, source.contentSelector);
  }

  console.log("Podrobnosti:", markdown);

  // Extract and fetch document content
  const linksToDocuments = extractDocumentLinks(markdown);
  console.log("Najdene povezave do dokumentov:", linksToDocuments);
  const documents = await fetchAndAppendDocuments(linksToDocuments);

  // Check if initial content is short
  const isShortContent = markdown.length < 3000;

  // Check if there are non-OCR documents with sufficient content
  const hasOtherDocumentsWithContent = documents.some(
    (doc) => !doc.ocrUsed && doc.content && doc.content.replace(/\s+/g, "").length > 100
  );

  // Append documents to markdown
  for (const doc of documents) {
    if (!doc.content) continue;

    // Skip OCR documents unless content is short AND there are no other documents with content
    if (doc.ocrUsed && (!isShortContent || hasOtherDocumentsWithContent)) {
      console.log(`Preskočim OCR dokument (dovolj vsebine iz drugih virov): ${doc.description}`);
      continue;
    }

    markdown += `\n\n---\n\n## Dokument: ${doc.description}\n\n${doc.content}`;
  }

  // Save markdown to file
  const safeTitle = objava.title.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
  fs.writeFileSync(`export/${source.code}-${date}-${safeTitle}.md`, markdown);

  // Extract structured details
  const announcements = await extractAnnouncementDetails(markdown);

  // Map to results
  return announcements.map((announcement) => ({
    ...announcement,
    sourceCode: source.code,
    urlSources: [fullUrl],
  }));
}

// ============================================================================
// Main processing function
// ============================================================================

async function processSource(source: Source): Promise<{
  rezultati: AnnouncementResult[];
  prodajneObjave: AnnouncementResult[];
}> {
  const page = await ensureBrowser();

  console.log(`\n========================================`);
  console.log(`Obdelujem vir: ${source.name} (${source.code})`);
  console.log(`URL: ${source.url}`);
  console.log(`========================================\n`);

  const date = new Date().toISOString().replace(/:/g, "-");
  ensureExportFolder();

  let suitableLinks: SuitableLink[];

  // Use url directly if skipSearchingForLinks is true, otherwise extract from page
  if (source.skipSearchingForLinks) {
    console.log(`Uporabljam neposredno podano povezavo: ${source.url}`);
    suitableLinks = [
      {
        title: source.name,
        link: source.url,
      },
    ];
  } else {
    await page.goto(source.url);
    await page.waitForLoadState("networkidle");

    // Step 1: Extract suitable links from the page
    const pageHtml = await page.evaluate(() => document.body.innerHTML);
    suitableLinks = await extractSuitableLinks(
      pageHtml,
      source.url,
      source.code,
      source.linksSelector
    );

    // Save links to file
    fs.writeFileSync(
      `export/${source.code}-${date}-povezave.json`,
      JSON.stringify(suitableLinks, null, 2)
    );

    // TEMP: Only process first link for testing
    if (suitableLinks.length > 0) {
      suitableLinks = [suitableLinks[0]];
    }
  }

  // Step 2: Process each announcement
  console.log("Korak 3: Obiskujem posamezne objave...");
  const rezultati: AnnouncementResult[] = [];

  for (const objava of suitableLinks) {
    try {
      const announcementResults = await processAnnouncement(page, objava, source, date);
      rezultati.push(...announcementResults);
    } catch (err: any) {
      //console.error(`Napaka pri obdelavi ${objava.link}:`, err);
      throw new Error(`Napaka pri obdelavi ${objava.link}: ${err.message}`, { cause: err });
    }
  }

  // Step 3: Save results
  fs.writeFileSync(`export/${source.code}-${date}-vse.json`, JSON.stringify(rezultati, null, 2));

  const prodajneObjave = rezultati.filter((r) => r.isSale);
  console.log(`\nNajdenih ${prodajneObjave.length} prodajnih objav (dražbe in namere):`);
  fs.writeFileSync(
    `export/${source.code}-${date}-prodaja.json`,
    JSON.stringify(prodajneObjave, null, 2)
  );

  return { rezultati, prodajneObjave };
}

// ============================================================================
// Public API - Revealing module pattern
// ============================================================================

export const AiExtractService = {
  processSource,
  close,
};
