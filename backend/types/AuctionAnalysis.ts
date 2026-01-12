import { z } from "zod";

/**
 * Analysis result schema for AI-generated auction analysis
 */
export const auctionAnalysisSchema = z.object({
  aiWarning: z
    .string()
    .nullable()
    .describe(
      "Dodatna opozorila odkrita med analizo vrednotenja. Nikdar ne odstrani obstoječih opozoril, samo dodaj novo po potrebi in prilagodi besedilo."
    ),
  aiGursValuationMakesSense: z
    .boolean()
    .describe("Ali GURS vrednotenje smiselno odraža tržno vrednost nepremičnine?"),
  aiSuitability: z
    .string()
    .describe(
      "Ocena kako dobro ustreza zahtevam. Začne se s številčno oceno 0 - 10, nato kratek opis."
    ),
});

export type AuctionAnalysis = z.infer<typeof auctionAnalysisSchema>;
