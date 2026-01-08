import { AuctionRecordBase } from "./AuctionRecordBase.js";
import { AuctionDocument } from "../AuctionDocument.js";

/**
 * Document record for each document in an auction
 */
export type AuctionDocumentRecord = AuctionRecordBase & {
  recordType: "DOCUMENT";
  /** Sort key: DOCUMENT#hash(sourceUrl) */
  recordKey: `DOCUMENT#${string}`;
} & AuctionDocument;
