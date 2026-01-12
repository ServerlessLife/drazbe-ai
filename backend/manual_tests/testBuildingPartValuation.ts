import { GursValuationService } from "../services/GursValuationService.js";

async function test() {
  const query = {
    type: "building_part" as const,
    cadastralMunicipality: "636",
    number: "479",
  };

  console.log("Fetching building part valuation data...\n");

  const result = await GursValuationService.getValuation(query, null);

  if (result) {
    console.log("\n=== BUILDING PART VALUATION DATA ===\n");
    if ("address" in result && result.address) {
      console.log(`Address: ${result.address}`);
    }
    console.log(`Value: ${result.value.toLocaleString()} €`);
    if ("apartmentNumber" in result && result.apartmentNumber) {
      console.log(`Apartment/Office Number: ${result.apartmentNumber}`);
    }
    if (result.actualUse) {
      console.log(`Actual Use: ${result.actualUse}`);
    }
    if ("floor" in result && result.floor !== undefined) {
      console.log(`Floor: ${result.floor}`);
    }
    if ("elevator" in result && result.elevator) {
      console.log(`Elevator: ${result.elevator}`);
    }
    if ("netFloorArea" in result && result.netFloorArea) {
      console.log(`Net Floor Area: ${result.netFloorArea} m²`);
    }
    if (result.centroid) {
      console.log(`Centroid: E=${result.centroid.e}, N=${result.centroid.n}`);
    }
    if (
      ("buildingType" in result && result.buildingType) ||
      ("numberOfFloors" in result && result.numberOfFloors)
    ) {
      console.log(
        `Building Type: ${"buildingType" in result ? result.buildingType : "N/A"}, Floors: ${"numberOfFloors" in result ? result.numberOfFloors : "N/A"}`
      );
    }
    if ("numberOfApartments" in result && result.numberOfApartments) {
      console.log(`Number of Apartments: ${result.numberOfApartments}`);
    }
    if ("yearBuilt" in result && result.yearBuilt) {
      console.log(`Year Built: ${result.yearBuilt}`);
    }

    console.log("\n=== JSON OUTPUT ===\n");
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error("Failed to retrieve building part valuation data");
  }
}

test().catch(console.error);
