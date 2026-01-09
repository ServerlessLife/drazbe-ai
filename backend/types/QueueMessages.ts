import { PropertyKey } from "./PropertyIdentifier.js";

/**
 * Message payload for property processing queue
 */
export type PropertyQueueMessage = {
  auctionId: string;
} & PropertyKey;

/**
 * Message payload for auction analysis queue
 */
export type AuctionAnalysisQueueMessage = {
  auctionId: string;
};
