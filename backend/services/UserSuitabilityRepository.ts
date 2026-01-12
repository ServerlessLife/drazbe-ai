import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  QueryCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { logger } from "../utils/logger.js";
import { DrivingResult } from "../types/DrivingResult.js";

const TABLE_NAME = process.env.USER_SUITABILITY_TABLE_NAME || "UserSuitabilityTable";
const LOCAL_STORAGE = process.env.LOCAL_STORAGE === "true";
const DEFAULT_USER_ID = "marko";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * User suitability record structure
 */
export type UserSuitabilityRecord = {
  userId: string;
  auctionId: string;
  aiSuitability?: string;
  drivingInfo?: DrivingResult | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Save AI suitability for an auction
 * @param auctionId - The auction ID
 * @param aiSuitability - The AI-generated suitability analysis
 * @param userId - The user ID (defaults to "marko")
 */
async function saveSuitability(
  auctionId: string,
  aiSuitability: string,
  userId: string = DEFAULT_USER_ID
): Promise<void> {
  const now = new Date().toISOString();

  logger.log("Saving user suitability", {
    userId,
    auctionId,
    localStorage: LOCAL_STORAGE,
  });

  if (LOCAL_STORAGE) {
    logger.logContent(
      "User suitability saved (local storage)",
      { userId, auctionId },
      {
        content: JSON.stringify({ userId, auctionId, aiSuitability }, null, 2),
        prefix: "user-suitability",
        suffix: `${userId}-${auctionId}`,
        extension: "json",
      }
    );
    return;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        userId,
        auctionId,
      },
      UpdateExpression:
        "SET aiSuitability = :aiSuitability, updatedAt = :updatedAt, createdAt = if_not_exists(createdAt, :createdAt)",
      ExpressionAttributeValues: {
        ":aiSuitability": aiSuitability,
        ":updatedAt": now,
        ":createdAt": now,
      },
    })
  );

  logger.log("User suitability saved to DynamoDB", { userId, auctionId });
}

/**
 * Save driving info for an auction
 * @param auctionId - The auction ID
 * @param drivingInfo - The driving info from home
 * @param userId - The user ID (defaults to "marko")
 */
async function saveDrivingInfo(
  auctionId: string,
  drivingInfo: DrivingResult | null,
  userId: string = DEFAULT_USER_ID
): Promise<void> {
  const now = new Date().toISOString();

  logger.log("Saving driving info", {
    userId,
    auctionId,
    localStorage: LOCAL_STORAGE,
  });

  if (LOCAL_STORAGE) {
    logger.logContent(
      "Driving info saved (local storage)",
      { userId, auctionId },
      {
        content: JSON.stringify({ userId, auctionId, drivingInfo }, null, 2),
        prefix: "driving-info",
        suffix: `${userId}-${auctionId}`,
        extension: "json",
      }
    );
    return;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        userId,
        auctionId,
      },
      UpdateExpression:
        "SET drivingInfo = :drivingInfo, updatedAt = :updatedAt, createdAt = if_not_exists(createdAt, :createdAt)",
      ExpressionAttributeValues: {
        ":drivingInfo": drivingInfo,
        ":updatedAt": now,
        ":createdAt": now,
      },
    })
  );

  logger.log("Driving info saved to DynamoDB", { userId, auctionId });
}

/**
 * Get user suitability for an auction
 * @param auctionId - The auction ID
 * @param userId - The user ID (defaults to "marko")
 */
async function getByAuctionId(
  auctionId: string,
  userId: string = DEFAULT_USER_ID
): Promise<UserSuitabilityRecord | null> {
  logger.log("Fetching user suitability from DynamoDB", { userId, auctionId });

  if (LOCAL_STORAGE) {
    logger.log("Local storage mode - cannot fetch user suitability");
    return null;
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        userId,
        auctionId,
      },
    })
  );

  const record = result.Item as UserSuitabilityRecord | undefined;

  if (record) {
    logger.log("User suitability fetched from DynamoDB", { userId, auctionId });
    return record;
  } else {
    logger.log("User suitability not found in DynamoDB", { userId, auctionId });
    return null;
  }
}

/**
 * Get all suitabilities for a user
 * @param userId - The user ID (defaults to "marko")
 */
async function getAllByUserId(userId: string = DEFAULT_USER_ID): Promise<UserSuitabilityRecord[]> {
  logger.log("Fetching all user suitabilities from DynamoDB", { userId });

  if (LOCAL_STORAGE) {
    logger.log("Local storage mode - cannot fetch user suitabilities");
    return [];
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    })
  );

  const records = (result.Items || []) as UserSuitabilityRecord[];

  logger.log("User suitabilities fetched from DynamoDB", {
    userId,
    count: records.length,
  });

  return records;
}

export const UserSuitabilityRepository = {
  saveSuitability,
  saveDrivingInfo,
  getByAuctionId,
  getAllByUserId,
};
