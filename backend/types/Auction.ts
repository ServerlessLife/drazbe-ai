import { AuctionInternal } from "./AuctionInternal.js";
import { AuctionDocument } from "./AuctionDocument.js";
import { Property } from "./Property.js";
import { ParcelValuation } from "./ParcelValuation.js";
import { BuildingPartValuation } from "./BuildingPartValuation.js";
import { AuctionImage } from "./AuctionImage.js";

/**
 * Main auction data (without DynamoDB-specific fields)
 */
export type AuctionMain = Pick<
  AuctionInternal,
  | "dataSourceCode"
  | "announcementId"
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

/**
 * Property valuation data
 */
export type AuctionPropertyValuation = ParcelValuation | BuildingPartValuation;

/**
 * Property map/screenshot data
 */
export type AuctionPropertyMap = {
  localUrl: string;
};

/**
 * Property data for an auction with optional valuation and maps
 */
export type AuctionProperty = Property & {
  valuation?: AuctionPropertyValuation;
  maps: AuctionPropertyMap[];
};

/**
 * Complete auction data with all related records
 */
export type Auction = {
  main: AuctionMain | null;
  properties: AuctionProperty[];
  documents: AuctionDocument[];
  images: AuctionImage[];
};
