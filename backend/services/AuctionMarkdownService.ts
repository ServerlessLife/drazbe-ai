import { Auction } from "../types/dynamoDb/index.js";

/**
 * Format auction data as nicely formatted markdown
 * @param auction - The auction data
 */
function formatAuctionMarkdown(auction: Auction): string {
  const lines: string[] = [];
  const drivingInfo = auction.drivingInfo;

  // Title (use aiTitle if available, otherwise original title)
  lines.push(`# ${auction.aiTitle || auction.title}`);
  lines.push("");

  // AI Warning (if present)
  if (auction.aiWarning) {
    lines.push(`> ⚠️ **Opozorilo:** ${auction.aiWarning}`);
    lines.push("");
  }

  // Main details
  lines.push("## Osnovni podatki");
  lines.push("");
  if (auction.auctionId) lines.push(`- **Interni ID:** ${auction.auctionId}`);
  if (auction.announcementId) lines.push(`- **ID objave:** ${auction.announcementId}`);

  const typeLabels: Record<string, string> = {
    "public-auction": "Javna dražba",
    "classic-sale": "Klasična prodaja",
    "binding-public-bidding": "Zavezujoče javno zbiranje ponudb",
    "non-binding-public-bidding": "Nezavezujoče javno zbiranje ponudb",
    "intent-to-sell": "Namera o prodaji",
    "electronic-auction": "Elektronska dražba",
    "electronic-public-auction": "Elektronska javna dražba",
    other: "Drugo",
    // Legacy values
    auction: "Javna dražba",
    contract: "Neposredna pogodba",
  };
  lines.push(`- **Tip:** ${typeLabels[auction.type] || auction.type}`);

  if (auction.publicationDate) lines.push(`- **Datum objave:** ${auction.publicationDate}`);
  if (auction.dueDate) lines.push(`- **Rok:** ${auction.dueDate}`);
  if (auction.location) lines.push(`- **Lokacija:** ${auction.location}`);
  if (drivingInfo != null) {
    const hours = Math.floor(drivingInfo.drivingTimeMinutes / 60);
    const mins = drivingInfo.drivingTimeMinutes % 60;
    const timeStr = hours > 0 ? `${hours} h ${mins} min` : `${mins} min`;
    lines.push(`- **Vožnja od doma:** ${timeStr} (${drivingInfo.drivingDistanceKm} km)`);
  }
  if (auction.price) lines.push(`- **Cena:** ${auction.price.toLocaleString("sl-SI")} €`);
  if (auction.estimatedValue)
    lines.push(`- **Ocenjena vrednost:** ${auction.estimatedValue.toLocaleString("sl-SI")} €`);
  if (auction.ownershipShare) lines.push(`- **Delež lastništva:** ${auction.ownershipShare}%`);
  if (auction.yearBuilt) lines.push(`- **Leto izgradnje:** ${auction.yearBuilt}`);
  if (auction.isVacant && auction.isVacant !== "UNKNOWN") {
    lines.push(`- **Prazno:** ${auction.isVacant === "YES" ? "Da" : "Ne"}`);
  }

  // Price to value ratio section (Relativna cena)
  const { toEstimatedValue, toPropertyValuations } = auction.priceToValueRatio;
  if (toEstimatedValue !== null || toPropertyValuations !== null) {
    lines.push("");
    lines.push("### Relativna cena");
    lines.push("");

    // Determine which discount is higher (better deal)
    const estHigher =
      toEstimatedValue !== null &&
      (toPropertyValuations === null || toEstimatedValue >= toPropertyValuations);
    const valHigher =
      toPropertyValuations !== null &&
      (toEstimatedValue === null || toPropertyValuations > toEstimatedValue);

    // Format percentage with sign (negative = price below value = good deal)
    const formatPercent = (value: number) => (value > 0 ? `-${value}` : `+${Math.abs(value)}`);

    if (toEstimatedValue !== null) {
      const suffix = estHigher ? "**" : "";
      const prefixBold = estHigher ? "**" : "";
      lines.push(
        `- ${prefixBold}Glede na ocenjeno vrednost cenilca: ${formatPercent(toEstimatedValue)}%${suffix}`
      );
    }
    if (toPropertyValuations !== null) {
      const suffix = valHigher ? "**" : "";
      const prefixBold = valHigher ? "**" : "";
      lines.push(
        `- ${prefixBold}Glede na GURS posplošeno vrednost: ${formatPercent(toPropertyValuations)}%${suffix}`
      );
    }
  }
  lines.push("");

  // Description
  if (auction.description) {
    lines.push("## Opis");
    lines.push("");
    lines.push(auction.description);
    lines.push("");
  }

  // Properties
  if (auction.properties && auction.properties.length > 0) {
    lines.push("## Nepremičnine");
    lines.push("");
    for (const prop of auction.properties) {
      const typeLabel = prop.type === "parcel" ? "" : prop.type === "building" ? "*" : "*";
      const propId = `${prop.cadastralMunicipality}-${typeLabel}${prop.number}`;
      lines.push(`### ${propId}`);
      lines.push("");
      lines.push(
        `- **Tip:** ${prop.type === "parcel" ? "Parcela" : prop.type === "building" ? "Stavba" : "Del stavbe"}`
      );
      if (prop.parcelType) lines.push(`- **Vrsta parcele:** ${prop.parcelType}`);
      if (prop.buildingType) lines.push(`- **Vrsta stavbe:** ${prop.buildingType}`);
      if (prop.area) lines.push(`- **Površina:** ${prop.area} m²`);
      if (prop.ownershipShare) lines.push(`- **Delež lastništva:** ${prop.ownershipShare}%`);

      // Map image
      if (prop.mapImageUrl) {
        lines.push("");
        lines.push(`![Zemljevid](${prop.mapImageUrl})`);
      }

      // Valuation
      if (prop.valuation) {
        lines.push("");
        lines.push("#### GURS vrednotenje");
        lines.push(
          `- **KO-številka:** ${prop.valuation.cadastralMunicipality}-${prop.valuation.number}`
        );
        lines.push(`- **Vrednost:** ${prop.valuation.value.toLocaleString("sl-SI")} €`);
        if ("surfaceArea" in prop.valuation && prop.valuation.surfaceArea) {
          lines.push(`- **Površina:** ${prop.valuation.surfaceArea} m²`);
        }
        if ("netFloorArea" in prop.valuation && prop.valuation.netFloorArea) {
          lines.push(`- **Neto tlorisna površina:** ${prop.valuation.netFloorArea} m²`);
        }
        if ("intendedUse" in prop.valuation && prop.valuation.intendedUse) {
          lines.push(`- **Namenska raba:** ${prop.valuation.intendedUse}`);
        }
        if ("actualUse" in prop.valuation && prop.valuation.actualUse) {
          lines.push(`- **Dejanska raba:** ${prop.valuation.actualUse}`);
        }
        if ("buildingType" in prop.valuation && prop.valuation.buildingType) {
          lines.push(`- **Tip stavbe:** ${prop.valuation.buildingType}`);
        }
        if ("yearBuilt" in prop.valuation && prop.valuation.yearBuilt) {
          lines.push(`- **Leto izgradnje:** ${prop.valuation.yearBuilt}`);
        }
        if ("address" in prop.valuation && prop.valuation.address) {
          lines.push(`- **Naslov:** ${prop.valuation.address}`);
        }
      }
      lines.push("");
    }
  }

  // Documents
  if (auction.documents && auction.documents.length > 0) {
    lines.push("## Dokumenti");
    lines.push("");
    for (const doc of auction.documents) {
      const desc = doc.description || "Dokument";
      lines.push(`- [${desc}](${doc.sourceUrl})`);
    }
    lines.push("");
  }

  // Images
  if (auction.images && auction.images.length > 0) {
    lines.push("## Slike");
    lines.push("");
    for (const img of auction.images) {
      const desc = img.description || "Slika";
      lines.push(`- [${desc}](${img.sourceUrl})`);
    }
    lines.push("");
  }

  // Source URLs
  if (auction.urlSources && auction.urlSources.length > 0) {
    lines.push("## Viri");
    lines.push("");
    for (const url of auction.urlSources) {
      lines.push(`- ${url}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export const AuctionMarkdownService = {
  formatAuctionMarkdown,
};
