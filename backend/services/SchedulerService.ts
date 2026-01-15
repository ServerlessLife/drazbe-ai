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
    case "tuesday_friday":
      // Tuesday (2) and Friday (5)
      if (dayOfWeek === 2 || dayOfWeek === 5) {
        return todayMs; // Today is Tuesday or Friday
      }
      // Find days since last Tuesday or Friday
      const daysSinceTuesday = (dayOfWeek - 2 + 7) % 7;
      const daysSinceFriday = (dayOfWeek - 5 + 7) % 7;
      const daysSinceLastScheduled = Math.min(daysSinceTuesday, daysSinceFriday);
      return todayMs - daysSinceLastScheduled * DAY_MS;
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
  const sourcesPath = path.join(process.cwd(), "sources.json");
  const sources: Source[] = JSON.parse(fs.readFileSync(sourcesPath, "utf-8"));

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
