import { GoogleMapsService } from "../services/GoogleMapsService.js";
import { Centroid } from "../types/GursValuationBase.js";

// Home address for driving time calculation
const HOME_ADDRESS = process.env.HOME_ADDRESS;

// Test destination: Ljubljana, Rakuševa ulica (parking space from jssmol)
const TEST_DESTINATION: Centroid = {
  e: 460210.52,
  n: 104304.37,
};

async function main() {
  console.log("Testing GoogleMapsService...\n");

  if (!HOME_ADDRESS) {
    console.error("HOME_ADDRESS environment variable is not set");
    process.exit(1);
  }

  console.log(`Home address: ${HOME_ADDRESS}`);
  console.log(`Destination centroid: e=${TEST_DESTINATION.e}, n=${TEST_DESTINATION.n}`);

  // Test driving info calculation with centroid
  console.log("\nCalculating driving info...");
  const drivingInfo = await GoogleMapsService.getDrivingInfo(HOME_ADDRESS, TEST_DESTINATION);

  if (drivingInfo !== null) {
    console.log(`\n✓ Driving time: ${drivingInfo.drivingTimeMinutes} minutes`);
    console.log(`✓ Driving distance: ${drivingInfo.drivingDistanceKm} km`);
  } else {
    console.log("\n✗ Could not calculate driving info");
  }

  // Test with address as destination
  console.log("\n--- Testing with address destination ---");
  const addressDestination = "Rakuševa ulica 4, Ljubljana, Slovenia";
  console.log(`Destination address: ${addressDestination}`);

  const drivingInfoAddress = await GoogleMapsService.getDrivingInfo(HOME_ADDRESS, addressDestination);

  if (drivingInfoAddress !== null) {
    console.log(`\n✓ Driving time (by address): ${drivingInfoAddress.drivingTimeMinutes} minutes`);
    console.log(`✓ Driving distance (by address): ${drivingInfoAddress.drivingDistanceKm} km`);
  } else {
    console.log("\n✗ Could not calculate driving info by address");
  }
}

main().catch(console.error);
