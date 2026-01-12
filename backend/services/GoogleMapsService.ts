import { logger } from "../utils/logger.js";
import { config } from "../utils/config.js";
import { Centroid } from "../types/GursValuationBase.js";
import { DrivingResult } from "../types/DrivingResult.js";
import proj4 from "proj4";

export type { DrivingResult };

/**
 * Location can be specified as coordinates or an address string
 */
export type Location = Centroid | string;

// Define D96/TM (EPSG:3794) projection for Slovenia
// Source: https://epsg.io/3794
proj4.defs(
  "EPSG:3794",
  "+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"
);

/**
 * Convert Slovenian D96/TM coordinates (EPSG:3794) to WGS84 (lat/lng)
 */
function convertD96ToWGS84(centroid: Centroid): { lat: number; lng: number } {
  const [lng, lat] = proj4("EPSG:3794", "WGS84", [centroid.e, centroid.n]);
  return { lat, lng };
}

/**
 * Format location for Google Maps API
 */
function formatLocation(location: Location): string {
  if (typeof location === "string") {
    return encodeURIComponent(location);
  }
  // Convert centroid to WGS84 coordinates
  const { lat, lng } = convertD96ToWGS84(location);
  return `${lat},${lng}`;
}

/**
 * Calculate driving time and distance between two locations using Google Maps Distance Matrix API
 * @param origin - Starting location (centroid or address)
 * @param destination - Ending location (centroid or address)
 * @returns Driving time in minutes and distance in km, or null if route not found
 */
async function getDrivingInfo(
  origin: Location,
  destination: Location
): Promise<DrivingResult | null> {
  const apiKey = await config.get("/drazbe-ai/google-maps-api-key");
  if (!apiKey) {
    throw new Error(
      "Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY in .env or SSM Parameter Store."
    );
  }

  const originStr = formatLocation(origin);
  const destinationStr = formatLocation(destination);

  logger.log("Calculating driving time", {
    origin: typeof origin === "string" ? origin : `${origin.e},${origin.n}`,
    destination:
      typeof destination === "string" ? destination : `${destination.e},${destination.n}`,
  });

  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originStr}&destinations=${destinationStr}&mode=driving&key=${apiKey}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== "OK") {
      logger.warn("Google Maps API error", {
        status: data.status,
        errorMessage: data.error_message,
      });
      return null;
    }

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") {
      logger.warn("Route not found", {
        elementStatus: element?.status,
        origin: originStr,
        destination: destinationStr,
      });
      return null;
    }

    // Duration is returned in seconds, convert to minutes
    const durationSeconds = element.duration.value;
    const drivingTimeMinutes = Math.round(durationSeconds / 60);
    const drivingDistanceKm = Math.round(element.distance.value / 1000);

    logger.log("Driving info calculated", {
      drivingTimeMinutes,
      durationText: element.duration.text,
      drivingDistanceKm,
      distanceText: element.distance.text,
    });

    return { drivingTimeMinutes, drivingDistanceKm };
  } catch (error) {
    logger.error("Failed to calculate driving info", error as Error, {
      origin: originStr,
      destination: destinationStr,
    });
    return null;
  }
}

export const GoogleMapsService = {
  getDrivingInfo,
};
