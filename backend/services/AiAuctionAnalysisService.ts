import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { logger } from "../utils/logger.js";
import { config } from "../utils/config.js";
import { auctionAnalysisSchema, AuctionAnalysis } from "../types/AuctionAnalysis.js";

export type { AuctionAnalysis };

let openai: OpenAI | undefined;

/**
 * Get or create the OpenAI client instance (singleton pattern)
 * Uses API key from config (SSM in Lambda, .env locally)
 */
async function getOpenAI(): Promise<OpenAI> {
  if (!openai) {
    const apiKey = await config.get("OPENAI_API_KEY");
    openai = new OpenAI({ apiKey });
  }
  return openai;
}

const SYSTEM_PROMPT = `Si pomočnik za analizo nepremičninskih dražb v Sloveniji.

Analiziraj podani markdown dokument o dražbi nepremičnine in vrni:

1. **aiTitle**: Kratek opis dražbe (do 150 znakov). Vključi tip nepremičnine, lokacijo, površino.

2. **aiWarning**: Opozorilo na karkoli nenavadnega (npr. služnosti, hipoteke, spori, omejitve, nenavadno nizka/visoka cena). Če ni ničesar nenavadnega, vrni null.

3. **aiSuitability**: Ocena primernosti (0-10) z kratkim opisom. Format: "Ocena X, [razlogi]", do 200 znakov.

**Kriteriji za ocenjevanje:**

Iščem ustrezno dražbo ne glede na to kaj se prodaja.

K VIŠJI oceni prispeva:
- Ugodna cena (negativen % pri "Relativna cena" = dobro). POZOR: Če je cena očitno previsoka ali podatki nesmiselni, ignoriraj.
- Zazidljiva parcela nad 500 m²
- Stanovanje/hiša je prazna (Prazno: Da)
- Bližina (kratka vožnja)

Ocena 0 (neprimerno):
- Razdalja nad 90 minut vožnje
- Parcele pod 400 m²

**Primeri aiSuitability:**
- "Ocena 10, stanovanje, letnik 2000, zelo blizu, ugodna cena"
- "Ocena 5, zazidljiva parcela, daleč, sorazmerno ugodna cena"
- "Ocena 0, stanovanje, zelo daleč"
- "Ocena 0, zelo majhna nezazidljiva parcela"
- "Ocena 3, hiša, letnik 1900, srednja razdalja"`;

/**
 * Analyze auction markdown and produce AI-generated title, warning, and suitability assessment
 */
async function analyzeAuction(auctionMarkdown: string): Promise<AuctionAnalysis> {
  logger.log("Analyzing auction with AI", {
    markdownLength: auctionMarkdown.length,
  });

  const client = await getOpenAI();

  const completion = await client.chat.completions.create({
    model: "gpt-5.2",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: auctionMarkdown },
    ],
    response_format: zodResponseFormat(auctionAnalysisSchema, "auction_analysis"),
    temperature: 0.3,
  });

  const content = completion.choices[0].message.content;
  if (!content) {
    throw new Error("Empty AI response");
  }

  const result = auctionAnalysisSchema.parse(JSON.parse(content));

  logger.log("Auction analysis complete", {
    aiTitle: result.aiTitle,
    aiSuitability: result.aiSuitability.substring(0, 50),
    hasWarning: result.aiWarning !== null,
  });

  return result;
}

export const AiAuctionAnalysisService = {
  analyzeAuction,
};
