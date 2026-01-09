import fs from "fs";
import { AiExtractService } from "../services/AiExtractService.js";
import { AuctionRepository } from "../services/AuctionRepository.js";
import { GoogleMapsService } from "../services/GoogleMapsService.js";
import { Source } from "../types/Source.js";
import { Auction } from "../types/Auction.js";
import { logger } from "../utils/logger.js";

// Home address for driving time calculation
const HOME_ADDRESS = process.env.HOME_ADDRESS;

// Load sources from JSON
const sources: Source[] = JSON.parse(fs.readFileSync("sources.json", "utf-8"));

/**
 * Get driving time from home to the auction property
 * Uses first property's centroid that has one, or falls back to auction location
 */
async function getDrivingTimeFromHome(auction: Auction): Promise<number | null> {
  if (!HOME_ADDRESS) {
    return null;
  }

  // Try to get centroid from first property that has one
  const centroid = auction.properties?.find((p) => p.valuation?.centroid)?.valuation?.centroid;

  if (centroid) {
    return GoogleMapsService.getDrivingTime(HOME_ADDRESS, centroid);
  }

  // Fallback to location address if available
  if (auction.location) {
    return GoogleMapsService.getDrivingTime(HOME_ADDRESS, auction.location);
  }

  return null;
}

async function main() {
  const enabledSources = sources.filter((s) => s.enabled);
  console.log(`Obdelujem ${enabledSources.length} omogočenih virov...`);

  const allResults: Array<{
    source: string;
    auctions: Auction[];
  }> = [];

  for (const source of enabledSources) {
    try {
      const auctions = await AiExtractService.processSource(source);

      // Save each auction as nicely formatted markdown
      for (const auction of auctions) {
        const announcementId = auction.announcementId || "unknown";
        
        // Calculate driving time from home
        let drivingTimeMinutes: number | null = null;
        try {
          drivingTimeMinutes = await getDrivingTimeFromHome(auction);
        } catch (err) {
          logger.warn("Failed to calculate driving time", {
            announcementId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const markdown = AuctionRepository.formatAuctionMarkdown(auction, drivingTimeMinutes);
        logger.logContent(
          "Auction markdown saved",
          { dataSourceCode: auction.dataSourceCode, announcementId },
          {
            content: markdown,
            prefix: auction.dataSourceCode,
            suffix: `${announcementId}-auction`,
            extension: "md",
          }
        );
      }

      allResults.push({ source: source.code, auctions });
    } catch (err) {
      console.error(`Napaka pri obdelavi vira ${source.name}:`, err);
    }
  }

  await AiExtractService.close();

  console.log(`\n========================================`);
  console.log(`Končano. Obdelanih ${allResults.length} virov.`);
  console.log(`========================================`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
