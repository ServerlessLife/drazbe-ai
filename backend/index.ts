import fs from "fs";
import { AiExtractService } from "./services/AiExtractService.js";
import { AuctionMarkdownService } from "./services/AuctionMarkdownService.js";
import { Source } from "./types/Source.js";
import { Auction } from "./types/Auction.js";
import { logger } from "./utils/logger.js";

// Load sources from JSON
const sources: Source[] = JSON.parse(fs.readFileSync("sources.json", "utf-8"));

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
        const safeAnnouncementId = announcementId.replace(/\//g, "-");
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
