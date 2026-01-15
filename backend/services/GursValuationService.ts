import { GursParcelValuation, gursParcelValuationSchema } from "../types/GursParcelValuation.js";
import {
  GursBuildingPartValuation,
  gursBuildingPartValuationSchema,
} from "../types/GursBuildingPartValuation.js";
import { PropertyKey, propertyKeySchema } from "../types/PropertyIdentifier.js";
import { logger } from "../utils/logger.js";

const BASE_URL = "https://vrednotenje.gov.si/EV_Javni_Server/podatki";

// Helper to find land use data in faktorji podatki
function findLandUseValue(faktorji: any[]): string | undefined {
  for (const f of faktorji) {
    const podatki = f.podatki || [];
    // Look for any field containing "raba" in the description (handles both "Namenska raba" and "Dejanska raba")
    const found = podatki.find((p: any) => p.key?.opis?.toLowerCase().includes("namenska raba"));
    if (found?.vrednost) {
      return found.vrednost;
    }
  }
  return undefined;
}

async function getParcelValuation(query: PropertyKey): Promise<GursParcelValuation | null> {
  logger.log("Fetching parcel valuation", {
    municipality: query.cadastralMunicipality,
    number: query.number,
  });

  const validated = propertyKeySchema.safeParse(query);
  if (!validated.success) {
    logger.warn("Invalid property key for parcel", {
      query,
      validationErrors: validated.error.issues,
    });
    return null;
  }

  const searchRes = await fetch(
    `${BASE_URL}/parcela/search?count=101&offset=0&parcela=${encodeURIComponent(validated.data.number)}&koSifko=${validated.data.cadastralMunicipality}`
  ).then((r) => r.json());

  if (!searchRes?.[0]?.pcMid) {
    logger.warn("Parcel not found in API response", {
      municipality: validated.data.cadastralMunicipality,
      parcelNumber: validated.data.number,
      responseLength: searchRes?.length || 0,
    });
    return null;
  }

  const id = searchRes[0].pcMid;
  logger.log("Fetching parcel details", { pcMid: id });
  const [basic, valueArr] = await Promise.all([
    fetch(`${BASE_URL}/parcela/${id}`).then((r) => r.json()),
    fetch(`${BASE_URL}/parcela/${id}/vrednost?expandOkoliscine=true`).then((r) => r.json()),
  ]);

  // Sum all posplosenaVrednost values from different valuation models
  const totalValue = (valueArr || []).reduce(
    (sum: number, v: any) => sum + (v?.posplosenaVrednost || 0),
    0
  );

  // Extract intended use (namenska raba) with percentages from all valuation entries
  // Uses delezPov (share percentage) field from each entry
  const intendedUseEntries = (valueArr || [])
    .map((v: any) => {
      const faktorji = v?.izracun?.faktorji || [];
      const namenskaRaba = findLandUseValue(faktorji);

      const delezPov = v?.delezPov;
      if (namenskaRaba && delezPov > 0) {
        return { use: namenskaRaba, percentage: delezPov };
      }
      return null;
    })
    .filter(Boolean) as { use: string; percentage: number }[];

  // Normalize percentages to 100% (only count entries with namenska raba)
  const totalPercentage = intendedUseEntries.reduce((sum, e) => sum + e.percentage, 0);

  // Sort by percentage descending and format with normalized percentages
  intendedUseEntries.sort((a, b) => b.percentage - a.percentage);
  const intendedUse =
    intendedUseEntries.length > 0
      ? intendedUseEntries
          .map((e) => {
            const normalized =
              totalPercentage > 0 ? (e.percentage / totalPercentage) * 100 : e.percentage;
            return `${e.use} ${normalized.toFixed(1).replace(".", ",")} %`;
          })
          .join(", ")
      : undefined;

  const result: GursParcelValuation = {
    type: "parcel",
    cadastralMunicipality: validated.data.cadastralMunicipality,
    number: validated.data.number,
    surfaceArea: basic?.povrsina || 0,
    value: totalValue,
    centroid: basic?.cenx && basic?.ceny ? { e: basic.ceny, n: basic.cenx } : undefined,
    intendedUse,
  };

  logger.log("Parcel valuation retrieved", {
    surfaceArea: result.surfaceArea,
    value: result.value,
  });

  return result;
}

async function getBuildingPartValuation(
  query: PropertyKey
): Promise<GursBuildingPartValuation | null> {
  logger.log("Fetching building part valuation", {
    municipality: query.cadastralMunicipality,
    number: query.number,
  });

  const validated = propertyKeySchema.safeParse(query);
  if (!validated.success) {
    logger.warn("Invalid property key for building part", {
      query,
      validationErrors: validated.error.issues,
    });
    return null;
  }

  const [buildingNum, partNum = "1"] = validated.data.number.split("/");
  if (!buildingNum) {
    logger.warn("Invalid building number format - missing building number", {
      providedNumber: validated.data.number,
      municipality: validated.data.cadastralMunicipality,
    });
    return null;
  }

  const searchRes = await fetch(
    `${BASE_URL}/delStavbe/search?count=101&offset=0&koSifko=${validated.data.cadastralMunicipality}&stevStavbe=${buildingNum}&stevDst=${partNum}`
  ).then((r) => r.json());

  if (!searchRes?.[0]?.dstSid) {
    logger.warn("Building part not found in API response", {
      municipality: validated.data.cadastralMunicipality,
      buildingNumber: buildingNum,
      partNumber: partNum,
      responseLength: searchRes?.length || 0,
    });
    return null;
  }

  const { dstSid: partId, staSid: buildingId, hsMid: addressId } = searchRes[0];
  logger.log("Fetching building part details", { partId, buildingId, addressId });

  const [part, building, address, value] = await Promise.all([
    fetch(`${BASE_URL}/delStavbe/${partId}`).then((r) => r.json()),
    fetch(`${BASE_URL}/stavba/${buildingId}`).then((r) => r.json()),
    addressId
      ? fetch(`https://vrednotenje.gov.si/EV_Javni_Server/system/naslov/${addressId}`).then((r) =>
          r.json()
        )
      : null,
    fetch(`${BASE_URL}/delStavbe/${partId}/vrednost?expandOkoliscine=true`).then((r) => r.json()),
  ]);

  const izvorniPodatki =
    value?.izracun?.faktorji?.flatMap(
      (f: any) => f.podatki?.flatMap((p: any) => p.izvorniPodatki || []) || []
    ) || [];

  const getIzvorni = (prefix: string) =>
    izvorniPodatki.find((p: any) => p.prefix?.toLowerCase() === prefix.toLowerCase())?.vrednost;

  const result: GursBuildingPartValuation = {
    type: "building_part",
    cadastralMunicipality: validated.data.cadastralMunicipality,
    number: validated.data.number,
    address: address?.polniNaslov,
    value: value?.posplosenaVrednost || 0,
    apartmentNumber: part?.stevStan,
    actualUse: getIzvorni("Dejanska raba")?.trim(),
    floor: part?.stNadstropja,
    elevator: getIzvorni("dvigalo"),
    netFloorArea: part?.povrsina,
    centroid: building?.cenx && building?.ceny ? { e: building.ceny, n: building.cenx } : undefined,
    buildingType: building?.idTipStavbe ? `Tip ${building.idTipStavbe}` : undefined,
    numberOfFloors: building?.stEtaz,
    numberOfApartments: building?.steviloStanovanj,
    yearBuilt: building?.letoIzgSta,
  };

  logger.log("Building part valuation retrieved", {
    address: result.address,
    value: result.value,
    netFloorArea: result.netFloorArea,
  });

  return result;
}

async function getValuation(
  query: PropertyKey,
  ownershipShare: number | null
): Promise<GursParcelValuation | GursBuildingPartValuation | null> {
  logger.log("Getting valuation", {
    type: query.type,
    municipality: query.cadastralMunicipality,
    number: query.number,
    ownershipShare,
  });

  const validated = propertyKeySchema.safeParse(query);
  if (!validated.success) {
    logger.warn("Invalid property key for valuation", {
      query,
      validationErrors: validated.error.issues,
    });
    return null;
  }

  // Use the provided type as a hint for which API to try first
  // If the first attempt fails (returns null), automatically fallback to the other type
  // This handles cases where the type property might be incorrect or mismatched
  let result: GursParcelValuation | GursBuildingPartValuation | null = null;

  try {
    if (validated.data.type === "parcel") {
      // Try parcel first
      logger.log("Trying as parcel first");
      result = await getParcelValuation(validated.data);
      if (!result) {
        // Parcel lookup failed, try as building part instead
        logger.log("Parcel lookup failed, trying as building part");
        result = await getBuildingPartValuation({ ...validated.data, type: "building_part" });
      }
    } else {
      // Try building part first
      logger.log("Trying as building part first");
      result = await getBuildingPartValuation(validated.data);
      if (!result) {
        // Building part lookup failed, try as parcel instead
        logger.log("Building part lookup failed, trying as parcel");
        result = await getParcelValuation({ ...validated.data, type: "parcel" });
      }
    }
  } catch (error) {
    logger.warn("Error occurred during valuation retrieval", error, {
      type: validated.data.type,
      municipality: validated.data.cadastralMunicipality,
      number: validated.data.number,
    });
  }

  // If failed, try with cleaned number (only digits and /)
  if (!result) {
    const cleanedNumber = validated.data.number.replace(/[^0-9/]/g, "");
    if (cleanedNumber !== validated.data.number && cleanedNumber.length > 0) {
      logger.log("Retrying with cleaned number", {
        original: validated.data.number,
        cleaned: cleanedNumber,
      });
      return getValuation({ ...validated.data, number: cleanedNumber }, ownershipShare);
    }
  }

  // Apply ownership share to value if provided
  if (result && ownershipShare != null && ownershipShare > 0 && ownershipShare < 100) {
    const adjustedValue = Math.round(result.value * (ownershipShare / 100));
    logger.log("Adjusting value for ownership share", {
      originalValue: result.value,
      ownershipShare,
      adjustedValue,
    });
    result = { ...result, value: adjustedValue, reducedByOwnershipShare: true };
  }

  return result;
}

export const GursValuationService = { getValuation };
