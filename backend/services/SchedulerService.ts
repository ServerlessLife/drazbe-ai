import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import fs from "fs";
import path from "path";
import { Source } from "../types/Source.js";
import { logger } from "../utils/logger.js";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true },
});
const sqsClient = new SQSClient({});

const QUEUE_URL = process.env.SOURCE_QUEUE_URL!;
const TABLE_NAME = process.env.SOURCE_TRIGGER_TABLE_NAME!;

// Batching configuration - set to false to process all eligible sources at once
const ENABLE_BATCHING = true;
const MAX_SOURCES_PER_RUN = 4;

interface SourceWithLastTrigger {
  source: Source;
  lastTrigger: number | null;
}

/**
 * Get the last trigger timestamp for a source
 */
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

/**
 * Update the last trigger timestamp for a source
 */
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

/**
 * Check if a source should be triggered based on its schedule
 */
function shouldTriggerBySchedule(schedule: string, dayOfWeek: number): boolean {
  switch (schedule) {
    case "daily":
      return true;
    case "workdays":
      // Monday (1) to Friday (5)
      return dayOfWeek >= 1 && dayOfWeek <= 5;
    case "tuesday_friday":
      // Tuesday (2) and Friday (5)
      return dayOfWeek === 2 || dayOfWeek === 5;
    default:
      return true;
  }
}

/**
 * Process scheduled sources - finds eligible sources and queues them for processing
 * When batching is enabled, processes only the oldest N sources per run
 */
async function processScheduledSources(): Promise<{ processed: number; total: number }> {
  logger.log("Starting source scheduler", { batchingEnabled: ENABLE_BATCHING });

  // Load sources
  const sourcesPath = path.join(process.cwd(), "sources.json");
  const sources: Source[] = JSON.parse(fs.readFileSync(sourcesPath, "utf-8"));

  const enabledSources = sources.filter((s) => s.enabled);
  logger.log(`Found enabled sources`, { count: enabledSources.length });

  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const now = Date.now();

  // Collect eligible sources with their last trigger times
  const eligibleSources: SourceWithLastTrigger[] = [];

  for (const source of enabledSources) {
    const schedule = source.schedule || "daily";

    if (!shouldTriggerBySchedule(schedule, dayOfWeek)) {
      logger.log(`Skipping source - schedule not met`, {
        source: source.code,
        schedule,
        dayOfWeek,
      });
      continue;
    }

    // Check last trigger time
    const lastTrigger = await getLastTrigger(source.code);

    // Only trigger if more than 23 hours have passed since last trigger
    if (lastTrigger && now - lastTrigger < 23 * 60 * 60 * 1000) {
      logger.log(`Skipping source - triggered recently`, {
        source: source.code,
        lastTrigger: new Date(lastTrigger).toISOString(),
      });
      continue;
    }

    eligibleSources.push({ source, lastTrigger });
  }

  logger.log(`Found eligible sources`, { count: eligibleSources.length });

  // Sort by last trigger time (oldest first, null = never triggered = highest priority)
  eligibleSources.sort((a, b) => {
    if (a.lastTrigger === null && b.lastTrigger === null) return 0;
    if (a.lastTrigger === null) return -1;
    if (b.lastTrigger === null) return 1;
    return a.lastTrigger - b.lastTrigger;
  });

  // Apply batching limit if enabled
  const sourcesToProcess = ENABLE_BATCHING
    ? eligibleSources.slice(0, MAX_SOURCES_PER_RUN)
    : eligibleSources;

  logger.log(`Processing sources`, {
    total: eligibleSources.length,
    processing: sourcesToProcess.length,
    batchingEnabled: ENABLE_BATCHING,
  });

  for (const { source, lastTrigger } of sourcesToProcess) {
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

    logger.log("Queued source for processing", {
      source: source.code,
      lastTrigger: lastTrigger ? new Date(lastTrigger).toISOString() : "never",
    });
  }

  logger.log("Scheduler completed");

  return {
    processed: sourcesToProcess.length,
    total: eligibleSources.length,
  };
}

export const SchedulerService = {
  processScheduledSources,
};
