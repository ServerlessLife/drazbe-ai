import fs from "fs";
import { AiExtractService } from "./services/AiExtractService.js";
import { Source } from "./types/Source.js";
import { AuctionInternalWithValuations } from "./types/AuctionInternal.js";

// Load sources from JSON
const sources: Source[] = JSON.parse(fs.readFileSync("sources.json", "utf-8"));

async function main() {
  const enabledSources = sources.filter((s) => s.enabled);
  console.log(`Obdelujem ${enabledSources.length} omogočenih virov...`);

  const allResults: Array<{
    source: string;
    rezultati: AuctionInternalWithValuations[];
    prodajneObjave: AuctionInternalWithValuations[];
  }> = [];

  for (const source of enabledSources) {
    try {
      const result = await AiExtractService.processSource(source);
      allResults.push({ source: source.code, ...result });
    } catch (err) {
      console.error(`Napaka pri obdelavi vira ${source.name}:`, err);
    }
  }

  await AiExtractService.close();

  console.log(`\n========================================`);
  console.log(`Končano. Obdelanih ${allResults.length} virov.`);
  console.log(`========================================`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
