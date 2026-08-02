import type { CobolRegexResults } from './cobol-preprocessor.js';

const MAX_DYNAMIC_VALUES = 32;

const NON_TARGET_VALUES = new Set([
  'SPACE',
  'SPACES',
  'ZERO',
  'ZEROS',
  'ZEROES',
  'LOW-VALUE',
  'LOW-VALUES',
  'HIGH-VALUE',
  'HIGH-VALUES',
  'QUOTE',
  'QUOTES',
  'NULL',
  'NULLS',
]);

type Assignment =
  | { line: number; order: number; targets: string[]; literal: string }
  | { line: number; order: number; targets: string[]; source: string };

function normalizeDataName(name: string): string {
  return name
    .replace(/\([^)]*\)/g, '')
    .trim()
    .toUpperCase();
}

function normalizeTargetValue(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    NON_TARGET_VALUES.has(normalized) ||
    !/^[A-Z0-9@#$][A-Z0-9@#$-]*$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function addValues(target: Set<string>, values: Iterable<string>): void {
  for (const value of values) {
    if (target.size >= MAX_DYNAMIC_VALUES) return;
    target.add(value);
  }
}

/**
 * Build a line-aware, path-insensitive resolver for COBOL data items that hold
 * program names or CICS resource identifiers.
 *
 * Sources are intentionally bounded to declarations with VALUE, literal MOVE,
 * and identifier-to-identifier MOVE. Values are accumulated rather than
 * overwritten so assignments in separate branches remain possible targets.
 */
export function createCobolDynamicValueResolver(
  extracted: CobolRegexResults,
): (dataName: string, useLine: number) => string[] {
  const initialValues = new Map<string, Set<string>>();

  for (const item of extracted.dataItems) {
    if (item.level === 88 || !item.values) continue;
    const name = normalizeDataName(item.name);
    let values = initialValues.get(name);
    if (!values) {
      values = new Set<string>();
      initialValues.set(name, values);
    }
    for (const rawValue of item.values) {
      const value = normalizeTargetValue(rawValue);
      if (value) addValues(values, [value]);
    }
  }

  let order = 0;
  const assignments: Assignment[] = [
    ...extracted.literalMoves.map((move) => ({
      line: move.line,
      order: order++,
      targets: move.targets,
      literal: move.value,
    })),
    ...extracted.moves
      .filter((move) => !move.corresponding)
      .map((move) => ({
        line: move.line,
        order: order++,
        targets: move.targets,
        source: move.from,
      })),
  ].sort((a, b) => a.line - b.line || a.order - b.order);

  const cache = new Map<string, string[]>();

  return (dataName: string, useLine: number): string[] => {
    const normalizedName = normalizeDataName(dataName);
    const cacheKey = `${normalizedName}:L${useLine}`;
    const cached = cache.get(cacheKey);
    if (cached) return [...cached];

    const valuesByName = new Map<string, Set<string>>();
    for (const [name, values] of initialValues) {
      valuesByName.set(name, new Set(values));
    }

    for (const assignment of assignments) {
      if (assignment.line >= useLine) break;

      let assignedValues: string[];
      if ('literal' in assignment) {
        const literal = normalizeTargetValue(assignment.literal);
        assignedValues = literal ? [literal] : [];
      } else {
        assignedValues = [...(valuesByName.get(normalizeDataName(assignment.source)) ?? [])];
      }
      if (assignedValues.length === 0) continue;

      for (const rawTarget of assignment.targets) {
        const target = normalizeDataName(rawTarget);
        let targetValues = valuesByName.get(target);
        if (!targetValues) {
          targetValues = new Set<string>();
          valuesByName.set(target, targetValues);
        }
        addValues(targetValues, assignedValues);
      }
    }

    const resolved = [...(valuesByName.get(normalizedName) ?? [])].slice(0, MAX_DYNAMIC_VALUES);
    cache.set(cacheKey, resolved);
    return [...resolved];
  };
}
