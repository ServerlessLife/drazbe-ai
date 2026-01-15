import { AuctionLink } from "./AuctionLink";

export interface AuctionDocument extends AuctionLink {
  localUrl: string;
  type: "pdf" | "docx" | "unknown";
  ocrUsed?: boolean;
  usedForExtraction: boolean;
}
