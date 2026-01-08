import { z } from "zod";

// Schema for parcel valuation data
export const parcelValuationSchema = z.object({
  // Basic info
  cadastralMunicipality: z.string().describe("Katastrska občina"),
  parcelNumber: z.string().describe("Številka parcele"),

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

export type ParcelValuation = z.infer<typeof parcelValuationSchema>;

// Input schema for querying
export const valuationQuerySchema = z.object({
  type: z.enum(["parcel", "buildingPart"]),
  cadastralMunicipality: z.string().describe("Šifra katastrske občine"),
  number: z.string().describe("Številka parcele ali dela stavbe"),
});

export type ValuationQuery = z.infer<typeof valuationQuerySchema>;
