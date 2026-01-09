import { AuctionDocument } from "./AuctionDocument.js";
import { Property } from "./Property.js";
import { ParcelValuation } from "./ParcelValuation.js";
import { BuildingPartValuation } from "./BuildingPartValuation.js";
import { AuctionImage } from "./AuctionImage.js";

/**
 * Property valuation data
 */
export type AuctionPropertyValuation = ParcelValuation | BuildingPartValuation;

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
 * Complete auction data
 */
export type Auction = {
  dataSourceCode: string;
  announcementId: string | null;
  urlSources: string[];
  title: string;
  /** AI-generated title for the auction */
  aiTitle: string | null;
  /** AI-generated suitability assessment */
  aiSuitability: string | null;
  type: "auction" | "contract" | "other";
  publicationDate: string | null;
  dueDate: string | null;
  description: string | null;
  location: string | null;
  price: number | null;
  estimatedValue: number | null;
  ownershipShare: number | null;
  yearBuilt: number | null;
  properties: AuctionProperty[] | null;
  documents: AuctionDocument[];
  images: AuctionImage[] | null;
  /** Price to value ratio (Relativna cena) */
  priceToValueRatio: PriceToValueRatio;
};
