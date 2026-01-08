import { AuctionRecordBase } from "./AuctionRecordBase.js";
import { ParcelValuation } from "../ParcelValuation.js";
import { BuildingPartValuation } from "../BuildingPartValuation.js";

/**
 * Property valuation record from ValuationService
 */
export type AuctionPropertyValuationRecord = AuctionRecordBase & {
  recordType: "PROPERTY_VALUATION";
  /** Sort key: PROPERTY_VALUATION#propertyId */
  recordKey: `PROPERTY_VALUATION#${string}`;
  /** Property ID this valuation belongs to */
  propertyId: string;
} & (ParcelValuation | BuildingPartValuation);
