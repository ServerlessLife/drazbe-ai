import { z } from "zod";

// Schema for property key
export const propertyKeySchema = z.object({
  type: z
    .enum(["parcel", "building", "building_part"])
    .describe("Tip: 'parcel' = parcela, 'building' = stavba, 'building_part' = del stavbe"),
  cadastralMunicipality: z
    .string()
    .describe("Šifra katastrske občine (npr. 2242). Če je navedeno ime 'Podboršt', je šifra 1385."),
  number: z.string().describe("Številka parcele, stavbe ali dela stavbe (npr. 9, 536/6, *123). "),
});

export type PropertyKey = z.infer<typeof propertyKeySchema>;
