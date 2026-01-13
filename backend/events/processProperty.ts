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
    const { auctionId, type, cadastralMunicipality, number, valuation } = message;

    logger.log("Processing property record", {
      auctionId,
      type,
      cadastralMunicipality,
      number,
      valuation,
    });

    // Use valuation data if available (GURS may have corrected values)
    const screenshotKey = {
      type: valuation?.type ?? type,
      cadastralMunicipality: valuation?.cadastralMunicipality ?? cadastralMunicipality,
      number: valuation?.number ?? number,
    };

    logger.log("Using screenshot key", {
      original: { type, cadastralMunicipality, number },
      screenshotKey,
    });

    // Capture screenshot using ParcelScreenshotService
    const screenshot = await ParcelScreenshotService.captureParcelScreenshot(screenshotKey);

    if (!screenshot?.outputPath) {
      logger.warn("Failed to capture screenshot for property", {
        auctionId,
        screenshotKey,
      });
      continue;
    }

    logger.log("Screenshot captured", {
      auctionId,
      screenshotPath: screenshot.outputPath,
      ...screenshotKey,
      building: screenshot.building,
    });

    // Upload screenshot to S3
    const s3Key = `images/${auctionId}/${screenshotKey.cadastralMunicipality}-${screenshotKey.number}.png`;
    const mapImageUrl = await S3Service.uploadFile(screenshot.outputPath, s3Key, "image/png");

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
