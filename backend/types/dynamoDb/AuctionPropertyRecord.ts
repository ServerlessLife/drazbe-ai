import { AuctionRecordBase } from "./AuctionRecordBase.js";
import { Property } from "../Property.js";
import { GursParcelValuation } from "../GursParcelValuation.js";
import { GursBuildingPartValuation } from "../GursBuildingPartValuation.js";

/**
 * Property record for each property in an auction
 * Includes optional valuation data from GursValuationService and map image from ParcelScreenshotService
 */
export type AuctionPropertyRecord = AuctionRecordBase & {
  recordType: "PROPERTY";
  /** Sort key: PROPERTY#propertyId */
  recordKey: `PROPERTY#${string}`;
  /** Valuation data from GursValuationService (optional) */
  valuation?: GursParcelValuation | GursBuildingPartValuation;
  /** URL to the property map/screenshot image */
  mapImageUrl?: string;
} & Property;
