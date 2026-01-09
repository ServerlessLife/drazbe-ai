import "dotenv/config";
import { DynamoDBStreamEvent } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { PropertyKey } from "../types/PropertyIdentifier.js";
import { PropertyQueueMessage, AuctionAnalysisQueueMessage } from "../types/QueueMessages.js";
import { logger } from "../utils/logger.js";

const sqsClient = new SQSClient({});

const PROPERTY_QUEUE_URL = process.env.PROPERTY_QUEUE_URL!;
const AUCTION_ANALYSIS_QUEUE_URL = process.env.AUCTION_ANALYSIS_QUEUE_URL!;

/**
 * Stream Processor Lambda - Routes DynamoDB stream events to appropriate queues
 * - PROPERTY records → Property queue (for ParcelScreenshotService)
 * - MAIN records → Auction Analysis queue (for AiAuctionAnalysisService)
 */
export async function handler(event: DynamoDBStreamEvent) {
  for (const record of event.Records) {
    // Only process INSERT events (newly created records)
    if (record.eventName !== "INSERT") {
      continue;
    }

    const newImage = record.dynamodb?.NewImage;
    if (!newImage) {
      continue;
    }

    const auctionId = newImage.auctionId?.S;
    const recordType = newImage.recordType?.S;

    if (!auctionId || !recordType) {
      logger.warn("Missing required fields in stream record", {
        hasAuctionId: !!auctionId,
        hasRecordType: !!recordType,
      });
      continue;
    }

    try {
      if (recordType === "PROPERTY") {
        // Extract property details from stream record
        const propertyType = newImage.type?.S as PropertyKey["type"] | undefined;
        const cadastralMunicipality = newImage.cadastralMunicipality?.S;
        const propertyNumber = newImage.number?.S;

        if (!propertyType || !cadastralMunicipality || !propertyNumber) {
          logger.warn("Missing property details in stream record", {
            auctionId,
            propertyType,
            cadastralMunicipality,
            propertyNumber,
          });
          continue;
        }

        // Send to property queue for screenshot processing
        const message: PropertyQueueMessage = {
          auctionId,
          type: propertyType,
          cadastralMunicipality,
          number: propertyNumber,
        };
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: PROPERTY_QUEUE_URL,
            MessageBody: JSON.stringify(message),
          })
        );
        logger.log("Sent PROPERTY record to property queue", {
          auctionId,
          propertyType,
          cadastralMunicipality,
          propertyNumber,
        });
      } else if (recordType === "MAIN") {
        // Send to auction analysis queue for AI processing
        const message: AuctionAnalysisQueueMessage = { auctionId };
        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: AUCTION_ANALYSIS_QUEUE_URL,
            MessageBody: JSON.stringify(message),
          })
        );
        logger.log("Sent MAIN record to auction analysis queue", { auctionId });
      }
    } catch (error) {
      logger.error("Failed to send message to queue", error, {
        auctionId,
        recordType,
      });
      // Don't throw - we want to continue processing other records
    }
  }

  return { statusCode: 200, body: "Stream processing completed" };
}
