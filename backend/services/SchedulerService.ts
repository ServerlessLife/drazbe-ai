import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { Source } from "../types/Source.js";
import { SourceQueueMessage } from "../types/SourceQueueMessage.js";
import { DataSourceService } from "./DataSourceService.js";
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
 * Get the timestamp of the start of the most recent scheduled day for a source.
 * This ensures sources are still processed if missed on their scheduled day.
 */
function getLastScheduledDayStart(schedule: string, now: Date): number {
  const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;

  switch (schedule) {
    case "daily":
      return todayMs;
    case "workdays":
      // Monday (1) to Friday (5)
      if (dayOfWeek >= 1 && dayOfWeek <= 5) {
        return todayMs; // Today is a workday
      } else if (dayOfWeek === 6) {
        return todayMs - DAY_MS; // Saturday -> last was Friday
      } else {
        return todayMs - 2 * DAY_MS; // Sunday -> last was Friday
      }
    case "4-days":
      // Triggers every 4 days - return start of today as reference point
      // The actual 4-day check is done in shouldProcessSource
      return todayMs;
    default:
      return todayMs;
  }
}

/**
 * Check if a source should be processed based on schedule and last trigger time.
 * Returns true if not processed since the last scheduled day.
 */
function shouldProcessSource(schedule: string, lastTrigger: number | null, now: Date): boolean {
  // Never triggered = definitely process
  if (lastTrigger === null) {
    return true;
  }

  const lastScheduledDayStart = getLastScheduledDayStart(schedule, now);

  // For 4-days schedule, ensure at least 4 days between triggers
  if (schedule === "4-days") {
    const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;
    const timeSinceLastTrigger = now.getTime() - lastTrigger;
    if (timeSinceLastTrigger < FOUR_DAYS_MS) {
      return false;
    }
    return true; // Process if 4+ days have passed
  }

  // Process if last trigger was before the last scheduled day started
  return lastTrigger < lastScheduledDayStart;
}

/**
 * Process scheduled sources - finds eligible sources and queues them for processing
 * When batching is enabled, processes only the oldest N sources per run
 */
async function processScheduledSources(): Promise<{ processed: number; total: number }> {
  logger.log("Starting source scheduler", { batchingEnabled: ENABLE_BATCHING });

  // Load sources
  const sources: Source[] = DataSourceService.loadSources();

  const enabledSources = sources.filter((s) => s.enabled);
  logger.log(`Found enabled sources`, { count: enabledSources.length });

  const today = new Date();
  const now = Date.now();

  // Collect eligible sources with their last trigger times
  const eligibleSources: SourceWithLastTrigger[] = [];

  for (const source of enabledSources) {
    const schedule = source.schedule || "daily";

    // Check last trigger time
    const lastTrigger = await getLastTrigger(source.code);

    // Check if source should be processed based on schedule and last trigger
    if (!shouldProcessSource(schedule, lastTrigger, today)) {
      logger.log(`Skipping source - already processed since last scheduled day`, {
        source: source.code,
        schedule,
        lastTrigger: lastTrigger ? new Date(lastTrigger).toISOString() : "never",
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
    // Send only the code to the queue - processor reads full source from sources.json
    const message: SourceQueueMessage = {
      code: source.code,
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
