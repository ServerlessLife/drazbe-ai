import { z } from "zod";
import { actionBaseSchema } from "./Action.js";

export const actionsSchema = z.object({
  actions: z.array(actionBaseSchema).describe("Seznam vseh dražb navedenih v dokumentu"),
});

export type Actions = z.infer<typeof actionsSchema>;
