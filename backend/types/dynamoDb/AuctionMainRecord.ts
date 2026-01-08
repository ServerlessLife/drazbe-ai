import { AuctionRecordBase } from "./AuctionRecordBase.js";
import { AuctionInternal } from "../AuctionInternal.js";

/**
 * Main auction record containing core auction data
 * Reuses properties from Auction type, excluding arrays (property, documents, images)
 * which are stored as separate records
 */
export type AuctionMainRecord = AuctionRecordBase & {
  recordType: "MAIN";
  recordKey: "MAIN";
} & Pick<
    AuctionInternal,
    | "dataSourceCode"
    | "accouncementId"
    | "urlSources"
    | "title"
    | "type"
    | "isSale"
    | "publicationDate"
    | "dueDate"
    | "description"
    | "location"
    | "price"
    | "estimatedValue"
    | "ownershipShare"
    | "yearBuilt"
  >;
