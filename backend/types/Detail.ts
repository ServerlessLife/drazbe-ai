import { z } from "zod";
import { auctionBaseSchema } from "./AuctionBase.js";

export const auctionsSchema = z.object({
  auctions: z.array(auctionBaseSchema).describe("Seznam vseh dražb navedenih v dokumentu"),
});

export type Auctions = z.infer<typeof auctionsSchema>;
