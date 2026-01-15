import { AuctionRecordBase } from "./AuctionRecordBase.js";

/**
 * Image record for each image in an auction
 */
export type AuctionImageRecord = AuctionRecordBase & {
  recordType: "IMAGE";
  /** Sort key: IMAGE#hash(sourceUrl) */
  recordKey: `IMAGE#${string}`;
  /** Original source URL of the image */
  sourceUrl?: string;
  /** Description of the image */
  description?: string;
  /** S3 URL or local path to the stored image */
  localUrl?: string;
};
