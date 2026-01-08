import { AuctionRecordBase } from "./AuctionRecordBase.js";

/**
 * Property map/screenshot record from ParcelScreenshotService
 */
export type AuctionPropertyMapRecord = AuctionRecordBase & {
  recordType: "PROPERTY_MAP";
  /** Sort key: PROPERTY_MAP#propertyId */
  recordKey: `PROPERTY_MAP#${string}`;
  propertyId: string;
  /** S3 URL or local path to the map image */
  localUrl: string;
};
