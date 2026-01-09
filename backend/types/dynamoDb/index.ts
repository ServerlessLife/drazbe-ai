// Re-export all DynamoDB types
export type { AuctionRecordType, AuctionRecordBase } from "./AuctionRecordBase.js";
export type { AuctionMainRecord } from "./AuctionMainRecord.js";
export type { AuctionPropertyRecord } from "./AuctionPropertyRecord.js";
export type { AuctionDocumentRecord } from "./AuctionDocumentRecord.js";
export type { AuctionImageRecord } from "./AuctionImageRecord.js";
export { generateAuctionId, hashUrl as hash, generatePropertyId } from "./helpers.js";
export type {
  Auction,
  AuctionProperty,
  AuctionPropertyValuation,
  PriceToValueRatio,
} from "../Auction.js";

import type { AuctionMainRecord } from "./AuctionMainRecord.js";
import type { AuctionPropertyRecord } from "./AuctionPropertyRecord.js";
import type { AuctionDocumentRecord } from "./AuctionDocumentRecord.js";
import type { AuctionImageRecord } from "./AuctionImageRecord.js";

/**
 * Union type for all auction record types
 */
export type AuctionRecord =
  | AuctionMainRecord
  | AuctionPropertyRecord
  | AuctionDocumentRecord
  | AuctionImageRecord;
