import { z } from "zod";

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
