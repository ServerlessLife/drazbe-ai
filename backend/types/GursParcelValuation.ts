import { z } from "zod";

// Schema for GURS parcel valuation data
export const gursParcelValuationSchema = z.object({
  // Surface and value
  surfaceArea: z.number().describe("Površina v m²"),
  value: z.number().describe("Posplošena vrednost v €"),

  // Centroid coordinates
  centroid: z
    .object({
      e: z.number().describe("Koordinata E"),
      n: z.number().describe("Koordinata N"),
    })
    .optional(),

  // Intended use (namenska raba)
  intendedUse: z.string().optional().describe("Namenska raba"),

  // Actual use (dejanska raba)
  actualUse: z.string().optional().describe("Dejanska raba"),
});

export type GursParcelValuation = z.infer<typeof gursParcelValuationSchema>;
