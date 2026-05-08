/** Loose JSON Schema shape — not the full draft, just what we read. */
export type JSONSchema = {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema | JSONSchema[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [key: string]: unknown;
};
