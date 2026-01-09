import { GursValuationService } from "../services/GursValuationService.js";

async function test() {
  const query = {
    type: "parcel" as const,
    cadastralMunicipality: "1672",
    number: "90/6",
  };

  console.log("Fetching valuation data...\n");

  const result = await GursValuationService.getParcelValuation(query);

  if (result) {
    console.log("\n=== PARCEL VALUATION DATA ===\n");
    console.log(`Surface Area: ${result.surfaceArea} m²`);
    console.log(`Value: ${result.value} €`);

    if (result.centroid) {
      console.log(`Centroid: E=${result.centroid.e}, N=${result.centroid.n}`);
    }

    if (result.intendedUse) {
      console.log(`\nIntended Use (Namenska raba): ${result.intendedUse}`);
    }

    if (result.actualUse) {
      console.log(`\nActual Use (Dejanska raba): ${result.actualUse}`);
    }

    console.log("\n=== JSON OUTPUT ===\n");
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error("Failed to retrieve valuation data");
  }
}

test().catch(console.error);
