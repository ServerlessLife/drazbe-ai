import { z } from "zod";
import { gursValuationBaseSchema } from "./GursValuationBase.js";

// Schema for GURS building part valuation data
export const gursBuildingPartValuationSchema = gursValuationBaseSchema.extend({
  // Address
  address: z.string().optional().describe("Naslov"),

  // Building part details
  apartmentNumber: z.string().optional().describe("Številka stanovanja / poslovnega prostora"),
  actualUse: z.string().optional().describe("Dejanska raba dela stavbe"),
  floor: z.number().optional().describe("Nadstropje"),
  elevator: z.string().optional().describe("Dvigalo"),
  netFloorArea: z.number().optional().describe("Neto tlorisna površina v m²"),

  // Building details
  buildingType: z.string().optional().describe("Tip stavbe"),
  numberOfFloors: z.number().optional().describe("Število etaž"),
  numberOfApartments: z.number().optional().describe("Število stanovanj"),
  yearBuilt: z.number().optional().describe("Leto izgradnje"),
});

export type GursBuildingPartValuation = z.infer<typeof gursBuildingPartValuationSchema>;
