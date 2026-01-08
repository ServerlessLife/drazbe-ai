import { z } from "zod";
import { announcementSchema } from "./AnnouncementResult.js";

export const detailSchema = z.object({
  announcements: z
    .array(announcementSchema)
    .describe("Seznam vseh objav/nepremičnin navedenih v dokumentu"),
});

export type Detail = z.infer<typeof detailSchema>;
