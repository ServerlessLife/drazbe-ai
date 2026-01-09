import { hash } from "./hash.js";

/**
 * Helper to generate auctionId from dataSourceCode, sourceUrl and announcementId
 * Format: dataSourceCode_md5hash(sourceUrl_announcementId)
 */
export function generateAuctionId(
  dataSourceCode: string,
  sourceUrl: string,
  announcementId: string
): string {
  const hashed = hash(`${sourceUrl}_${announcementId}`);
  return `${dataSourceCode}_${hashed}`;
}
