import { z } from "zod";

/**
 * Analysis result schema for AI-generated auction analysis
 */
export const auctionAnalysisSchema = z.object({
  aiGursValuationWarnings: z
    .array(z.string())
    .describe(
      "Seznam opozoril pri primerjavi z GURS podatki in vrednotenjem."
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
