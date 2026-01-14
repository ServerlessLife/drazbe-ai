import { DynamoDBStreamEvent } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { AuctionAnalysisQueueMessage } from "../types/QueueMessages.js";
import { logger } from "../utils/logger.js";
import { S3Service } from "../services/S3Service.js";

const sqsClient = new SQSClient({});

const AUCTION_ANALYSIS_QUEUE_URL = process.env.AUCTION_ANALYSIS_QUEUE_URL!;

/**
 * Stream Processor Lambda - Routes DynamoDB stream events to appropriate queues
 * - INSERT MAIN records → Auction Analysis queue (for AiAuctionAnalysisService)
 * - REMOVE PROPERTY/DOCUMENT records → Delete S3 files
 */
export async function handler(event: DynamoDBStreamEvent) {
  for (const record of event.Records) {
    const eventName = record.eventName;

    if (eventName === "INSERT") {
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
        if (recordType === "MAIN") {
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
        logger.warn("Failed to send message to queue", error, {
          auctionId,
          recordType,
        });
        // Don't throw - we want to continue processing other records
      }
    } else if (eventName === "REMOVE") {
      // Handle deletion - clean up S3 files
      const oldImage = record.dynamodb?.OldImage;
      if (!oldImage) {
        continue;
      }

      const recordType = oldImage.recordType?.S;
      const auctionId = oldImage.auctionId?.S;

      if (recordType === "PROPERTY") {
        const mapImageUrl = oldImage.mapImageUrl?.S;
        if (mapImageUrl) {
          logger.log("Deleting property map image", { auctionId, mapImageUrl });
          await S3Service.deleteFile(mapImageUrl);
        }
      } else if (recordType === "DOCUMENT") {
        const localUrl = oldImage.localUrl?.S;
        if (localUrl) {
          logger.log("Deleting document", { auctionId, localUrl });
          await S3Service.deleteFile(localUrl);
        }
      }
    }
  }

  return { statusCode: 200, body: "Stream processing completed" };
}
