import { z } from "zod";

// Schema for parcel valuation data
export const parcelValuationSchema = z.object({
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

// Schema for building part valuation data
export const buildingPartValuationSchema = z.object({
  // Address
  address: z.string().optional().describe("Naslov"),

  // Value
  value: z.number().describe("Posplošena vrednost v €"),

  // Building part details
  apartmentNumber: z.string().optional().describe("Številka stanovanja / poslovnega prostora"),
  actualUse: z.string().optional().describe("Dejanska raba dela stavbe"),
  floor: z.number().optional().describe("Nadstropje"),
  elevator: z.string().optional().describe("Dvigalo"),
  netFloorArea: z.number().optional().describe("Neto tlorisna površina v m²"), // Centroid coordinates
  centroid: z
    .object({
      e: z.number().describe("Koordinata E"),
      n: z.number().describe("Koordinata N"),
    })
    .optional(),

  // Building details
  buildingType: z.string().optional().describe("Tip stavbe"),
  numberOfFloors: z.number().optional().describe("Število etaž"),
  numberOfApartments: z.number().optional().describe("Število stanovanj"),
  yearBuilt: z.number().optional().describe("Leto izgradnje"),
});

export type BuildingPartValuation = z.infer<typeof buildingPartValuationSchema>;

// Input schema for querying
export const valuationQuerySchema = z.object({
  type: z.enum(["parcel", "building_part"]),
  cadastralMunicipality: z.string().describe("Šifra katastrske občine"),
  number: z.string().describe("Številka parcele ali dela stavbe (format: stavba/del)"),
});

export type ValuationQuery = z.infer<typeof valuationQuerySchema>;
