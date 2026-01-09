import { Property } from "../types/Property.js";

/**
 * Helper to generate property ID from property data
 */
export function generatePropertyId(property: Property): string {
  return `${property.cadastralMunicipality}-${property.number}`;
}
