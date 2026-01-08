import crypto from "crypto";
import { Property } from "../Property.js";

/**
 * Helper to generate partition key (auctionId) from dataSourceCode and id
 */
export function generateAuctionId(dataSourceCode: string, id: string): string {
  return `${dataSourceCode}#${id}`;
}

/**
 * Helper to generate a hash from a URL for use as ID
 */
export function hashUrl(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").substring(0, 16);
}

/**
 * Helper to generate property ID from property data
 */
export function generatePropertyId(property: Property): string {
  return `${property.cadastralMunicipality}-${property.number}`;
}
