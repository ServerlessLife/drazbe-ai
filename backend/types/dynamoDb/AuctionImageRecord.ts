import { AuctionRecordBase } from "./AuctionRecordBase.js";
import { AuctionLink } from "../AuctionLink.js";

/**
 * Image record for each image in an auction
 */
export type AuctionImageRecord = AuctionRecordBase & {
  recordType: "IMAGE";
  /** Sort key: IMAGE#hash(sourceUrl) */
  recordKey: `IMAGE#${string}`;
  /** S3 URL or local path to the stored image */
  localUrl?: string;
} & AuctionLink;
