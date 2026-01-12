import { Feed } from "feed";
import { marked } from "marked";
import { AuctionRepository } from "../services/AuctionRepository.js";
import { AuctionMarkdownService } from "../services/AuctionMarkdownService.js";
import { logger } from "../utils/logger.js";

/**
 * RSS Feed Lambda - Returns auctions as an RSS feed
 * Exposed via Lambda Function URL through CloudFront
 */
export async function handler() {
  logger.log("Generating RSS feed");

  try {
    const auctions = await AuctionRepository.getPublishedAuctions();

    logger.log("Auctions fetched for RSS feed", { count: auctions.length });

    const feed = new Feed({
      title: "Dražbe AI - Nepremičninske dražbe",
      description: "AI-analizirane nepremičninske dražbe v Sloveniji",
      id: "https://drazbe.ai/",
      link: "https://drazbe.ai/",
      language: "sl",
      copyright: `All rights reserved ${new Date().getFullYear()}`,
      updated: new Date(),
    });

    for (const auction of auctions) {
      const markdown = AuctionMarkdownService.formatAuctionMarkdown(auction);
      const baseTitle = auction.aiSuitability || auction.aiTitle || auction.title;

      let aiGursValuationMakesSense = auction.aiGursValuationMakesSense === false;

      //check if all properties have valuation, else set aiGursValuationMakesSense to false
      const allPropertiesHaveValuation = auction.properties?.every((p) => p.valuation !== undefined && p.valuation !== null);
      if (!allPropertiesHaveValuation) {
        aiGursValuationMakesSense = false;
      }

      const title = auction.dataSourceCode + ": " + (aiGursValuationMakesSense ? `⚠️ ${baseTitle}` : baseTitle);
      const link = auction.urlSources[0] || "";
      const pubDate = auction.publishedAt ? new Date(auction.publishedAt) : new Date();
      const html = await marked(markdown);

      feed.addItem({
        title,
        id: auction.announcementId || link,
        link,
        description: html,
        date: pubDate,
      });
    }

    const rss = feed.rss2();

    logger.log("RSS feed generated", { itemCount: auctions.length });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
      body: rss,
    };
  } catch (error) {
    logger.error("Failed to generate RSS feed", error);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "text/plain",
      },
      body: "Failed to generate RSS feed",
    };
  }
}
