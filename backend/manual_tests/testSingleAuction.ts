import { AiExtractService } from "../services/AiExtractService.js";
import { AuctionMarkdownService } from "../services/AuctionMarkdownService.js";
import { GoogleMapsService } from "../services/GoogleMapsService.js";
import { AiAuctionAnalysisService } from "../services/AiAuctionAnalysisService.js";
import { Source } from "../types/Source.js";
import { Auction } from "../types/Auction.js";
import { Link } from "../types/Link.js";
import { DrivingResult } from "../types/DrivingResult.js";
import { logger } from "../utils/logger.js";

// Home address for driving time calculation
const HOME_ADDRESS = process.env.HOME_ADDRESS;

// Configure the auction URL to test
const AUCTION_URL =
  "https://www.nova-gorica.si/sl/javne-objave/javna-drazba-za-prodajo-nepremicnin-2026010813314139039/";

// Mock source for the auction
const mockSource: Source = {
  name: "Test Source",
  code: "test",
  url: new URL(AUCTION_URL).origin,
  enabled: true,
};

// Mock link for the auction
const mockLink: Link = {
  title: "Test Auction",
  url: AUCTION_URL,
  suitable: true,
  reason: "Manual test",
};

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
  console.log(`Processing single auction: ${AUCTION_URL}\n`);

  try {
    // Process the auction
    const auctions = await AiExtractService.processAuction(mockLink, mockSource);

    console.log(`\nExtracted ${auctions.length} auction(s)\n`);

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

    console.log(`\n========================================`);
    console.log(`Done. Processed ${auctions.length} auction(s).`);
    console.log(`========================================`);
  } catch (err) {
    console.error(`Error processing auction:`, err);
  }
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
