import {
  ParcelValuation,
  BuildingPartValuation,
  ValuationQuery,
  valuationQuerySchema,
} from "./types/ValuationData.js";

const BASE_URL = "https://vrednotenje.gov.si/EV_Javni_Server/podatki";

async function getParcelValuation(query: ValuationQuery): Promise<ParcelValuation | null> {
  const validated = valuationQuerySchema.safeParse(query);
  if (!validated.success) return null;

  const searchRes = await fetch(
    `${BASE_URL}/parcela/search?count=101&offset=0&parcela=${encodeURIComponent(validated.data.number)}&koSifko=${validated.data.cadastralMunicipality}`
  ).then((r) => r.json());

  if (!searchRes?.[0]?.pcMid) return null;

  const id = searchRes[0].pcMid;
  const [basic, value] = await Promise.all([
    fetch(`${BASE_URL}/parcela/${id}`).then((r) => r.json()),
    fetch(`${BASE_URL}/parcela/${id}/vrednost?expandOkoliscine=true`).then((r) => r.json()),
  ]);

  return {
    surfaceArea: basic?.povrsina || 0,
    value: value?.[0]?.posplosenaVrednost || 0,
    centroid: basic?.cenx && basic?.ceny ? { e: basic.ceny, n: basic.cenx } : undefined,
    intendedUse: value?.[0]?.izracun?.faktorji?.[0]?.podatki?.find(
      (p: any) => p.key?.opis === "Namenska raba zemljišča"
    )?.vrednost,
  };
}

async function getBuildingPartValuation(
  query: ValuationQuery
): Promise<BuildingPartValuation | null> {
  const validated = valuationQuerySchema.safeParse(query);
  if (!validated.success) return null;

  const [buildingNum, partNum] = validated.data.number.split("/");
  if (!buildingNum || !partNum) return null;

  const searchRes = await fetch(
    `${BASE_URL}/delStavbe/search?count=101&offset=0&koSifko=${validated.data.cadastralMunicipality}&stevStavbe=${buildingNum}&stevDst=${partNum}`
  ).then((r) => r.json());

  if (!searchRes?.[0]?.dstSid) return null;

  const { dstSid: partId, staSid: buildingId, hsMid: addressId } = searchRes[0];

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

  return {
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
}

async function getValuation(
  query: ValuationQuery
): Promise<ParcelValuation | BuildingPartValuation | null> {
  const validated = valuationQuerySchema.safeParse(query);
  if (!validated.success) return null;

  // Use the provided type as a hint for which API to try first
  // If the first attempt fails (returns null), automatically fallback to the other type
  // This handles cases where the type property might be incorrect or mismatched
  if (validated.data.type === "parcel") {
    // Try parcel first
    const result = await getParcelValuation(validated.data);
    if (result) return result;
    // Parcel lookup failed, try as building part instead
    return getBuildingPartValuation({ ...validated.data, type: "building_part" });
  } else {
    // Try building part first
    const result = await getBuildingPartValuation(validated.data);
    if (result) return result;
    // Building part lookup failed, try as parcel instead
    return getParcelValuation({ ...validated.data, type: "parcel" });
  }
}

export const ValuationService = { getParcelValuation, getBuildingPartValuation, getValuation };
