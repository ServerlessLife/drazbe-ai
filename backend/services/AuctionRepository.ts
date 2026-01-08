import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { AuctionInternal } from "../types/AuctionInternal.js";
import { Property } from "../types/Property.js";
import { ParcelValuation } from "../types/ParcelValuation.js";
import { BuildingPartValuation } from "../types/BuildingPartValuation.js";
import {
  AuctionMainRecord,
  AuctionPropertyRecord,
  AuctionPropertyValuationRecord,
  AuctionPropertyMapRecord,
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
 * Creates multiple records: MAIN, PROPERTY#id, DOCUMENT#id, IMAGE#id
 */
async function save(auction: AuctionInternal): Promise<void> {
  const accouncementId = auction.accouncementId || "unknown";
  const auctionId = generateAuctionId(auction.dataSourceCode, accouncementId);
  const now = new Date().toISOString();
  const ttl = calculateTtl(auction.dueDate);

  logger.log("Saving auction to DynamoDB", {
    dataSourceCode: auction.dataSourceCode,
    accouncementId,
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
    accouncementId,
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

  // Create PROPERTY records
  if (auction.property) {
    for (const property of auction.property) {
      const propertyRecord: AuctionPropertyRecord = {
        auctionId,
        recordKey: `PROPERTY#${generatePropertyId(property)}`,
        recordType: "PROPERTY",
        createdAt: now,
        updatedAt: now,
        ttl,
        ...property,
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
 * Save property valuation from ValuationService
 */
async function savePropertyValuation(
  dataSourceCode: string,
  id: string,
  property: Property,
  valuation: ParcelValuation | BuildingPartValuation,
  dueDate: string | null
): Promise<void> {
  const auctionId = generateAuctionId(dataSourceCode, id);
  const propertyId = generatePropertyId(property);
  const now = new Date().toISOString();
  const ttl = calculateTtl(dueDate);

  logger.log("Saving property valuation to DynamoDB", {
    auctionId,
    propertyId,
  });

  const record: AuctionPropertyValuationRecord = {
    auctionId,
    recordKey: `PROPERTY_VALUATION#${propertyId}`,
    recordType: "PROPERTY_VALUATION",
    createdAt: now,
    updatedAt: now,
    ttl,
    propertyId,
    ...valuation,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
    })
  );

  logger.log("Property valuation saved to DynamoDB", { auctionId, propertyId });
}

/**
 * Save property map/screenshot from ParcelScreenshotService
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
  const ttl = calculateTtl(dueDate);

  logger.log("Saving property map to DynamoDB", {
    auctionId,
    propertyId,
    localUrl,
  });

  const record: AuctionPropertyMapRecord = {
    auctionId,
    recordKey: `PROPERTY_MAP#${propertyId}`,
    recordType: "PROPERTY_MAP",
    createdAt: now,
    updatedAt: now,
    ttl,
    propertyId,
    localUrl,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
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
    { property: Property; valuations: AuctionPropertyValuation[]; maps: AuctionPropertyMap[] }
  >();
  const documents: AuctionDocument[] = [];
  const images: AuctionImage[] = [];

  for (const record of records) {
    switch (record.recordType) {
      case "MAIN":
        main = stripDynamoDbFields(record) as AuctionMain;
        break;
      case "PROPERTY": {
        const property = stripDynamoDbFields(record) as Property;
        const propertyId = generatePropertyId(property);
        if (!propertiesMap.has(propertyId)) {
          propertiesMap.set(propertyId, { property, valuations: [], maps: [] });
        } else {
          propertiesMap.get(propertyId)!.property = property;
        }
        break;
      }
      case "PROPERTY_VALUATION": {
        const { propertyId, ...valuation } = stripDynamoDbFields(record) as {
          propertyId: string;
        } & AuctionPropertyValuation;
        if (!propertiesMap.has(propertyId)) {
          propertiesMap.set(propertyId, { property: {} as Property, valuations: [], maps: [] });
        }
        propertiesMap.get(propertyId)!.valuations.push(valuation as AuctionPropertyValuation);
        break;
      }
      case "PROPERTY_MAP": {
        const { propertyId, ...mapData } = stripDynamoDbFields(record) as {
          propertyId: string;
        } & AuctionPropertyMap;
        if (!propertiesMap.has(propertyId)) {
          propertiesMap.set(propertyId, { property: {} as Property, valuations: [], maps: [] });
        }
        propertiesMap.get(propertyId)!.maps.push(mapData as AuctionPropertyMap);
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

  // Combine properties with their valuations and maps
  const properties: AuctionProperty[] = Array.from(propertiesMap.values()).map(
    ({ property, valuations, maps }) => ({
      ...property,
      valuations,
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
  savePropertyValuation,
  savePropertyMap,
  getById,
  getMainById,
};
