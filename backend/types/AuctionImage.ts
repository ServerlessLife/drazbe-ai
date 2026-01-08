import { AuctionLink } from "./AuctionLink";

/**
 * Image data for an auction
 */

export type AuctionImage = AuctionLink & {
  localUrl?: string;
};
