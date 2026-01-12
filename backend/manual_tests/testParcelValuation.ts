import { GursValuationService } from "../services/GursValuationService.js";

async function test() {
  const query = {
    type: "parcel" as const,
    cadastralMunicipality: "1683",
    number: "1998/6",
    // cadastralMunicipality: "785",
    // number: "430/2",
  };

  console.log("Fetching valuation data...\n");

  const result = await GursValuationService.getValuation(query, null);

  if (result) {
    console.log("\n=== PARCEL VALUATION DATA ===\n");
    if ("surfaceArea" in result) {
      console.log(`Surface Area: ${result.surfaceArea} m²`);
    }
    console.log(`Value: ${result.value} €`);

    if (result.centroid) {
      console.log(`Centroid: E=${result.centroid.e}, N=${result.centroid.n}`);
    }

    if ("intendedUse" in result && result.intendedUse) {
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
