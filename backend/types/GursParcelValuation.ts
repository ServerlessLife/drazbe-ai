import { z } from "zod";
import { gursValuationBaseSchema } from "./GursValuationBase.js";

// Schema for GURS parcel valuation data
export const gursParcelValuationSchema = gursValuationBaseSchema.extend({
  // Surface area
  surfaceArea: z.number().describe("Površina v m²"),

  // Intended use (namenska raba)
  intendedUse: z.string().optional().describe("Namenska raba"),

  // Actual use (dejanska raba)
  actualUse: z.string().optional().describe("Dejanska raba"),
});

export type GursParcelValuation = z.infer<typeof gursParcelValuationSchema>;
