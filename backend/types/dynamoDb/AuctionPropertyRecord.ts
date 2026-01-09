import { AuctionRecordBase } from "./AuctionRecordBase.js";
import { Property } from "../Property.js";
import { ParcelValuation } from "../ParcelValuation.js";
import { BuildingPartValuation } from "../BuildingPartValuation.js";
import { AuctionPropertyMap } from "../Auction.js";

/**
 * Property record for each property in an auction
 * Includes optional valuation data from ValuationService and maps from ParcelScreenshotService
 */
export type AuctionPropertyRecord = AuctionRecordBase & {
  recordType: "PROPERTY";
  /** Sort key: PROPERTY#propertyId */
  recordKey: `PROPERTY#${string}`;
  /** Valuation data from ValuationService (optional) */
  valuation?: ParcelValuation | BuildingPartValuation;
  /** Property maps/screenshots from ParcelScreenshotService */
  maps?: AuctionPropertyMap[];
} & Property;
