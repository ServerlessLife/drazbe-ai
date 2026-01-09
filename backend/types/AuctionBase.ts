import { z } from "zod";
import { propertySchema } from "./Property.js";
import { auctionLinkSchema } from "./AuctionLink.js";

export const auctionBaseSchema = z.object({
  announcementId: z
    .string()
    .describe(
      "Enolični ID objave. Če ni na voljo združi oznake vseh parcel in stavb z '+' (npr. '2242-536/6+2242-*123+2242-123/1')."
    )
    .nullable(),
  title: z.string().describe("Naslov objave"),
  type: z
    .enum(["auction", "contract", "other"])
    .describe(
      "Tip objave: 'auction' = javna dražba, 'contract' = namera za sklenitev neposredne pogodbe, 'other' = drugo"
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
  documents: z
    .array(auctionLinkSchema)
    .describe("Seznam povezav do dokumentov, če so na voljo")
    .nullable(),
  images: z
    .array(auctionLinkSchema)
    .describe("Seznam povezav do slik nepremičnine, če so na voljo")
    .nullable(),
});

export type AuctionBase = z.infer<typeof auctionBaseSchema>;

export const auctionsBaseSchema = z.object({
  auctions: z.array(auctionBaseSchema).describe("Seznam vseh dražb navedenih v dokumentu"),
});

export type AuctionsBase = z.infer<typeof auctionsBaseSchema>;
