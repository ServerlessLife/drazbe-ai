import { AuctionRecordBase } from "./AuctionRecordBase.js";
import { Auction } from "../Auction.js";

/**
 * Main auction record containing core auction data
 * Reuses properties from Auction type, excluding arrays (properties, documents, images)
 * which are stored as separate records, and drivingInfo which is stored in UserSuitabilityTable
 */
export type AuctionMainRecord = AuctionRecordBase & {
  recordType: "MAIN";
  recordKey: "MAIN";
} & Omit<Auction, "properties" | "documents" | "images" | "drivingInfo">;
