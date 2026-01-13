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
    const apiKey = await config.get("/drazbe-ai/openai-api-key");
    openai = new OpenAI({ apiKey });
  }
  return openai;
}

const SYSTEM_PROMPT = `Si pomočnik za analizo nepremičninskih dražb v Sloveniji.

Analiziraj podani markdown dokument o dražbi nepremičnine in vrni:
1. **aiGursValuationWarnings**: Seznam opozoril glede GURS posplošenega vrednotenja. Opozori če vrednotenje zelo odstopa od dejanske vrednosti nepremičnine. Prazen seznam če ni opozoril.
2. **aiGursValuationMakesSense**: Ali GURS vrednotenje smiselno odraža tržno vrednost nepremičnine? True če je vrednotenje smiselno, false če zelo odstopa.
3. **aiSuitability**: Ocena primernosti (0-10) z kratkim opisom. Format: "Ocena X, [vrsta (stanovanje, nezazidljiva parcela, hiša, ...)], [razlogi]", do 200 znakov.

**Kriteriji za ocenjevanje:**

Iščem ustrezno dražbo ne glede na to kaj se prodaja.

K VIŠJI oceni prispeva:
- Zazidljiva parcela nad 500 m²
- Stanovanje/hiša je prazna (Prazno: Da)
- Bližina (kratka vožnja)
- Ugodna cena (negativen % pri "Relativna cena" = dobro). POZOR: Če je cena očitno previsoka ali podatki nesmiselni, ignoriraj ceno. -25% je srednje ugodno. Cena ni najpomembnejši faktor.
- Zavezujoče ali nezavezujoče javno zbiranje ponudb
- Klasična prodaja

Podaj ocena 0 (neprimerno) vedno kadar:
- Razdalja nad 100 minut vožnje
- Parcele pod 400 m²
- Solastniški delež manjši od 100%

Podaj ocena 10 (zelo primerno) kadar:
- Stanovanje/hiša je prazna (Prazno: Da)
- Klasična prodaja do 60 minut vožnje
- Zavezujoče ali nezavezujoče javno zbiranje ponudb do 60 minut vožnje
- Namera o prodaji do 60 minut vožnje
- Neposredna pogodba do 60 minut vožnje

**Primeri aiSuitability:**
- "Ocena 10, stanovanje Ljubljana, letnik 2000, zelo blizu, ugodna cena"
- "Ocena 5, zazidljiva parcela pri Mariboru, daleč, sorazmerno ugodna cena"
- "Ocena 0, stanovanje pri Murski Soboti, zelo daleč"
- "Ocena 0, zelo majhna nezazidljiva parcela"
- "Ocena 3, hiša pri Jesenicah, letnik 1900, srednja razdalja"`;

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
    aiSuitability: result.aiSuitability.substring(0, 50),
    warningsCount: result.aiGursValuationWarnings.length,
  });

  return result;
}

export const AiAuctionAnalysisService = {
  analyzeAuction,
};
