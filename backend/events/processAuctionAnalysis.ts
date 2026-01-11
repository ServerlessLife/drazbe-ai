import { SQSEvent } from "aws-lambda";
import { AuctionRepository } from "../services/AuctionRepository.js";
import { UserSuitabilityRepository } from "../services/UserSuitabilityRepository.js";
import { AiAuctionAnalysisService } from "../services/AiAuctionAnalysisService.js";
import { AuctionMarkdownService } from "../services/AuctionMarkdownService.js";
import { GoogleMapsService } from "../services/GoogleMapsService.js";
import { Auction } from "../types/Auction.js";
import { DrivingResult } from "../types/DrivingResult.js";
import { AuctionAnalysisQueueMessage } from "../types/QueueMessages.js";
import { logger } from "../utils/logger.js";
import { config } from "../utils/config.js";

/**
 * Get driving info from home to the auction property
 * Uses first property's centroid that has one, or falls back to auction location
 */
async function getDrivingInfoFromHome(auction: Auction): Promise<DrivingResult | null> {
  const homeAddress = await config.get("HOME_ADDRESS");
  if (!homeAddress) {
    logger.warn("HOME_ADDRESS not configured, skipping driving info calculation");
    return null;
  }

  // Try to get centroid from first property that has one
  const centroid = auction.properties?.find((p) => p.valuation?.centroid)?.valuation?.centroid;

  if (centroid) {
    return GoogleMapsService.getDrivingInfo(homeAddress, centroid);
  }

  // Fallback to location address if available
  if (auction.location) {
    return GoogleMapsService.getDrivingInfo(homeAddress, auction.location);
  }

  return null;
}

/**
 * Auction Analysis Processor Lambda - Analyzes auctions with AI
 * Triggered by SQS messages from the stream processor
 */
export async function handler(event: SQSEvent) {
  for (const record of event.Records) {
    const message: AuctionAnalysisQueueMessage = JSON.parse(record.body);
    const { auctionId } = message;

    logger.log("Processing auction analysis", { auctionId });

    // Fetch the auction from DynamoDB
    const auction = await AuctionRepository.getById(auctionId);

    if (!auction) {
      throw new Error(`Auction not found: ${auctionId}`);
    }

    logger.log("Auction fetched", { auctionId, auction });

    // Calculate driving info from home
    let drivingInfo: DrivingResult | null = null;
    try {
      drivingInfo = await getDrivingInfoFromHome(auction);
      auction.drivingInfo = drivingInfo;
      logger.log("Driving info calculated", { auctionId, drivingInfo });

      await UserSuitabilityRepository.saveDrivingInfo(auctionId, drivingInfo);
    } catch (err) {
      logger.error("Failed to calculate driving info", {
        auctionId,
        error: err,
      });
    }

    const markdown = AuctionMarkdownService.formatAuctionMarkdown(auction);

    logger.log("Auction markdown generated", { auctionId, markdown });

    // Analyze with AI
    const analysis = await AiAuctionAnalysisService.analyzeAuction(markdown);

    logger.log("AI analysis completed", { auctionId, analysis });

    // Save the suitability and driving info to UserSuitabilityTable
    await UserSuitabilityRepository.saveSuitability(auctionId, analysis.aiSuitability);

    // Save the analysis to AuctionTable (aiWarning)
    await AuctionRepository.updateAuctionAnalysis(auctionId, {
      aiWarning: analysis.aiWarning,
    });

    logger.log("Auction analysis completed and saved", {
      auctionId,
      aiWarning: analysis.aiWarning,
      aiSuitability: analysis.aiSuitability,
    });
  }
}
