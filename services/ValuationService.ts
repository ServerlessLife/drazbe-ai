import { ParcelValuation, ValuationQuery } from "./types/ValuationData.js";

const BASE_URL = "https://vrednotenje.gov.si/EV_Javni_Server/podatki";

async function getParcelValuation(query: ValuationQuery): Promise<ParcelValuation | null> {
  if (query.type !== "parcel") return null;

  const searchRes = await fetch(
    `${BASE_URL}/parcela/search?count=101&offset=0&parcela=${encodeURIComponent(query.number)}&koSifko=${query.cadastralMunicipality}`
  ).then((r) => r.json());

  if (!searchRes?.[0]?.pcMid) return null;

  const id = searchRes[0].pcMid;
  const [basic, value] = await Promise.all([
    fetch(`${BASE_URL}/parcela/${id}`).then((r) => r.json()),
    fetch(`${BASE_URL}/parcela/${id}/vrednost?expandOkoliscine=true`).then((r) => r.json()),
  ]);

  const intendedUse = value?.[0]?.izracun?.faktorji?.[0]?.podatki?.find(
    (p: any) => p.key?.opis === "Namenska raba zemljišča"
  )?.vrednost;

  return {
    cadastralMunicipality: query.cadastralMunicipality,
    parcelNumber: query.number,
    surfaceArea: basic?.povrsina || 0,
    value: value?.[0]?.posplosenaVrednost || 0,
    centroid: basic?.cenx && basic?.ceny ? { e: basic.ceny, n: basic.cenx } : undefined,
    intendedUse,
  };
}

export const ValuationService = { getParcelValuation };
