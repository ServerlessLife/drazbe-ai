import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  BatchWriteCommand,
  UpdateCommand,
  paginateQuery,
} from "@aws-sdk/lib-dynamodb";
import { Property } from "../types/Property.js";
import {
  AuctionMainRecord,
  AuctionPropertyRecord,
  AuctionDocumentRecord,
  AuctionImageRecord,
  AuctionRecord,
  generateAuctionId,
  hash,
  generatePropertyId,
  Auction,
  AuctionProperty,
  AuctionPropertyValuation,
} from "../types/dynamoDb/index.js";
import { logger } from "../utils/logger.js";
import { AuctionDocument } from "../types/AuctionDocument.js";
import { AuctionImage } from "../types/AuctionImage.js";
import { PropertyKey } from "../types/PropertyIdentifier.js";
import { UserSuitabilityRepository } from "./UserSuitabilityRepository.js";

const TABLE_NAME = process.env.AUCTION_TABLE_NAME || "AuctionTable";
const LOCAL_STORAGE = process.env.LOCAL_STORAGE === "true";
const ONE_DAY_IN_SECONDS = 24 * 60 * 60;
const DEFAULT_TTL_DAYS = 30;

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

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
 * Save an Auction to DynamoDB
 * Creates multiple records: MAIN, PROPERTY#id (with valuation), DOCUMENT#id, IMAGE#id
 */
async function save(auction: Auction): Promise<void> {
  const announcementId = auction.announcementId || "unknown";
  const sourceUrl = auction.urlSources[0] || "";
  const auctionId = generateAuctionId(auction.dataSourceCode, sourceUrl, announcementId);
  const now = new Date().toISOString();
  const ttl = calculateTtl(auction.dueDate);

  // If LOCAL_STORAGE is true, save using logger instead of DynamoDB
  if (LOCAL_STORAGE) {
    const safeAnnouncementId = announcementId.replace(/\//g, "-");
    logger.logContent(
      "Auction saved",
      { auctionId },
      {
        content: JSON.stringify(auction, null, 2),
        prefix: auction.dataSourceCode,
        suffix: `${safeAnnouncementId}-auction`,
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
    publishedAt: auction.publishedAt,
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
      const documentId = hash(document.sourceUrl);
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
      const imageId = hash(image.sourceUrl);
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
  sourceUrl: string,
  announcementId: string,
  property: Property,
  mapImageUrl: string,
  dueDate: string | null
): Promise<void> {
  const auctionId = generateAuctionId(dataSourceCode, sourceUrl, announcementId);
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
        suffix: `${announcementId}-property-map-${propertyId}`,
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
 * Get all records for an auction by auctionId
 * Returns a clean Auction object without DynamoDB-specific fields
 * Uses pagination to handle large result sets
 * @param auctionId - The partition key
 */
async function getById(auctionId: string): Promise<Auction | undefined> {
  logger.log("Fetching auction from DynamoDB", { auctionId });

  // Use paginator to fetch all records
  const records: AuctionRecord[] = [];
  const paginator = paginateQuery(
    { client: docClient },
    {
      TableName: TABLE_NAME,
      KeyConditionExpression: "auctionId = :auctionId",
      ExpressionAttributeValues: {
        ":auctionId": auctionId,
      },
    }
  );

  for await (const page of paginator) {
    if (page.Items) {
      records.push(...(page.Items as AuctionRecord[]));
    }
  }

  logger.log("Auction fetched from DynamoDB", {
    auctionId,
    recordCount: records.length,
  });

  if (records.length === 0) {
    return undefined;
  }

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

  if (!main) {
    throw new Error(`Auction main record not found in DynamoDB: ${auctionId}`);
  }

  // Combine properties with their valuation and mapImageUrl
  const properties: AuctionProperty[] = Array.from(propertiesMap.values()).map(
    ({ property, valuation, mapImageUrl }) => ({
      ...property,
      valuation,
      mapImageUrl,
    })
  );

  // Fetch user suitability data
  const suitabilityRecord = await UserSuitabilityRepository.getByAuctionId(auctionId);

  const auction: Auction = {
    ...main,
    auctionId,
    properties,
    documents,
    images,
    aiSuitability: suitabilityRecord?.aiSuitability ?? null,
    drivingInfo: suitabilityRecord?.drivingInfo ?? null,
  };

  return auction;
}

/**
 * Get a property record by auctionId and property key
 * @param auctionId - The partition key
 * @param propertyKey - The property identifier (type, cadastralMunicipality, number)
 */
async function getProperty(
  auctionId: string,
  propertyKey: PropertyKey
): Promise<AuctionPropertyRecord | null> {
  const recordKey = `PROPERTY#${generatePropertyId(propertyKey)}`;
  logger.log("Fetching property record from DynamoDB", { auctionId, recordKey });

  if (LOCAL_STORAGE) {
    logger.log("Local storage mode - cannot fetch property record");
    return null;
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "auctionId = :auctionId AND recordKey = :recordKey",
      ExpressionAttributeValues: {
        ":auctionId": auctionId,
        ":recordKey": recordKey,
      },
    })
  );

  const record = result.Items?.[0] as AuctionPropertyRecord | undefined;

  if (record) {
    logger.log("Property record fetched from DynamoDB", { auctionId, recordKey });
    return record;
  } else {
    logger.log("Property record not found in DynamoDB", { auctionId, recordKey });
    return null;
  }
}

/**
 * Update property map URL by keys
 * @param auctionId - The partition key
 * @param propertyKey - The property identifier (type, cadastralMunicipality, number)
 * @param mapImageUrl - The map image URL to save
 */
async function updatePropertyMap(
  auctionId: string,
  propertyKey: PropertyKey,
  mapImageUrl: string
): Promise<void> {
  const recordKey = `PROPERTY#${generatePropertyId(propertyKey)}`;
  const now = new Date().toISOString();

  logger.log("Updating property map by keys", {
    auctionId,
    recordKey,
    mapImageUrl,
    localStorage: LOCAL_STORAGE,
  });

  if (LOCAL_STORAGE) {
    logger.logContent(
      "Property map updated (local storage)",
      { auctionId, recordKey },
      {
        content: JSON.stringify({ mapImageUrl }, null, 2),
        prefix: "property-map",
        suffix: `${auctionId}-${recordKey}`,
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
        recordKey,
      },
      UpdateExpression: "SET mapImageUrl = :mapImageUrl, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":mapImageUrl": mapImageUrl,
        ":updatedAt": now,
      },
    })
  );

  logger.log("Property map saved to DynamoDB", { auctionId, recordKey });
}

/**
 * Update auction AI analysis fields by auctionId
 * @param auctionId - The partition key
 * @param analysis - The AI analysis result (aiWarning)
 */
async function updateAuctionAnalysis(
  auctionId: string,
  analysis: { aiWarning: string | null }
): Promise<void> {
  const now = new Date().toISOString();

  logger.log("Updating auction analysis", {
    auctionId,
    hasWarning: analysis.aiWarning !== null,
    localStorage: LOCAL_STORAGE,
  });

  if (LOCAL_STORAGE) {
    logger.logContent(
      "Auction analysis updated (local storage)",
      { auctionId },
      {
        content: JSON.stringify(analysis, null, 2),
        prefix: "auction-analysis",
        suffix: auctionId,
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
      UpdateExpression:
        "SET aiWarning = :aiWarning, gsiPk = :gsiPk, #date = :date, publishedAt = :publishedAt, updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#date": "date" },
      ExpressionAttributeValues: {
        ":aiWarning": analysis.aiWarning,
        ":gsiPk": "PUBLISHED",
        ":date": now,
        ":publishedAt": now,
        ":updatedAt": now,
      },
    })
  );

  logger.log("Auction analysis saved to DynamoDB", { auctionId });
}

const GSI_NAME = "public";
const GSI_LIMIT = 100;

/**
 * Get published auction IDs from GSI (most recent first)
 * @returns Array of auction IDs (up to 50)
 */
async function getPublishedAuctionIds(): Promise<string[]> {
  logger.log("Fetching published auction IDs");

  if (LOCAL_STORAGE) {
    logger.log("Local storage mode - cannot fetch auction IDs");
    return [];
  }

  const auctionIds: string[] = [];
  const paginator = paginateQuery(
    { client: docClient },
    {
      TableName: TABLE_NAME,
      IndexName: GSI_NAME,
      KeyConditionExpression: "gsiPk = :gsiPk",
      ExpressionAttributeValues: {
        ":gsiPk": "PUBLISHED",
      },
      ProjectionExpression: "auctionId",
      ScanIndexForward: false, // Most recent first
      Limit: GSI_LIMIT,
    }
  );

  for await (const page of paginator) {
    if (page.Items) {
      for (const item of page.Items) {
        auctionIds.push(item.auctionId as string);
        if (auctionIds.length >= GSI_LIMIT) {
          break;
        }
      }
    }
    if (auctionIds.length >= GSI_LIMIT) {
      break;
    }
  }

  logger.log("Published auction IDs fetched", { count: auctionIds.length });

  return auctionIds;
}

/**
 * Get published auctions with full data (most recent first)
 * @returns Array of auctions (up to 50)
 */
async function getPublishedAuctions(): Promise<Auction[]> {
  const auctionIds = await getPublishedAuctionIds();

  const auctionPromises = auctionIds.map((auctionId) => getById(auctionId));
  const auctionResults = await Promise.all(auctionPromises);

  const auctions = auctionResults.filter((auction): auction is Auction => auction !== undefined);

  logger.log("Published auctions fetched", { count: auctions.length });

  return auctions;
}

export const AuctionRepository = {
  save,
  savePropertyMap,
  getById,
  getProperty,
  updatePropertyMap,
  updateAuctionAnalysis,
  getPublishedAuctions,
};
