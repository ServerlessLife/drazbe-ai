import { AiExtractService } from "../services/AiExtractService.js";
import { AuctionRepository } from "../services/AuctionRepository.js";
import { AuctionMarkdownService } from "../services/AuctionMarkdownService.js";
import { DataSourceService } from "../services/DataSourceService.js";
import { GoogleMapsService } from "../services/GoogleMapsService.js";
import { AiAuctionAnalysisService } from "../services/AiAuctionAnalysisService.js";
import { Auction } from "../types/Auction.js";
import { logger } from "../utils/logger.js";

// Home address for driving time calculation
const HOME_ADDRESS = process.env.HOME_ADDRESS;

// Optional: Process only a specific source by code (set to null to process all enabled sources)
const ONLY_SOURCE_CODE: string | null = "velenje";

// Load sources from JSON
const sources = DataSourceService.getSources();

import { DrivingResult } from "../types/DrivingResult.js";

/**
 * Get driving info from home to the auction property
 * Uses first property's centroid that has one, or falls back to auction location
 */
async function getDrivingInfoFromHome(auction: Auction): Promise<DrivingResult | null> {
  if (!HOME_ADDRESS) {
    return null;
  }

  // Try to get centroid from first property that has one
  const centroid = auction.properties?.find((p) => p.valuation?.centroid)?.valuation?.centroid;

  if (centroid) {
    return GoogleMapsService.getDrivingInfo(HOME_ADDRESS, centroid);
  }

  // Fallback to location address if available
  if (auction.location) {
    return GoogleMapsService.getDrivingInfo(HOME_ADDRESS, auction.location);
  }

  return null;
}

async function main() {
  let sourcesToProcess = sources.filter((s) => s.enabled);

  // If ONLY_SOURCE_CODE is set, filter to just that source
  if (ONLY_SOURCE_CODE) {
    const specificSource = sources.find((s) => s.code === ONLY_SOURCE_CODE);
    if (!specificSource) {
      console.error(`Source with code "${ONLY_SOURCE_CODE}" not found`);
      process.exit(1);
    }
    sourcesToProcess = [specificSource];
    console.log(`Processing single source: ${specificSource.name} (${specificSource.code})`);
  } else {
    console.log(`Obdelujem ${sourcesToProcess.length} omogočenih virov...`);
  }

  const allResults: Array<{
    source: string;
    auctions: Auction[];
  }> = [];

  for (const source of sourcesToProcess) {
    try {
      const auctions = await AiExtractService.processSource(source);

      // Save each auction as nicely formatted markdown
      for (const auction of auctions) {
        const announcementId = auction.announcementId || "unknown";
        const safeAnnouncementId = announcementId.replace(/\//g, "-");

        // Calculate driving info from home
        let drivingInfo: DrivingResult | null = null;
        try {
          drivingInfo = await getDrivingInfoFromHome(auction);
          auction.drivingInfo = drivingInfo;
        } catch (err) {
          logger.warn("Failed to calculate driving info", {
            announcementId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const markdown = AuctionMarkdownService.formatAuctionMarkdown(auction);
        logger.logContent(
          "Auction markdown saved",
          { dataSourceCode: auction.dataSourceCode, announcementId },
          {
            content: markdown,
            prefix: auction.dataSourceCode,
            suffix: `${safeAnnouncementId}-auction`,
            extension: "md",
          }
        );

        // Analyze auction with AI
        try {
          const analysis = await AiAuctionAnalysisService.analyzeAuction(markdown);
          logger.logContent(
            "Auction analysis saved",
            { dataSourceCode: auction.dataSourceCode, announcementId },
            {
              content: JSON.stringify(analysis, null, 2),
              prefix: auction.dataSourceCode,
              suffix: `${safeAnnouncementId}-analysis`,
              extension: "json",
            }
          );
          logger.logContent(
            "Auction suitability saved",
            { dataSourceCode: auction.dataSourceCode, announcementId },
            {
              content: analysis.aiSuitability || "",
              prefix: auction.dataSourceCode,
              suffix: `${safeAnnouncementId}-suitability`,
              extension: "txt",
            }
          );
          logger.log("Auction analyzed", {
            announcementId,
            aiSuitability: analysis.aiSuitability,
            warningsCount: analysis.aiGursValuationWarnings.length,
          });
        } catch (err) {
          logger.warn("Failed to analyze auction", {
            announcementId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      allResults.push({ source: source.code, auctions });
    } catch (err) {
      console.error(`Napaka pri obdelavi vira ${source.name}:`, err);
    }
  }

  console.log(`\n========================================`);
  console.log(`Končano. Obdelanih ${allResults.length} virov.`);
  console.log(`========================================`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await AiExtractService.closeBrowser();
    process.exit();
  });
