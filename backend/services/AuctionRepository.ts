import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  BatchWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { Property } from "../types/Property.js";
import {
  AuctionMainRecord,
  AuctionPropertyRecord,
  AuctionDocumentRecord,
  AuctionImageRecord,
  AuctionRecord,
  generateAuctionId,
  hashUrl,
  generatePropertyId,
  Auction,
  AuctionProperty,
  AuctionPropertyValuation,
} from "../types/dynamoDb/index.js";
import { logger } from "../utils/logger.js";
import { AuctionDocument } from "../types/AuctionDocument.js";
import { AuctionImage } from "../types/AuctionImage.js";

const TABLE_NAME = process.env.AUCTION_TABLE_NAME || "AuctionTable";
const LOCAL_STORAGE = process.env.LOCAL_STORAGE === "true";
const ONE_DAY_IN_SECONDS = 24 * 60 * 60;
const DEFAULT_TTL_DAYS = 30;

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

/**
 * Calculate TTL as 1 day after dueDate
 * Falls back to 30 days from now if dueDate is null or invalid
 */
function calculateTtl(dueDate: string | null): number {
  if (dueDate) {
    const dueDateMs = Date.parse(dueDate);
    if (!isNaN(dueDateMs)) {
      return Math.floor(dueDateMs / 1000) + ONE_DAY_IN_SECONDS;
    }
  }

  // Fallback: 30 days from now
  return Math.floor(Date.now() / 1000) + DEFAULT_TTL_DAYS * ONE_DAY_IN_SECONDS;
}

/**
 * Format auction data as nicely formatted markdown
 * @param auction - The auction data
 * @param drivingTimeMinutes - Optional driving time from home in minutes
 */
function formatAuctionMarkdown(auction: Auction, drivingTimeMinutes?: number | null): string {
  const lines: string[] = [];

  // Title (use aiTitle if available, otherwise original title)
  lines.push(`# ${auction.aiTitle || auction.title}`);
  lines.push("");

  // Main details
  lines.push("## Osnovni podatki");
  lines.push("");
  if (auction.announcementId) lines.push(`- **ID objave:** ${auction.announcementId}`);
  lines.push(
    `- **Tip:** ${auction.type === "auction" ? "Javna dražba" : auction.type === "contract" ? "Neposredna pogodba" : "Drugo"}`
  );
  if (auction.publicationDate) lines.push(`- **Datum objave:** ${auction.publicationDate}`);
  if (auction.dueDate) lines.push(`- **Rok:** ${auction.dueDate}`);
  if (auction.location) lines.push(`- **Lokacija:** ${auction.location}`);
  if (drivingTimeMinutes != null) {
    const hours = Math.floor(drivingTimeMinutes / 60);
    const mins = drivingTimeMinutes % 60;
    const timeStr = hours > 0 ? `${hours} h ${mins} min` : `${mins} min`;
    lines.push(`- **Vožnja od doma:** ${timeStr}`);
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
        lines.push("#### Vrednotenje");
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
      lines.push(`![${desc}](${img.sourceUrl})`);
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

/**
 * Save an Auction to DynamoDB
 * Creates multiple records: MAIN, PROPERTY#id (with valuation), DOCUMENT#id, IMAGE#id
 */
async function save(auction: Auction): Promise<void> {
  const announcementId = auction.announcementId || "unknown";
  const auctionId = generateAuctionId(auction.dataSourceCode, announcementId);
  const now = new Date().toISOString();
  const ttl = calculateTtl(auction.dueDate);

  // If LOCAL_STORAGE is true, save using logger instead of DynamoDB
  if (LOCAL_STORAGE) {
    logger.logContent(
      "Auction saved",
      { auctionId },
      {
        content: JSON.stringify(auction, null, 2),
        prefix: auction.dataSourceCode,
        suffix: `${announcementId}-auction`,
        extension: "json",
      }
    );
    return;
  }

  logger.log("Saving auction to DynamoDB", {
    dataSourceCode: auction.dataSourceCode,
    announcementId,
    auctionId,
    ttl,
  });

  const records: AuctionRecord[] = [];

  // Create MAIN record
  const mainRecord: AuctionMainRecord = {
    auctionId,
    recordKey: "MAIN",
    recordType: "MAIN",
    createdAt: now,
    updatedAt: now,
    ttl,
    dataSourceCode: auction.dataSourceCode,
    announcementId,
    urlSources: auction.urlSources,
    title: auction.title,
    aiTitle: auction.aiTitle,
    aiWarning: auction.aiWarning,
    aiSuitability: auction.aiSuitability,
    type: auction.type,
    isVacant: auction.isVacant,
    publicationDate: auction.publicationDate,
    dueDate: auction.dueDate,
    description: auction.description,
    location: auction.location,
    price: auction.price,
    estimatedValue: auction.estimatedValue,
    ownershipShare: auction.ownershipShare,
    yearBuilt: auction.yearBuilt,
    priceToValueRatio: auction.priceToValueRatio,
  };
  records.push(mainRecord);

  // Create PROPERTY records (including valuation data if available)
  if (auction.properties) {
    for (const property of auction.properties) {
      const { valuation, ...propertyData } = property;
      const propertyRecord: AuctionPropertyRecord = {
        auctionId,
        recordKey: `PROPERTY#${generatePropertyId(propertyData)}`,
        recordType: "PROPERTY",
        createdAt: now,
        updatedAt: now,
        ttl,
        ...propertyData,
        valuation,
      };
      records.push(propertyRecord);
    }
  }

  // Create DOCUMENT records
  if (auction.documents) {
    for (const document of auction.documents) {
      const documentId = hashUrl(document.sourceUrl);
      const documentRecord: AuctionDocumentRecord = {
        auctionId,
        recordKey: `DOCUMENT#${documentId}`,
        recordType: "DOCUMENT",
        createdAt: now,
        updatedAt: now,
        ttl,
        ...document,
      };
      records.push(documentRecord);
    }
  }

  // Create IMAGE records
  if (auction.images) {
    for (const image of auction.images) {
      const imageId = hashUrl(image.sourceUrl);
      const imageRecord: AuctionImageRecord = {
        auctionId,
        recordKey: `IMAGE#${imageId}`,
        recordType: "IMAGE",
        createdAt: now,
        updatedAt: now,
        ttl,
        ...image,
      };
      records.push(imageRecord);
    }
  }

  // Batch write all records (DynamoDB allows up to 25 items per batch)
  const batches: AuctionRecord[][] = [];
  for (let i = 0; i < records.length; i += 25) {
    batches.push(records.slice(i, i + 25));
  }

  for (const batch of batches) {
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: batch.map((record) => ({
            PutRequest: {
              Item: record,
            },
          })),
        },
      })
    );
  }

  logger.log("Action saved to DynamoDB", {
    auctionId,
    recordCount: records.length,
  });
}

/**
 * Save property map/screenshot from ParcelScreenshotService
 * Updates the existing PROPERTY record with the map image URL
 */
async function savePropertyMap(
  dataSourceCode: string,
  id: string,
  property: Property,
  mapImageUrl: string,
  dueDate: string | null
): Promise<void> {
  const auctionId = generateAuctionId(dataSourceCode, id);
  const propertyId = generatePropertyId(property);
  const now = new Date().toISOString();

  logger.log("Saving property map", {
    auctionId,
    propertyId,
    mapImageUrl,
    localStorage: LOCAL_STORAGE,
  });

  // If LOCAL_STORAGE is true, just log the map data
  if (LOCAL_STORAGE) {
    logger.logContent(
      "Property map saved to local storage",
      { auctionId, propertyId },
      {
        content: JSON.stringify({ mapImageUrl }, null, 2),
        prefix: dataSourceCode,
        suffix: `${id}-property-map-${propertyId}`,
        extension: "json",
      }
    );
    return;
  }

  // Update the existing PROPERTY record with mapImageUrl
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        auctionId,
        recordKey: `PROPERTY#${propertyId}`,
      },
      UpdateExpression: "SET mapImageUrl = :mapImageUrl, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":mapImageUrl": mapImageUrl,
        ":updatedAt": now,
      },
    })
  );

  logger.log("Property map saved to DynamoDB", { auctionId, propertyId });
}

/**
 * Strip DynamoDB-specific fields from a record
 */
function stripDynamoDbFields<T extends AuctionRecord>(
  record: T
): Omit<T, "auctionId" | "recordKey" | "recordType" | "createdAt" | "updatedAt" | "ttl"> {
  const { auctionId, recordKey, recordType, createdAt, updatedAt, ttl, ...rest } = record;
  return rest as Omit<
    T,
    "auctionId" | "recordKey" | "recordType" | "createdAt" | "updatedAt" | "ttl"
  >;
}

/**
 * Get all records for an auction by ID
 * Returns a clean Auction object without DynamoDB-specific fields
 */
async function getById(dataSourceCode: string, id: string): Promise<Auction> {
  const auctionId = generateAuctionId(dataSourceCode, id);

  logger.log("Fetching auction from DynamoDB", {
    dataSourceCode,
    id,
    auctionId,
  });

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "auctionId = :auctionId",
      ExpressionAttributeValues: {
        ":auctionId": auctionId,
      },
    })
  );

  const records = (result.Items || []) as AuctionRecord[];

  logger.log("Auction fetched from DynamoDB", {
    auctionId,
    recordCount: records.length,
  });

  // Collect raw data from records
  let main: Omit<Auction, "properties" | "documents" | "images"> | null = null;
  const propertiesMap = new Map<
    string,
    { property: Property; valuation?: AuctionPropertyValuation; mapImageUrl?: string }
  >();
  const documents: AuctionDocument[] = [];
  const images: AuctionImage[] = [];

  for (const record of records) {
    switch (record.recordType) {
      case "MAIN":
        main = stripDynamoDbFields(record) as Omit<Auction, "properties" | "documents" | "images">;
        break;
      case "PROPERTY": {
        const { valuation, mapImageUrl, ...propertyData } = stripDynamoDbFields(
          record
        ) as Property & {
          valuation?: AuctionPropertyValuation;
          mapImageUrl?: string;
        };
        const propertyId = generatePropertyId(propertyData);
        propertiesMap.set(propertyId, { property: propertyData, valuation, mapImageUrl });
        break;
      }
      case "DOCUMENT":
        documents.push(stripDynamoDbFields(record) as AuctionDocument);
        break;
      case "IMAGE":
        images.push(stripDynamoDbFields(record) as AuctionImage);
        break;
    }
  }

  // Combine properties with their valuation and mapImageUrl
  const properties: AuctionProperty[] = Array.from(propertiesMap.values()).map(
    ({ property, valuation, mapImageUrl }) => ({
      ...property,
      valuation,
      mapImageUrl,
    })
  );

  const auction: Auction = {
    ...main!,
    properties,
    documents,
    images,
  };

  return auction;
}

/**
 * Get the main record for an auction by ID
 * Returns clean Auction main fields without DynamoDB-specific fields
 */
async function getMainById(
  dataSourceCode: string,
  id: string
): Promise<Omit<Auction, "properties" | "documents" | "images"> | null> {
  const auctionId = generateAuctionId(dataSourceCode, id);

  logger.log("Fetching auction main record from DynamoDB", {
    dataSourceCode,
    id,
    auctionId,
  });

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "auctionId = :auctionId AND recordKey = :recordKey",
      ExpressionAttributeValues: {
        ":auctionId": auctionId,
        ":recordKey": "MAIN",
      },
    })
  );

  const record = result.Items?.[0] as AuctionMainRecord | undefined;

  if (record) {
    logger.log("Auction main record fetched from DynamoDB", { auctionId });
    return stripDynamoDbFields(record) as Omit<Auction, "properties" | "documents" | "images">;
  } else {
    logger.log("Auction main record not found in DynamoDB", { auctionId });
    return null;
  }
}

/**
 * Update the aiTitle field for an auction
 * @param dataSourceCode - The data source code
 * @param id - The announcement ID
 * @param aiTitle - The AI-generated title
 */
async function setAiTitle(dataSourceCode: string, id: string, aiTitle: string): Promise<void> {
  const auctionId = generateAuctionId(dataSourceCode, id);
  const now = new Date().toISOString();

  logger.log("Setting aiTitle", {
    auctionId,
    aiTitle,
    localStorage: LOCAL_STORAGE,
  });

  if (LOCAL_STORAGE) {
    logger.logContent(
      "aiTitle updated (local storage)",
      { auctionId, aiTitle },
      {
        content: JSON.stringify({ aiTitle }, null, 2),
        prefix: dataSourceCode,
        suffix: `${id}-aiTitle`,
        extension: "json",
      }
    );
    return;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        auctionId,
        recordKey: "MAIN",
      },
      UpdateExpression: "SET aiTitle = :aiTitle, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":aiTitle": aiTitle,
        ":updatedAt": now,
      },
    })
  );

  logger.log("aiTitle saved to DynamoDB", { auctionId, aiTitle });
}

export const AuctionRepository = {
  save,
  savePropertyMap,
  getById,
  getMainById,
  formatAuctionMarkdown,
  setAiTitle,
};
