import { z } from 'zod'
import type { JsonValue } from '../types/index.js'

/**
 * Minimal JSON Schema → Zod converter for MCP tool inputSchema.
 * Supports: type object/array/string/number/integer/boolean, enum, required,
 * properties, items, additionalProperties, description, default.
 * Falls back to passthrough for unknown/complex schemas.
 */
export function jsonSchemaToZod(schema: Record<string, JsonValue>): z.ZodTypeAny {
  try {
    const converted = convert(schema)
    // MCP schemas are always objects at top level; ensure passthrough for extra props
    if (converted instanceof z.ZodObject) {
      return (converted as z.ZodObject<Record<string, z.ZodTypeAny>>).passthrough()
    }
    return converted
  } catch {
    return z.object({}).passthrough()
  }
}

function convert(node: Record<string, JsonValue>): z.ZodTypeAny {
  const t = node.type as string | undefined
  const enumVals = node.enum as JsonValue[] | undefined
  if (enumVals && Array.isArray(enumVals)) {
    // z.enum requires non-empty string array; fallback to union of literals
    if (enumVals.length === 0) return z.any()
    if (enumVals.every((v) => typeof v === 'string'))
      return z.enum(enumVals as [string, ...string[]])
    return z.union(
      enumVals.map((v) => z.literal(v as string | number | boolean)) as unknown as [
        z.ZodTypeAny,
        z.ZodTypeAny,
        ...z.ZodTypeAny[],
      ],
    )
  }

  switch (t) {
    case 'string': {
      let s: z.ZodString = z.string()
      if (typeof node.minLength === 'number') s = s.min(node.minLength as number)
      if (typeof node.maxLength === 'number') s = s.max(node.maxLength as number)
      if (typeof node.pattern === 'string') s = s.regex(new RegExp(node.pattern as string))
      if (typeof node.format === 'string') {
        if (node.format === 'email') s = s.email()
        else if (node.format === 'uri' || node.format === 'uri-reference') s = s.url()
        else if (node.format === 'uuid') s = s.uuid()
      }
      if (typeof node.description === 'string') s = s.describe(node.description as string)
      if (node.default !== undefined) return s.default(node.default as string)
      return s
    }
    case 'number':
    case 'integer': {
      let n: z.ZodNumber = t === 'integer' ? z.number().int() : z.number()
      if (typeof node.minimum === 'number') n = n.min(node.minimum as number)
      if (typeof node.maximum === 'number') n = n.max(node.maximum as number)
      if (typeof node.exclusiveMinimum === 'number') n = n.gt(node.exclusiveMinimum as number)
      if (typeof node.exclusiveMaximum === 'number') n = n.lt(node.exclusiveMaximum as number)
      if (typeof node.description === 'string') n = n.describe(node.description as string)
      if (node.default !== undefined) return n.default(node.default as number)
      return n
    }
    case 'boolean': {
      let b = z.boolean()
      if (typeof node.description === 'string') b = b.describe(node.description as string)
      if (node.default !== undefined) return b.default(node.default as boolean)
      return b
    }
    case 'array': {
      const items = node.items as Record<string, JsonValue> | undefined
      let arr = items ? z.array(convert(items)) : z.array(z.any())
      if (typeof node.minItems === 'number') arr = arr.min(node.minItems as number)
      if (typeof node.maxItems === 'number') arr = arr.max(node.maxItems as number)
      if (typeof node.description === 'string') arr = arr.describe(node.description as string)
      if (node.default !== undefined) return arr.default(node.default as JsonValue[] as never)
      return arr
    }
    case 'object':
    case undefined: {
      // No explicit type but has properties → treat as object
      const props = node.properties as Record<string, Record<string, JsonValue>> | undefined
      const required = (node.required as string[] | undefined) ?? []
      if (!props) {
        // Free-form object
        const obj = z.object({}).passthrough()
        if (typeof node.description === 'string') return obj.describe(node.description as string)
        return obj
      }
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [k, v] of Object.entries(props)) {
        let field = convert(v as Record<string, JsonValue>)
        if (!required.includes(k)) field = field.optional()
        if (typeof (v as Record<string, JsonValue>).description === 'string') {
          field = field.describe((v as Record<string, JsonValue>).description as string)
        }
        shape[k] = field
      }
      let obj: z.ZodTypeAny = z.object(shape)
      // additionalProperties: false → strict, otherwise passthrough
      if (node.additionalProperties === false)
        obj = (obj as z.ZodObject<Record<string, z.ZodTypeAny>>).strict()
      else obj = (obj as z.ZodObject<Record<string, z.ZodTypeAny>>).passthrough()
      if (typeof node.description === 'string') obj = obj.describe(node.description as string)
      return obj
    }
    default:
      return z.any()
  }
}
