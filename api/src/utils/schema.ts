import { ZodType, z } from "zod";

export type Models<Key extends string = string> = {
  readonly [K in Key]: ZodType<unknown>;
};

export type BuildJsonSchemasOptions = {
  readonly $id?: string;
  readonly target?: `jsonSchema7` | `openApi3`;
  readonly errorMessages?: boolean;
};

export type SchemaKey<M extends Models> = M extends Models<infer Key> ? Key & string : never;

export type SchemaKeyOrDescription<M extends Models> =
  | SchemaKey<M>
  | {
      readonly description: string;
      readonly key: SchemaKey<M>;
    };

export type $Ref<M extends Models> = (key: SchemaKeyOrDescription<M>) => {
  readonly $ref: string;
  readonly description?: string;
};

export type JsonSchema = {
  readonly $id: string;
};

export type BuildJsonSchemasResult<M extends Models> = {
  readonly schemas: JsonSchema[];
  readonly $ref: $Ref<M>;
};

export const buildJsonSchemas = <M extends Models>(
  models: M,
  opts: BuildJsonSchemasOptions = {},
): BuildJsonSchemasResult<M> => {
  const cleanedSchemas = Object.entries(models).map(([key, model]) => {
    const schema = z.toJSONSchema(model, {
      target: opts.target === "jsonSchema7" ? "draft-07" : "openapi-3.0",
      io: "input",
      reused: "inline",
      unrepresentable: ({ zodSchema }) =>
        zodSchema._zod.def.type === "date" ? { type: "string", format: "date-time" } : "throw",
      override: ({ zodSchema, jsonSchema }) => {
        if (zodSchema._zod.def.type === "object" && jsonSchema.additionalProperties === undefined) {
          jsonSchema.additionalProperties = false;
        }
      },
    });
    delete schema.$schema;
    return { $id: key, title: key, ...schema };
  });

  const $ref: $Ref<M> = (key) => {
    const $ref = `${typeof key === `string` ? key : key.key}#`;
    return typeof key === `string`
      ? {
          $ref,
        }
      : {
          $ref,
          description: key.description,
        };
  };
  return {
    schemas: cleanedSchemas,
    $ref,
  };
};
