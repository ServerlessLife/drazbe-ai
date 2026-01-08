import "dotenv/config";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import fs from "fs";
import path from "path";
import { Source } from "../types/Source.js";
import { logger } from "../utils/logger.js";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sqsClient = new SQSClient({});

const QUEUE_URL = process.env.SOURCE_QUEUE_URL!;
const TABLE_NAME = process.env.SOURCE_TRIGGER_TABLE_NAME!;

interface SchedulerEvent {
  time: string;
}

/**
 * Scheduler Lambda - Runs daily at 18:00 Slovenia time
 * Checks which sources need to be triggered based on their schedule
 */
export async function handler(event: SchedulerEvent) {
  logger.log("Starting source scheduler", { time: event.time });

  // Load sources
  const sourcesPath = path.join(process.cwd(), "sources.json");
  const sources: Source[] = JSON.parse(fs.readFileSync(sourcesPath, "utf-8"));

  const enabledSources = sources.filter((s) => s.enabled);
  logger.log(`Found enabled sources`, { count: enabledSources.length });

  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

  for (const source of enabledSources) {
    const schedule = source.schedule || "daily";
    let shouldTrigger = false;

    // Determine if source should be triggered based on schedule
    switch (schedule) {
      case "daily":
        shouldTrigger = true;
        break;
      case "workdays":
        // Monday (1) to Friday (5)
        shouldTrigger = dayOfWeek >= 1 && dayOfWeek <= 5;
        break;
      case "tuesday_friday":
        // Tuesday (2) and Friday (5)
        shouldTrigger = dayOfWeek === 2 || dayOfWeek === 5;
        break;
    }

    if (!shouldTrigger) {
      logger.log(`Skipping source - schedule not met`, {
        source: source.code,
        schedule,
        dayOfWeek,
      });
      continue;
    }

    // Check last trigger time
    const lastTrigger = await getLastTrigger(source.code);
    const now = Date.now();
    const dayInMs = 24 * 60 * 60 * 1000;

    // Only trigger if more than 23 hours have passed since last trigger
    if (lastTrigger && now - lastTrigger < 23 * 60 * 60 * 1000) {
      logger.log(`Skipping source - triggered recently`, {
        source: source.code,
        lastTrigger: new Date(lastTrigger).toISOString(),
      });
      continue;
    }

    // Send to queue
    const message = {
      name: source.name,
      code: source.code,
      url: source.url,
      skipSearchingForLinks: source.skipSearchingForLinks,
      linksSelector: source.linksSelector,
      contentSelector: source.contentSelector,
    };

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(message),
      })
    );

    // Update last trigger time
    await updateLastTrigger(source.code, now);

    logger.log("Queued source for processing", { source: source.code });
  }

  logger.log("Scheduler completed");
  return { statusCode: 200, body: "Scheduler completed" };
}

async function getLastTrigger(sourceCode: string): Promise<number | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "sourceCode = :code",
      ExpressionAttributeValues: {
        ":code": sourceCode,
      },
      ScanIndexForward: false,
      Limit: 1,
    })
  );

  return result.Items?.[0]?.timestamp || null;
}

async function updateLastTrigger(sourceCode: string, timestamp: number): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        sourceCode,
        timestamp,
        date: new Date(timestamp).toISOString(),
      },
    })
  );
}
