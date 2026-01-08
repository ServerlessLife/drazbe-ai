/**
 * Sort key prefixes for different record types in DynamoDB
 */
export type AuctionRecordType =
  | "MAIN"
  | "PROPERTY"
  | "PROPERTY_VALUATION"
  | "PROPERTY_MAP"
  | "DOCUMENT"
  | "IMAGE";

/**
 * Base record structure for all auction-related DynamoDB items
 */
export type AuctionRecordBase = {
  /** Partition key: dataSourceCode#id */
  auctionId: string;
  /** Sort key: RECORD_TYPE or RECORD_TYPE#ID */
  recordKey: string;
  /** Record type for filtering */
  recordType: AuctionRecordType;
  /** Timestamp when the record was created */
  createdAt: string;
  /** Timestamp when the record was last updated */
  updatedAt: string;
  /** TTL - Unix timestamp (seconds) for when the record should be deleted (1 day after dueDate) */
  ttl: number;
};
