import { AuctionDocument } from "./AuctionDocument.js";
import { Property } from "./Property.js";
import { GursParcelValuation } from "./GursParcelValuation.js";
import { GursBuildingPartValuation } from "./GursBuildingPartValuation.js";
import { AuctionImage } from "./AuctionImage.js";
import { AuctionBase } from "./AuctionBase.js";
import { DrivingResult } from "./DrivingResult.js";

/**
 * Property valuation data
 */
export type AuctionPropertyValuation = GursParcelValuation | GursBuildingPartValuation;

/**
 * Property data for an auction with optional valuation and map image
 */
export type AuctionProperty = Property & {
  valuation?: AuctionPropertyValuation;
  /** URL to the property map/screenshot image */
  mapImageUrl?: string;
};

/**
 * Price to value ratio (Relativna cena) - percentage of price relative to valuations
 * Lower values indicate better deals (e.g., 70% means price is 70% of the valuation)
 */
export type PriceToValueRatio = {
  /** Ratio % based on estimatedValue field (if available) */
  toEstimatedValue: number | null;
  /** Ratio % based on sum of all property valuations (if available) */
  toPropertyValuations: number | null;
};

/**
 * Complete auction data - extends AuctionBase with additional processed fields
 */
export type Auction = Omit<AuctionBase, "property" | "documents" | "images" | "isSale"> & {
  /** Unique auction identifier (partition key in DynamoDB) */
  auctionId?: string;
  dataSourceCode: string;
  urlSources: string[];
  /** AI-generated title for the auction */
  aiTitle: string | null;
  /** AI-generated warning about unusual aspects */
  aiWarning: string | null;
  /** AI assessment: does GURS valuation reflect market value? */
  aiGursValuationMakesSense: boolean | null;
  /** AI-generated suitability assessment */
  aiSuitability: string | null;
  /** Driving info from user's home */
  drivingInfo: DrivingResult | null;
  properties: AuctionProperty[] | null;
  documents: AuctionDocument[];
  images: AuctionImage[] | null;
  /** Price to value ratio (Relativna cena) */
  priceToValueRatio: PriceToValueRatio;
  /** Timestamp when the auction was published (AI analysis completed) */
  publishedAt: string | null;
};
