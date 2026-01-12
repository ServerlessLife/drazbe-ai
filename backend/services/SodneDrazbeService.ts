import { logger } from "../utils/logger.js";

interface SodneDrazbeData {
  values: {
    root: Record<string, unknown>;
    subjects: Array<Record<string, unknown>>;
    subjectFiles: Array<Array<Record<string, unknown>>>;
    files: Array<Record<string, unknown>>;
  };
}

/**
 * Format ISO date string to Slovenian locale format
 */
function formatDate(isoDate: string | null): string {
  if (!isoDate) return "";
  const date = new Date(isoDate);
  return date.toLocaleString("sl-SI", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format number to Slovenian locale with 2 decimal places
 */
function formatNumber(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const num = typeof value === "string" ? parseFloat(value) : value;
  return num.toLocaleString("sl-SI", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Format address object to a single string
 */
function formatAddress(addressRelation: Record<string, unknown> | null): string {
  if (!addressRelation) return "";
  const { street, houseNumber, zip, city, country } = addressRelation as {
    street?: string;
    houseNumber?: string;
    zip?: string;
    city?: string;
    country?: string;
  };
  return `${street || ""} ${houseNumber || ""}, ${zip || ""} ${city || ""}, ${country || ""}`.trim();
}

/**
 * Convert sodnedrazbe.si API response data to markdown format
 * Extracts property details, prices, subjects, images, and attachments
 */
function convertToMarkdown(data: SodneDrazbeData): string {
  const root = data.values.root;
  const subjects = data.values.subjects || [];
  const subjectFiles = data.values.subjectFiles || [];
  const files = data.values.files || [];

  const lines: string[] = [];

  // Header
  const registerType = (root.registerTypeRelation as Record<string, unknown>)?.valueContent || "";
  const caseNumber = root.caseNumber || "";
  const caseYear = root.caseYear || "";
  lines.push(`# Objava — Opravilna številka: ${registerType} / ${caseNumber} / ${caseYear}`);
  lines.push("");

  // Basic info
  lines.push(`- ID objave: ${root.publicationId || ""}`);
  lines.push(`- Datum objave: ${formatDate(root.publicationAt as string)}`);
  lines.push("");

  // Subjects - each with its own details and images
  if (subjects.length > 0) {
    lines.push("## Predmeti");
    lines.push("");

    subjects.forEach((subject, index) => {
      const saleSubject =
        (subject.saleSubjectRelation as Record<string, unknown>)?.valueContent || "";
      const subjectType =
        (subject.subjectTypeRelation as Record<string, unknown>)?.valueContent || "";
      const cadastralCode = subject.cadastralMunicipalityCode || "";
      const parcelNumber =
        subject.parcelNumber || subject.buildingNumber || subject.partNumber || "";
      const propertyId = `parcela ${cadastralCode} ${parcelNumber}`;

      lines.push(`### Predmet ${index + 1} — ${propertyId}`);
      lines.push("");
      lines.push(`- Predmet prodaje: ${saleSubject}`);
      lines.push(`- Vrsta predmeta: ${subjectType}`);
      lines.push(
        `- Vrsta nepremičnine: ${(subject.propertyTypeRelation as Record<string, unknown>)?.valueContent || ""}`
      );
      lines.push(
        `- Tip nepremičnine: ${(subject.propertyKindRelation as Record<string, unknown>)?.valueContent || ""}`
      );
      lines.push(`- Delež na predmetu: ${subject.shareInTheBasicLegalPosition || ""}`);
      lines.push(`- Šifra katastrske občine: ${cadastralCode}`);
      lines.push(`- Ime katastrske občine: ${subject.cadastralMunicipalityName || ""}`);
      lines.push(`- Številka parcele: ${subject.parcelNumber || ""}`);
      if (subject.buildingNumber) lines.push(`- Številka stavbe: ${subject.buildingNumber}`);
      if (subject.partNumber) lines.push(`- Številka dela: ${subject.partNumber}`);
      lines.push(`- **Površina (m²): ${formatNumber(subject.area as string)}**`);
      lines.push(`- **ID nepremičnine: ${propertyId}**`);
      lines.push("");

      // Address for this subject
      const address = formatAddress(subject.addressRelation as Record<string, unknown>);
      if (address) {
        lines.push(`#### Naslov`);
        lines.push(address);
        lines.push("");
      }

      // View/Ogled for this subject
      if (subject.viewStartAt) {
        lines.push(`#### Ogled`);
        lines.push(`- Čas ogleda: ${formatDate(subject.viewStartAt as string)}`);
        lines.push(`- Kdo vodi ogled: ${subject.viewLeader || ""}`);
        const viewAddress = formatAddress(subject.viewAddressRelation as Record<string, unknown>);
        if (viewAddress) lines.push(`- Kraj ogleda: ${viewAddress}`);
        lines.push("");
      }

      // Images for THIS subject (from subjectFiles[index])
      const subjectFileGroup = subjectFiles[index] || [];
      const subjectImages: string[] = [];
      subjectFileGroup.forEach((file) => {
        const fileRelation = file.fileIdRelation as Record<string, unknown>;
        if (fileRelation && (fileRelation.mimeType as string)?.startsWith("image/")) {
          const urlQuery = (fileRelation.urlQuery as string) || "";
          const url = `https://sodnedrazbe.si/public/download${urlQuery}`;
          const name = (fileRelation.safeName as string) || "Slika";
          subjectImages.push(`- ![${name}](${url})`);
        }
      });

      if (subjectImages.length > 0) {
        lines.push(`#### Slike predmeta ${index + 1}:`);
        lines.push(...subjectImages);
        lines.push("");
      }

      lines.push("---");
      lines.push("");
    });
  }

  // Case details
  lines.push("## Podatki o zadevi");
  lines.push(
    `- Vrsta postopka: ${(root.procedureTypeRelation as Record<string, unknown>)?.valueContent || ""}`
  );
  lines.push(`- Številka zadeve: ${root.caseNumber || ""}`);
  lines.push(`- Leto zadeve: ${root.caseYear || ""}`);
  lines.push(`- Sodišče: ${(root.courtRelation as Record<string, unknown>)?.valueContent || ""}`);
  lines.push(
    `- Vrsta vpisnika: ${(root.registerTypeRelation as Record<string, unknown>)?.valueContent || ""}`
  );
  lines.push("");

  // Sale details
  lines.push("## Podatki o prodaji");
  lines.push(
    `- Oblika prodaje: ${(root.saleFormRelation as Record<string, unknown>)?.valueContent || ""}`
  );
  lines.push(
    `- Način prodaje: ${(root.saleMethodRelation as Record<string, unknown>)?.valueContent || ""}`
  );
  lines.push(
    `- Vrsta prodaje: ${(root.saleTypeRelation as Record<string, unknown>)?.valueContent || ""}`
  );
  lines.push(`- Zaporedna številka dražbe: ${root.saleSequenceNumber || ""}`);
  lines.push(`- Datum in ura začetka prodaje: ${formatDate(root.saleStartAt as string)}`);
  lines.push(`- Datum in ura konca prodaje: ${formatDate(root.saleEndAt as string)}`);
  lines.push("");

  // Prices
  lines.push("## Varščina / Dražba (EUR)");
  lines.push(`- Ocenjena vrednost: ${formatNumber(root.estimatedPrice as string)}`);
  lines.push(`- Izklicna cena: ${formatNumber(root.startingPrice as string)}`);
  lines.push(`- Korak prodaje: ${formatNumber(root.stepPrice as string)}`);
  lines.push(`- Višina varščine: ${formatNumber(root.securityPrice as string)}`);
  lines.push("");

  // Attachments/Files
  const attachments: string[] = [];
  files.forEach((file) => {
    const fileRelation = file.fileIdRelation as Record<string, unknown>;
    const attachmentType =
      (file.attachmentTypeRelation as Record<string, unknown>)?.valueContent || "Dokument";
    if (fileRelation) {
      const urlQuery = (fileRelation.urlQuery as string) || "";
      const url = `https://sodnedrazbe.si/public/download${urlQuery}`;
      attachments.push(`- [${attachmentType}](${url})`);
    }
  });

  if (attachments.length > 0) {
    lines.push("## Priloge:");
    lines.push(...attachments);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Extract publication ID from sodnedrazbe.si URL
 * Expected format: sodnedrazbe.si/single/[UUID]
 */
function extractPublicationId(url: string): string | null {
  const urlMatch = url.match(/sodnedrazbe\.si\/single\/([a-f0-9-]+)/i);
  return urlMatch ? urlMatch[1] : null;
}

/**
 * Fetch auction data from sodnedrazbe.si API and convert to markdown
 * Uses direct API call instead of scraping HTML
 */
async function fetchMarkdown(fullUrl: string): Promise<string> {
  const publicationId = extractPublicationId(fullUrl);

  if (!publicationId) {
    logger.warn("Invalid sodnedrazbe URL format", {
      url: fullUrl,
      expectedPattern: "sodnedrazbe.si/single/[UUID]",
    });
    return "";
  }

  logger.log(`Fetching auction data from sodnedrazbe.si API`, {
    publicationId,
    url: fullUrl,
  });

  try {
    const jsonResponse = await fetch("https://api.sodnedrazbe.si/public/publication/single", {
      method: "POST",
      headers: {
        accept: "application/json",
        "accept-language": "sl-SI",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: publicationId }),
    });

    if (!jsonResponse.ok) {
      throw new Error(
        `Failed to fetch sodnedrazbe data frrom ${fullUrl}, HTTP ${jsonResponse.status}`
      );
      // logger.error("Failed to fetch sodnedrazbe data", new Error(`HTTP ${jsonResponse.status}`), {
      //   httpStatus: jsonResponse.status,
      //   publicationId,
      //   url: fullUrl,
      // });
      return "";
    }

    const jsonData = await jsonResponse.json();
    const dataSize = JSON.stringify(jsonData).length;

    logger.log(`Successfully fetched sodnedrazbe auction data`, {
      publicationId,
      dataSizeBytes: dataSize,
      subjectsCount: jsonData.values?.subjects?.length || 0,
      filesCount: jsonData.values?.files?.length || 0,
    });

    // Log the raw JSON data for debugging
    logger.logContent(
      `Sodnedrazbe API response for ${publicationId}`,
      { publicationId, dataSizeBytes: dataSize },
      {
        content: JSON.stringify(jsonData, null, 2),
        prefix: "sodnedrazbe",
        suffix: `api-response-${publicationId}`,
        extension: "json",
      }
    );

    const markdown = convertToMarkdown(jsonData);

    logger.log(`Converted sodnedrazbe data to markdown`, {
      publicationId,
      markdownLength: markdown.length,
    });

    return markdown;
  } catch (error) {
    throw new Error(`Failed to fetch sodnedrazbe data from ${fullUrl}`, { cause: error });
    // logger.error("Error fetching sodnedrazbe data", error, {
    //   publicationId,
    //   url: fullUrl,
    // });
    // return "";
  }
}

/**
 * Check if a URL is a sodnedrazbe.si auction URL
 */
function isSodneDrazbeUrl(url: string): boolean {
  return url.includes("sodnedrazbe.si/single/");
}

export const SodneDrazbeService = {
  fetchMarkdown,
  convertToMarkdown,
  isSodneDrazbeUrl,
  extractPublicationId,
};
