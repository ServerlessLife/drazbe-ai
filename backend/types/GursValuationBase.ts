import { z } from "zod";

/**
 * Centroid coordinates (Slovenian D96/TM coordinate system - EPSG:3794)
 */
export const centroidSchema = z.object({
  e: z.number().describe("Koordinata E (Easting)"),
  n: z.number().describe("Koordinata N (Northing)"),
});

export type Centroid = z.infer<typeof centroidSchema>;

/**
 * Base schema for GURS valuation data
 * Common fields shared by parcel and building part valuations
 */
export const gursValuationBaseSchema = z.object({
  value: z.number().describe("Posplošena vrednost v €"),
  centroid: centroidSchema.optional(),
});

export type GursValuationBase = z.infer<typeof gursValuationBaseSchema>;
