import { SQSEvent } from "aws-lambda";
import { AiExtractService } from "../services/AiExtractService.js";
import { DataSourceService } from "../services/DataSourceService.js";
import { logger } from "../utils/logger.js";
import { SourceQueueMessage } from "../types/SourceQueueMessage.js";

/**
 * Queue Processor Lambda - Processes sources from SQS queue
 * Calls AiExtractService.processSource for each source
 */
export async function handler(event: SQSEvent) {
  logger.log("Processing sources from queue", { count: event.Records.length });

  // close browser if it is open from previous runs
  await AiExtractService.closeBrowser();

  for (const record of event.Records) {
    try {
      const message: SourceQueueMessage = JSON.parse(record.body);
      logger.log(`Processing source from queue`, { source: message.code });

      // Look up full source from sources.json
      const source = DataSourceService.getSourceByCode(message.code);
      if (!source) {
        logger.log(`Source not found in sources.json`, { code: message.code });
        continue;
      }

      await AiExtractService.processSource(source);

      logger.log("Successfully processed source", { source: message.code });
    } catch (error) {
      throw new Error(`Error processing source from queue: ${error}`, { cause: error });
    }
  }

  return { statusCode: 200, body: "Processing completed" };
}
