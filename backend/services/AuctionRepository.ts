import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  BatchWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { AuctionInternalWithValuations } from "../types/AuctionInternal.js";
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
  AuctionMain,
  AuctionProperty,
  AuctionPropertyValuation,
  AuctionPropertyMap,
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
 * Save an Auction to DynamoDB
 * Creates multiple records: MAIN, PROPERTY#id (with valuation), DOCUMENT#id, IMAGE#id
 */
async function save(auction: AuctionInternalWithValuations): Promise<void> {
  const announcementId = auction.announcementId || "unknown";
  const auctionId = generateAuctionId(auction.dataSourceCode, announcementId);
  const now = new Date().toISOString();
  const ttl = calculateTtl(auction.dueDate);

  // If LOCAL_STORAGE is true, save using logger instead of DynamoDB
  if (LOCAL_STORAGE) {
    logger.logContent(
      "Auction saved to local storage",
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
    type: auction.type,
    isSale: auction.isSale,
    publicationDate: auction.publicationDate,
    dueDate: auction.dueDate,
    description: auction.description,
    location: auction.location,
    price: auction.price,
    estimatedValue: auction.estimatedValue,
    ownershipShare: auction.ownershipShare,
    yearBuilt: auction.yearBuilt,
  };
  records.push(mainRecord);

  // Create PROPERTY records (including valuation data if available)
  if (auction.property) {
    for (const property of auction.property) {
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
 * Updates the existing PROPERTY record with the map URL
 */
async function savePropertyMap(
  dataSourceCode: string,
  id: string,
  property: Property,
  localUrl: string,
  dueDate: string | null
): Promise<void> {
  const auctionId = generateAuctionId(dataSourceCode, id);
  const propertyId = generatePropertyId(property);
  const now = new Date().toISOString();

  logger.log("Saving property map", {
    auctionId,
    propertyId,
    localUrl,
    localStorage: LOCAL_STORAGE,
  });

  const mapData: AuctionPropertyMap = { localUrl };

  // If LOCAL_STORAGE is true, just log the map data
  if (LOCAL_STORAGE) {
    logger.logContent(`property-map-${propertyId}.json`, mapData);
    logger.log("Property map saved to local storage", { auctionId, propertyId });
    return;
  }

  // Update the existing PROPERTY record by appending to maps array
  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        auctionId,
        recordKey: `PROPERTY#${propertyId}`,
      },
      UpdateExpression:
        "SET maps = list_append(if_not_exists(maps, :emptyList), :newMap), updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":emptyList": [],
        ":newMap": [mapData],
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
  let main: AuctionMain | null = null;
  const propertiesMap = new Map<
    string,
    { property: Property; valuation?: AuctionPropertyValuation; maps: AuctionPropertyMap[] }
  >();
  const documents: AuctionDocument[] = [];
  const images: AuctionImage[] = [];

  for (const record of records) {
    switch (record.recordType) {
      case "MAIN":
        main = stripDynamoDbFields(record) as AuctionMain;
        break;
      case "PROPERTY": {
        const { valuation, maps, ...propertyData } = stripDynamoDbFields(record) as Property & {
          valuation?: AuctionPropertyValuation;
          maps?: AuctionPropertyMap[];
        };
        const propertyId = generatePropertyId(propertyData);
        propertiesMap.set(propertyId, { property: propertyData, valuation, maps: maps || [] });
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

  // Combine properties with their valuation and maps
  const properties: AuctionProperty[] = Array.from(propertiesMap.values()).map(
    ({ property, valuation, maps }) => ({
      ...property,
      valuation,
      maps,
    })
  );

  const auction: Auction = {
    main,
    properties,
    documents,
    images,
  };

  return auction;
}

/**
 * Get the main record for an auction by ID
 * Returns clean AuctionMain without DynamoDB-specific fields
 */
async function getMainById(dataSourceCode: string, id: string): Promise<AuctionMain | null> {
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
    return stripDynamoDbFields(record) as AuctionMain;
  } else {
    logger.log("Auction main record not found in DynamoDB", { auctionId });
    return null;
  }
}

export const AuctionRepository = {
  save,
  savePropertyMap,
  getById,
  getMainById,
};
