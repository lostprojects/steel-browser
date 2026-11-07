import { z } from "zod";

export const GetDevtoolsUrlSchema = z.object({
  sessionId: z.string().uuid().optional(),
});

export default {
  GetDevtoolsUrlSchema,
};
