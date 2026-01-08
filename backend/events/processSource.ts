import "dotenv/config";
import { SQSEvent } from "aws-lambda";
import { AiExtractService } from "../services/AiExtractService.js";
import { logger } from "../utils/logger.js";
import { Source } from "../types/Source.js";

/**
 * Queue Processor Lambda - Processes sources from SQS queue
 * Calls AiExtractService.processSource for each source
 */
export async function handler(event: SQSEvent) {
  logger.log("Processing sources from queue", { count: event.Records.length });

  for (const record of event.Records) {
    try {
      const source: Partial<Source> = JSON.parse(record.body);
      logger.log(`Processing source from queue`, { source: source.code });

      // Convert partial source to full Source object
      const fullSource: Source = {
        name: source.name!,
        code: source.code!,
        url: source.url!,
        enabled: true,
        schedule: source.schedule,
        skipSearchingForLinks: source.skipSearchingForLinks,
        linksSelector: source.linksSelector,
        contentSelector: source.contentSelector,
      };

      await AiExtractService.processSource(fullSource);

      logger.log("Successfully processed source", { source: source.code });
    } catch (error) {
      logger.error("Error processing source from queue", error, {
        source: (JSON.parse(record.body) as Partial<Source>).code,
      });
      // Re-throw to allow SQS to retry if needed
      throw error;
    }
  }

  return { statusCode: 200, body: "Processing completed" };
}
