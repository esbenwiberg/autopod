import { z } from 'zod';

/** PATCH/override absence (including explicit undefined) must not apply creation defaults. */
export function partialWithoutDefaults<
  Shape extends z.ZodRawShape,
  Config extends z.core.$ZodObjectConfig,
>(schema: z.ZodObject<Shape, Config>) {
  // Object.fromEntries erases key/value correlation. Every original field is retained,
  // with undefined FIRST in its union so a defaulted inner schema is never invoked for it.
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      z.union([z.undefined(), field]).optional(),
    ]),
  ) as { [Key in keyof Shape]: z.ZodOptional<z.ZodUnion<[z.ZodUndefined, Shape[Key]]>> };
  // Keep the original object's strict/strip/catchall policy; extend refuses object refinements.
  return schema.extend(shape);
}
