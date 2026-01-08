// Re-export all DynamoDB types
export { AuctionRecordType, AuctionRecordBase } from "./AuctionRecordBase.js";
export { AuctionMainRecord } from "./AuctionMainRecord.js";
export { AuctionPropertyRecord } from "./AuctionPropertyRecord.js";
export { AuctionPropertyValuationRecord } from "./AuctionPropertyValuationRecord.js";
export { AuctionPropertyMapRecord } from "./AuctionPropertyMapRecord.js";
export { AuctionDocumentRecord } from "./AuctionDocumentRecord.js";
export { AuctionImageRecord } from "./AuctionImageRecord.js";
export { generateAuctionId, hashUrl, generatePropertyId } from "./helpers.js";
export {
  Auction,
  AuctionMain,
  AuctionProperty,
  AuctionPropertyValuation,
  AuctionPropertyMap,
} from "../Auction.js";

import { AuctionMainRecord } from "./AuctionMainRecord.js";
import { AuctionPropertyRecord } from "./AuctionPropertyRecord.js";
import { AuctionPropertyValuationRecord } from "./AuctionPropertyValuationRecord.js";
import { AuctionPropertyMapRecord } from "./AuctionPropertyMapRecord.js";
import { AuctionDocumentRecord } from "./AuctionDocumentRecord.js";
import { AuctionImageRecord } from "./AuctionImageRecord.js";

/**
 * Union type for all auction record types
 */
export type AuctionRecord =
  | AuctionMainRecord
  | AuctionPropertyRecord
  | AuctionPropertyValuationRecord
  | AuctionPropertyMapRecord
  | AuctionDocumentRecord
  | AuctionImageRecord;
