import { z } from "zod";

export const linkSchema = z.object({
  title: z.string().describe("Naslov objave"),
  url: z.string().describe("Povezava do objave (polni URL)"),
  suitable: z.boolean().describe("Ali je objava ustrezna"),
  reason: z.string().describe("Kratek razlog zakaj je objava ustrezna ali neustrezna").nullable(),
});

export const linksSchema = z.object({
  links: z.array(linkSchema),
});

export type Link = z.infer<typeof linkSchema>;
