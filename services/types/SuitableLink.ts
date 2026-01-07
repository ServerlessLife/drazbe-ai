import { z } from "zod";

export const suitableLinkSchema = z.object({
  title: z.string().describe("Naslov objave"),
  link: z.string().describe("Povezava do objave (polni URL)"),
  reason: z.string().describe("Kratek razlog zakaj je objava ustrezna").nullable(),
});

export const suitableLinksSchema = z.object({
  suitableLinks: z.array(suitableLinkSchema),
});

export type SuitableLink = z.infer<typeof suitableLinkSchema>;
