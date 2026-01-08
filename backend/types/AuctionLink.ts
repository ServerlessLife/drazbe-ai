import { z } from "zod";

export const auctionLinkSchema = z.object({
  sourceUrl: z.string().describe("Povezava do dokumenta (npr. PDF)"),
  description: z.string().describe("Opis dokumenta").nullable(),
});

export type AuctionLink = z.infer<typeof auctionLinkSchema>;
