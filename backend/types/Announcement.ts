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

export const announcementSchema = z.object({
  id: z
    .string()
    .describe(
      "Enolični ID objave. Če ni na voljo združi oznake vseh parcel in stavb z '+' (npr. '2242-536/6+2242-*123+2242-123/1')."
    )
    .nullable(),
  title: z.string().describe("Naslov objave"),
  type: z
    .enum([
      "public-auction",
      "classic-sale",
      "binding-public-bidding",
      "non-binding-public-bidding",
      "intent-to-sell",
      "electronic-auction",
      "electronic-public-auction",
      "other",
    ])
    .describe(
      "Tip objave: 'public-auction' = Javna dražba, 'classic-sale' = Klasična prodaja, 'binding-public-bidding' = Zavezujoče javno zbiranje ponudb, 'non-binding-public-bidding' = Nezavezujoče javno zbiranje ponudb, 'intent-to-sell' = Namera o prodaji, 'electronic-auction' = Elektronska dražba, 'electronic-public-auction' = Elektronska javna dražba, 'other' = Drugo"
    ),
  isSale: z.boolean().describe("Ali gre za prodajo (true) ali najem, oddaj, menjavo (false)"),
  publicationDate: z.string().describe("Datum objave").nullable(),
  dueDate: z.string().describe("Rok / aktualno do").nullable(),
  description: z.string().describe("Do 200 znakov opisa nepremičnine").nullable(),
  location: z.string().describe("Lokacija nepremičnine, če je navedena").nullable(),
  price: z
    .number()
    .describe("Cena ali izklicna cena ali ponudbena cena, če je navedena")
    .nullable(),
  estimatedValue: z.number().describe("Ocenjena vrednost nepremičnine, če je navedena").nullable(),
  ownershipShare: z
    .number()
    .describe("Delež lastništva v %, če je naveden (npr. 1/2 = 50, 1/4 = 25)")
    .nullable(),
  yearBuilt: z
    .number()
    .describe("Leto izgradnje stavbe, če je navedeno (samo za stavbe)")
    .nullable(),
  property: z
    .array(propertySchema)
    .describe(
      "Seznam parcel, stavb ali del stavb navedenih v objavi. Formati v besedilu: '2242/9', '2242 9', '2242 536/6', '2242 536-6', '2242-536-6', 'k.o. 2242 parc. 9'. Ne vključi črk. Zamenjaj '-' in ' ' z '/'. Pazi, da ne podvojiš in vključiš celotno šifro."
    )
    .nullable(),
  linksToDocuments: z
    .array(z.string().describe("Povezava do dokumenta (npr. PDF)"))
    .describe("Seznam povezav do dokumentov, če so na voljo")
    .nullable(),
  linksToImages: z
    .array(z.string().describe("Povezava do slike (npr. JPG, PNG)"))
    .describe("Seznam povezav do slik nepremičnine, če so na voljo")
    .nullable(),
});

export const detailSchema = z.object({
  announcements: z
    .array(announcementSchema)
    .describe("Seznam vseh objav/nepremičnin navedenih v dokumentu"),
});

export type Property = z.infer<typeof propertySchema>;
export type Announcement = z.infer<typeof announcementSchema>;

export interface AnnouncementResult extends Announcement {
  sourceCode: string;
  urlSources: string[];
}
