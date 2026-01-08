import { ValuationService } from "../services/ValuationService.js";

async function test() {
  const query = {
    type: "building_part" as const,
    cadastralMunicipality: "2304",
    number: "1808/18",
  };

  console.log("Fetching building part valuation data...\n");

  const result = await ValuationService.getBuildingPartValuation(query);

  if (result) {
    console.log("\n=== BUILDING PART VALUATION DATA ===\n");
    if (result.address) {
      console.log(`Address: ${result.address}`);
    }
    console.log(`Value: ${result.value.toLocaleString()} €`);
    if (result.apartmentNumber) {
      console.log(`Apartment/Office Number: ${result.apartmentNumber}`);
    }
    if (result.actualUse) {
      console.log(`Actual Use: ${result.actualUse}`);
    }
    if (result.floor !== undefined) {
      console.log(`Floor: ${result.floor}`);
    }
    if (result.elevator) {
      console.log(`Elevator: ${result.elevator}`);
    }
    if (result.netFloorArea) {
      console.log(`Net Floor Area: ${result.netFloorArea} m²`);
    }
    if (result.centroid) {
      console.log(`Centroid: E=${result.centroid.e}, N=${result.centroid.n}`);
    }
    if (result.buildingType || result.numberOfFloors) {
      console.log(`Building Type: ${result.buildingType}, Floors: ${result.numberOfFloors}`);
    }
    if (result.numberOfApartments) {
      console.log(`Number of Apartments: ${result.numberOfApartments}`);
    }
    if (result.yearBuilt) {
      console.log(`Year Built: ${result.yearBuilt}`);
    }

    console.log("\n=== JSON OUTPUT ===\n");
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error("Failed to retrieve building part valuation data");
  }
}

test().catch(console.error);
