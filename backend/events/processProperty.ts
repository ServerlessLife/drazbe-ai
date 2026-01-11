import { SQSEvent } from "aws-lambda";
import { AuctionRepository } from "../services/AuctionRepository.js";
import { ParcelScreenshotService } from "../services/ParcelScreenshotService.js";
import { S3Service } from "../services/S3Service.js";
import { PropertyQueueMessage } from "../types/QueueMessages.js";
import { logger } from "../utils/logger.js";

/**
 * Property Processor Lambda - Captures parcel screenshots for properties
 * Triggered by SQS messages from the stream processor
 */
export async function handler(event: SQSEvent) {
  logger.log("Processing property records from queue", { count: event.Records.length });

  for (const record of event.Records) {
    const message: PropertyQueueMessage = JSON.parse(record.body);
    const { auctionId, type, cadastralMunicipality, number } = message;

    logger.log("Processing property record", {
      auctionId,
      type,
      cadastralMunicipality,
      number,
    });

    // Capture screenshot using ParcelScreenshotService
    const screenshotPath = await ParcelScreenshotService.captureParcelScreenshot({
      type,
      cadastralMunicipality,
      number,
    });

    if (!screenshotPath) {
      logger.error("Failed to capture screenshot for property", {
        auctionId,
        type,
        cadastralMunicipality,
        number,
      });
      continue;
    }

    // Upload screenshot to S3
    const s3Key = `images/${auctionId}/${cadastralMunicipality}-${number}.png`;
    const mapImageUrl = await S3Service.uploadFile(screenshotPath, s3Key, "image/png");

    // Update the property record with the map image URL
    await AuctionRepository.updatePropertyMap(
      auctionId,
      { type, cadastralMunicipality, number },
      mapImageUrl
    );

    logger.log("Property screenshot captured and saved", {
      auctionId,
      mapImageUrl,
    });
  }

  return { statusCode: 200, body: "Property processing completed" };
}
