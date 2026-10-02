import { z } from "zod";
import { navigationSlots } from "@smartdoca/web-plugin-registry";
const title = z
  .object({ en: z.string().min(1).max(80), zh: z.string().min(1).max(80) })
  .strict();
const slot = z.enum(navigationSlots);
const id = z.string().regex(/^[a-z][a-z0-9.-]{1,159}$/);
export const pluginNavigationSchema = z
  .array(
    z
      .object({
        id,
        title,
        icon: z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/)
          .max(40),
        webPath: z
          .string()
          .regex(/^\/plugins\/[a-z][a-z0-9.-]*\/[a-zA-Z0-9/_-]*$/)
          .max(300),
        mobile: z.boolean().optional(),
        allowedSlots: z.array(slot).min(1).max(navigationSlots.length),
        defaults: z.array(slot).max(navigationSlots.length),
        order: z.number().int().min(-10000).max(10000),
        adminOnly: z.boolean().optional(),
      })
      .strict(),
  )
  .max(30);
const layout = z
  .object({
    placements: z
      .array(
        z
          .object({
            entryId: id,
            slot,
            order: z.number().int().min(-10000).max(10000),
            hidden: z.boolean().optional(),
            title: title.optional(),
            group: z.string().max(80).optional(),
            collapsed: z.boolean().optional(),
            icon: z
              .string()
              .regex(/^[a-z][a-z0-9-]{0,39}$/)
              .optional(),
            display: z.enum(["both", "icon", "text"]).optional(),
          })
          .strict(),
      )
      .max(1000),
    home: z
      .object({ web: id.optional(), mobile: id.optional() })
      .strict()
      .optional(),
  })
  .strict();
export const navigationConfigSchema = z
  .object({ schemaVersion: z.literal(1), layout })
  .strict();
