import { z } from "zod";

/**
 * Analysis result schema for AI-generated auction analysis
 */
export const auctionAnalysisSchema = z.object({
  aiTitle: z.string().describe("Kratek opis dražbe. Do 150 znakov."),
  aiWarning: z
    .string()
    .nullable()
    .describe("Karkoli je nenavadnega ali opozorilo. Null če ni ničesar nenavadnega."),
  aiSuitability: z
    .string()
    .describe(
      "Ocena kako dobro ustreza zahtevam. Začne se s številčno oceno 0 - 10, nato kratek opis."
    ),
});

export type AuctionAnalysis = z.infer<typeof auctionAnalysisSchema>;
