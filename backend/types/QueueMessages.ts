import { Link } from "./Link.js";
import { Source } from "./Source.js";

/**
 * Message payload for auction processing queue
 * Contains the link to process and the source configuration
 */
export type AuctionQueueMessage = {
  link: Link;
  source: Source;
};

/**
 * Message payload for auction analysis queue
 */
export type AuctionAnalysisQueueMessage = {
  auctionId: string;
};
