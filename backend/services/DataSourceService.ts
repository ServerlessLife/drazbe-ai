import fs from "fs";
import path from "path";
import { Source } from "../types/Source.js";

let sourcesCache: Source[] | null = null;

/**
 * Load sources from sources.json file
 */
function getSources(): Source[] {
  if (sourcesCache) {
    return sourcesCache;
  }

  const sourcesPath = path.join(process.cwd(), "sources.json");
  sourcesCache = JSON.parse(fs.readFileSync(sourcesPath, "utf-8"));
  return sourcesCache!;
}

/**
 * Get source by code
 */
function getSourceByCode(code: string): Source | undefined {
  const sources = getSources();
  return sources.find((s) => s.code === code);
}

export const DataSourceService = {
  loadSources: getSources,
  getSourceByCode,
};
