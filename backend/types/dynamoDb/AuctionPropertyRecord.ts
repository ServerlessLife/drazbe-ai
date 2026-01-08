import { AuctionRecordBase } from "./AuctionRecordBase.js";
import { Property } from "../Property.js";

/**
 * Property record for each property in an auction
 */
export type AuctionPropertyRecord = AuctionRecordBase & {
  recordType: "PROPERTY";
  /** Sort key: PROPERTY#propertyId */
  recordKey: `PROPERTY#${string}`;
} & Property;
