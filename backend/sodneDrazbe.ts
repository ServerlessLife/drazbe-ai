import { readFileSync, writeFileSync } from "fs";

interface SodneDrazbeData {
  values: {
    root: Record<string, unknown>;
    subjects: Array<Record<string, unknown>>;
    subjectFiles: Array<Array<Record<string, unknown>>>;
    files: Array<Record<string, unknown>>;
  };
}

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

function formatNumber(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const num = typeof value === "string" ? parseFloat(value) : value;
  return num.toLocaleString("sl-SI", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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

export function sodneDrazbeToMarkdown(data: SodneDrazbeData): string {
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

// Read data from JSON file and test the function
// const data = JSON.parse(readFileSync("sodneDrazbeData.json", "utf-8")) as SodneDrazbeData;
// const md = sodneDrazbeToMarkdown(data);
// writeFileSync("sodneDrazbe.md", md);
