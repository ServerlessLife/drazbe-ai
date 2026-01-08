import "dotenv/config";
import { SQSEvent } from "aws-lambda";
import { AiExtractService } from "../services/AiExtractService.js";
import { Source } from "../types/Source.js";

/**
 * Queue Processor Lambda - Processes sources from SQS queue
 * Calls AiExtractService.processSource for each source
 */
export async function handler(event: SQSEvent) {
  console.log(`Processing ${event.Records.length} source(s) from queue`);

  for (const record of event.Records) {
    try {
      const source: Partial<Source> = JSON.parse(record.body);
      console.log(`Processing source: ${source.code}`);

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

      console.log(`Successfully processed source: ${source.code}`);
    } catch (error) {
      console.error("Error processing source:", error);
      // Re-throw to allow SQS to retry if needed
      throw error;
    }
  }

  return { statusCode: 200, body: "Processing completed" };
}
