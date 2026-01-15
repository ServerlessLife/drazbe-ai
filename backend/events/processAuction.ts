import { SQSEvent } from "aws-lambda";
import { AiExtractService } from "../services/AiExtractService.js";
import { AuctionQueueMessage } from "../types/QueueMessages.js";
import { logger } from "../utils/logger.js";

/**
 * Auction Processor Lambda - Processes individual auction announcements from SQS queue
 * Triggered by messages from the DataSourceProcessor Lambda
 */
export async function handler(event: SQSEvent) {
  logger.log("Processing auctions from queue", { count: event.Records.length });

  // Close browser if it's open from previous invocations
  await AiExtractService.closeBrowser();

  for (const record of event.Records) {
    try {
      const message: AuctionQueueMessage = JSON.parse(record.body);
      const { link, source } = message;

      logger.log("Processing auction from queue", {
        body: record.body,
        title: link.title,
        url: link.url,
        sourceCode: source.code,
      });

      const results = await AiExtractService.processAuction(link, source);

      logger.log("Successfully processed auction", {
        title: link.title,
        sourceCode: source.code,
        auctionsExtracted: results.length,
      });
    } catch (error) {
      // Re-throw to allow SQS to retry if needed
      throw new Error(`Error processing auction from queue: ${error}`, { cause: error });
    }
  }

  // Close browser after processing
  await AiExtractService.closeBrowser();

  return { statusCode: 200, body: "Auction processing completed" };
}
