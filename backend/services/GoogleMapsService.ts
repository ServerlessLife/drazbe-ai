import { logger } from "../utils/logger.js";
import { Centroid } from "../types/GursValuationBase.js";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Location can be specified as coordinates or an address string
 */
export type Location = Centroid | string;

/**
 * Convert Slovenian D96/TM coordinates (EPSG:3794) to WGS84 (lat/lng)
 * Using approximate transformation for Slovenia region
 */
function convertD96ToWGS84(centroid: Centroid): { lat: number; lng: number } {
  // D96/TM (EPSG:3794) to WGS84 approximate conversion for Slovenia
  // This is a simplified transformation - for high precision, use proj4 library
  const e = centroid.e;
  const n = centroid.n;

  // Central meridian for D96/TM is 15°E, false easting 500000, false northing -5000000
  // Approximate inverse transformation
  const lng = 15 + (e - 500000) / (111320 * Math.cos((46 * Math.PI) / 180));
  const lat = (n + 5000000) / 110540;

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
 * Calculate driving time between two locations using Google Maps Distance Matrix API
 * @param origin - Starting location (centroid or address)
 * @param destination - Ending location (centroid or address)
 * @returns Driving time in minutes, or null if route not found
 */
async function getDrivingTime(origin: Location, destination: Location): Promise<number | null> {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error(
      "Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY environment variable."
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
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originStr}&destinations=${destinationStr}&mode=driving&key=${GOOGLE_MAPS_API_KEY}`;

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
    const durationMinutes = Math.round(durationSeconds / 60);

    logger.log("Driving time calculated", {
      durationMinutes,
      durationText: element.duration.text,
      distanceKm: Math.round(element.distance.value / 1000),
      distanceText: element.distance.text,
    });

    return durationMinutes;
  } catch (error) {
    logger.error("Failed to calculate driving time", error as Error, {
      origin: originStr,
      destination: destinationStr,
    });
    return null;
  }
}

export const GoogleMapsService = {
  getDrivingTime,
  convertD96ToWGS84,
};
