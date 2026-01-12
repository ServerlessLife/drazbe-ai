import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { logger } from "../utils/logger.js";

const TABLE_NAME = process.env.VISITED_URL_TABLE_NAME || "VisitedUrlTable";
const LOCAL_STORAGE = process.env.LOCAL_STORAGE === "true";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

/**
 * Record structure for visited URLs in DynamoDB
 */
type VisitedUrlRecord = {
  /** Partition key: data source code */
  dataSourceCode: string;
  /** Sort key: the URL */
  url: string;
  /** Timestamp when the URL was visited */
  visitedAt: string;
};

/**
 * Check if a URL has been visited before for a specific data source
 * @param dataSourceCode - The data source code
 * @param url - The URL to check
 * @returns true if the URL was visited, false otherwise
 */
async function isVisited(dataSourceCode: string, url: string): Promise<boolean> {
  if (LOCAL_STORAGE) {
    // In local mode, never skip - always process
    return false;
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { dataSourceCode, url },
      })
    );

    const visited = !!result.Item;
    logger.log("Checked URL visit status", { dataSourceCode, url, visited });
    return visited;
  } catch (error) {
    logger.error("Failed to check visited URL", error, { dataSourceCode, url });
    // On error, return false to allow processing
    return false;
  }
}

/**
 * Mark a URL as visited for a specific data source
 * @param dataSourceCode - The data source code
 * @param url - The URL to mark as visited
 */
async function markVisited(dataSourceCode: string, url: string): Promise<void> {
  if (LOCAL_STORAGE) {
    return;
  }

  const now = new Date().toISOString();

  const record: VisitedUrlRecord = {
    dataSourceCode,
    url,
    visitedAt: now,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: record,
      })
    );
    logger.log("Marked URL as visited", { dataSourceCode, url });
  } catch (error) {
    logger.error("Failed to mark URL as visited", error, { dataSourceCode, url });
    // Don't throw - failing to mark shouldn't break processing
  }
}

export const VisitedUrlRepository = {
  isVisited,
  markVisited,
};
