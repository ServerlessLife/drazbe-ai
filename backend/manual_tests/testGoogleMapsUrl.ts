import { GoogleMapsService } from "../services/GoogleMapsService.js";
import { Centroid } from "../types/GursValuationBase.js";

/**
 * Test Google Maps URL generation
 */
async function main() {
  console.log("Testing Google Maps URL generation...\n");

  // Test with centroid (D96/TM coordinates for Ljubljana)
  const centroid: Centroid = {
    e: 550447.58,
    n: 140151.15,
  };

  console.log("1. Testing with centroid coordinates:");
  console.log(`   Input: e=${centroid.e}, n=${centroid.n}`);
  const urlFromCentroid = GoogleMapsService.getGoogleMapsUrl(centroid);
  console.log(`   Output: ${urlFromCentroid}`);
  console.log("");

  // Test with address string
  const address = "Cankarjeva ulica 8, 2331 Pragersko, Slovenija";
  console.log("2. Testing with address string:");
  console.log(`   Input: "${address}"`);
  const urlFromAddress = GoogleMapsService.getGoogleMapsUrl(address);
  console.log(`   Output: ${urlFromAddress}`);
  console.log("");

  // Test with address containing special characters
  const addressSpecial = "Čopova ulica 14, Ljubljana";
  console.log("3. Testing with special characters:");
  console.log(`   Input: "${addressSpecial}"`);
  const urlFromAddressSpecial = GoogleMapsService.getGoogleMapsUrl(addressSpecial);
  console.log(`   Output: ${urlFromAddressSpecial}`);
  console.log("");

  console.log("Done! Copy the URLs above and paste them in a browser to verify.");
}

main().catch(console.error);
