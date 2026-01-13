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
    .enum([
      "javna-drazba",
      "klasicna-prodaja",
      "oddaja",
      "zavezujoce-javno-zbiranje-ponudb",
      "nezavezujoce-javno-zbiranje-ponudb",
      "namera-o-prodaji",
      "namera",
      "elektronska-drazba",
      "elektronska-javna-drazba",
      "drugo",
    ])
    .describe(
      "Tip objave: 'javna-drazba' = Javna dražba, 'klasicna-prodaja' = Klasična prodaja, 'oddaja' = Oddaja, 'zavezujoce-javno-zbiranje-ponudb' = Zavezujoče javno zbiranje ponudb, 'nezavezujoce-javno-zbiranje-ponudb' = Nezavezujoče javno zbiranje ponudb, 'namera-o-prodaji' = Namera o prodaji, 'namera' = Namera, 'elektronska-drazba' = Elektronska dražba, 'elektronska-javna-drazba' = Elektronska javna dražba, 'drugo' = Drugo"
    ),
  isRealEstateSale: z
    .boolean()
    .describe(
      "Ali gre za prodajo (true) nepremičnince. Ne najem, oddaj, menjavo ali prodajo česa drugega"
    ),
  isVacant: z
    .enum(["YES", "NO", "UNKNOWN"])
    .describe(
      "Ali je nepremičnina prazna: 'YES' = da, 'NO' = ne/zasedena, 'UNKNOWN' = ni podatka. Podatek izpolni samo za hiše in stanovanja. Pusti prazno za parcele, poslovne prostore..."
    )
    .nullable(),
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
  properties: z
    .array(propertySchema)
    .describe(
      "Seznam parcel, stavb ali del stavb navedenih v objavi. Formati v besedilu: '2242/9', '2242 9', '2242 536/6', '2242 536-6', '2242-536-6', 'k.o. 2242 parc. 9'. Ne vključi črk. Zamenjaj '-' in ' ' z '/'. Stavba ima številko sestavljeno iz dveh delov npr. 123/1. Če drugi del manjka, dodaj '/1'. Pazi, da ne podvojiš in vključiš celotno šifro."
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
  aiTitle: z
    .string()
    .describe(
      "Naslov dražbe. Lahko je enak uradnemu naslovu ali kreiran primernejši. Do 150 znakov."
    )
    .nullable(),
  aiWarning: z
    .array(z.string())
    .describe(
      "Seznam opozoril o nenavadnih stvareh (npr. služnosti, hipoteke, spori, omejitve ...). Prazen seznam če ni ničesar nenavadnega."
    ),
});

export type AuctionBase = z.infer<typeof auctionBaseSchema>;

export const auctionsBaseSchema = z.object({
  auctions: z.array(auctionBaseSchema).describe("Seznam vseh dražb navedenih v dokumentu"),
});

export type AuctionsBase = z.infer<typeof auctionsBaseSchema>;
