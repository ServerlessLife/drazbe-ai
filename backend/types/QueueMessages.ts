import { PropertyKey } from "./PropertyIdentifier.js";

/**
 * Message payload for property processing queue
 * Includes optional valuation data with corrected type/cadastralMunicipality/number from GURS
 */
export type PropertyQueueMessage = {
  auctionId: string;
  /** Valuation data from GURS (if available) */
  valuation?: {
    type: PropertyKey["type"];
    cadastralMunicipality: string;
    number: string;
  };
} & PropertyKey;

/**
 * Message payload for auction analysis queue
 */
export type AuctionAnalysisQueueMessage = {
  auctionId: string;
};
