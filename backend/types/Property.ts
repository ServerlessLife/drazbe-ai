import { z } from "zod";
import { propertyKeySchema } from "./PropertyIdentifier.js";

export const propertySchema = propertyKeySchema.extend({
  parcelType: z
    .enum(["agricultural", "building", "forest", "other"])
    .describe(
      "Vrsta parcele: 'agricultural' = kmetijska, 'building' = stavbna, 'forest' = gozdna, 'other' = drugo"
    )
    .nullable(),
  buildingType: z
    .enum(["residential", "commercial", "industrial", "other"])
    .describe(
      "Vrsta stavbe: 'residential' = stanovanjska, 'commercial' = poslovna, 'industrial' = industrijska, 'other' = drugo"
    )
    .nullable(),
  area: z.number().describe("Površina v m² če je navedena").nullable(),
  ownershipShare: z
    .number()
    .describe("Delež lastništva v %, če je naveden (npr. 1/2 = 50, 1/4 = 25)")
    .nullable(),
});

export type Property = z.infer<typeof propertySchema>;
