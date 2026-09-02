/**
 * createTextStyle — builds a TextStyle from a partial spec. In RN, fontWeight
 * is string literal; we keep the map simple and typed.
 */
export type TextStyleFactory = {
  style: Record<string, unknown>;
};

export function createTextStyle(spec: Record<string, unknown>): TextStyleFactory {
  return { style: spec };
}