/**
 * Utility to format Zod schemas as human-readable descriptions for prompts
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Formats a Zod schema as a human-readable description for use in prompts
 * 
 * @param schema - The Zod schema to format
 * @param schemaName - Optional name for the schema (e.g., "code-search")
 * @returns A formatted markdown-like description of the schema
 */
export function formatSchemaForPrompt(schema: z.ZodTypeAny, schemaName?: string): string {
  try {
    const jsonSchema = zodToJsonSchema(schema, { target: 'openApi3' }) as any;
    const properties = jsonSchema.properties || {};
    const required = jsonSchema.required || [];
    
    const lines: string[] = [];
    
    if (schemaName) {
      lines.push(`The \`${schemaName}\` tool accepts the following parameters:\n`);
    } else {
      lines.push(`The tool accepts the following parameters:\n`);
    }
    
    for (const [fieldName, fieldSchema] of Object.entries(properties)) {
      const isRequired = required.includes(fieldName);
      const fieldInfo = fieldSchema as any;
      
      // Build the field description
      const fieldLines: string[] = [];
      
      // Field name and required/optional status
      const status = isRequired ? 'required' : 'optional';
      fieldLines.push(`- **${fieldName}** (${getTypeDescription(fieldInfo)}, ${status}): ${fieldInfo.description || 'No description'}`);
      
      // Add enum values if present
      if (fieldInfo.enum) {
        const enumValues = fieldInfo.enum.map((v: any) => `\`"${v}"\``).join(', ');
        fieldLines.push(`  - Valid values: ${enumValues}`);
      }
      
      // Handle enum with descriptions (e.g., mode field with multi-line description)
      if (fieldInfo.enum && fieldInfo.description) {
        // Check if description contains enum explanations (format: "value1: description1\nvalue2: description2")
        const description = fieldInfo.description;
        if (description.includes('\n') || description.includes(':')) {
          // Try to parse enum descriptions from the description string
          const enumLines = description.split('\n').filter((line: string) => line.trim());
          if (enumLines.length > 0) {
            fieldLines.push(`  - Enum values:`);
            for (const line of enumLines) {
              // Format: "value: description" or just "value"
              const trimmed = line.trim();
              if (trimmed) {
                fieldLines.push(`    - ${trimmed}`);
              }
            }
          }
        }
      }
      
      // Add enum descriptions if present (for mode fields with descriptions)
      if (fieldInfo.anyOf && Array.isArray(fieldInfo.anyOf)) {
        const enumDescriptions: string[] = [];
        for (const option of fieldInfo.anyOf) {
          if (option.const !== undefined && option.description) {
            enumDescriptions.push(`  - \`"${option.const}"\`: ${option.description}`);
          }
        }
        if (enumDescriptions.length > 0) {
          fieldLines.push(...enumDescriptions);
        }
      }
      
      lines.push(...fieldLines);
    }
    
    return lines.join('\n');
  } catch (error) {
    console.error('[SchemaFormatter] Failed to format schema:', error);
    // Fallback: return a basic message
    return `The tool accepts parameters as defined in its schema.`;
  }
}

/**
 * Gets a human-readable type description from JSON Schema type info
 */
function getTypeDescription(fieldInfo: any): string {
  if (fieldInfo.type) {
    return fieldInfo.type;
  }
  if (fieldInfo.enum) {
    return `enum: ${fieldInfo.enum.join(' | ')}`;
  }
  if (fieldInfo.anyOf) {
    return 'enum';
  }
  return 'any';
}

/**
 * Generates a JSON format example from a Zod schema
 * Creates a TypeScript-like type representation showing the structure
 * 
 * @param schema - The Zod schema to generate JSON format from
 * @returns A formatted JSON example string showing the expected structure
 */
export function generateJsonFormatFromSchema(schema: z.ZodTypeAny): string {
  try {
    const jsonSchema = zodToJsonSchema(schema, { target: 'openApi3' }) as any;
    const properties = jsonSchema.properties || {};
    const required = jsonSchema.required || [];
    
    const jsonFields: string[] = [];
    
    for (const [fieldName, fieldSchema] of Object.entries(properties)) {
      const isRequired = required.includes(fieldName);
      const fieldInfo = fieldSchema as any;
      
      // Generate the type representation for this field
      let typeRep = getJsonTypeRepresentation(fieldInfo);
      
      // Mark optional fields
      if (!isRequired) {
        typeRep += ' (optional)';
      }
      
      jsonFields.push(`  "${fieldName}": ${typeRep}`);
    }
    
    return `{\n${jsonFields.join(',\n')}\n}`;
  } catch (error) {
    console.error('[SchemaFormatter] Failed to generate JSON format:', error);
    return '{}';
  }
}

/**
 * Gets a JSON type representation for a field
 */
function getJsonTypeRepresentation(fieldInfo: any): string {
  if (fieldInfo.type === 'string') {
    if (fieldInfo.enum) {
      // For enums, show all possible values
      const enumValues = fieldInfo.enum.map((v: any) => `"${v}"`).join(' | ');
      return enumValues;
    }
    return '"string"';
  }
  if (fieldInfo.type === 'number' || fieldInfo.type === 'integer') {
    return 'number';
  }
  if (fieldInfo.type === 'boolean') {
    return 'boolean';
  }
  if (fieldInfo.type === 'array') {
    const itemsType = fieldInfo.items ? getJsonTypeRepresentation(fieldInfo.items) : 'any';
    return `[${itemsType}]`;
  }
  if (fieldInfo.type === 'object') {
    return 'object';
  }
  if (fieldInfo.enum) {
    const enumValues = fieldInfo.enum.map((v: any) => `"${v}"`).join(' | ');
    return enumValues;
  }
  if (fieldInfo.anyOf) {
    // Handle union types
    const types = fieldInfo.anyOf.map((option: any) => {
      if (option.const !== undefined) {
        return `"${option.const}"`;
      }
      return getJsonTypeRepresentation(option);
    });
    return types.join(' | ');
  }
  return 'any';
}

