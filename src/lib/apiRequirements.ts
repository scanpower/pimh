import { autoFilledHeaders, type ApiOperation } from './apiSpecs';
import type { ContextPromptField } from '../types';
import { expandFieldAliases, lookupEntry, parseMemoryFacts } from './templating';

/**
 * Which named values an operation needs before it can be built, and which of those are missing.
 *
 * Kept separate from directApi.ts (which does the actual resolving) because these answers are
 * needed *before* the call runs: to tell the model which facts to go and find when an operation
 * is chained after a model turn, and to skip the call with a useful message instead of throwing
 * once the model is done. The two must agree with callOperation's resolution order — templates
 * first, then a by-name lookup for required parameters — or a call will be reported as ready and
 * then fail (or vice versa).
 */

/**
 * Assemble the value lookup an operation resolves its parameters against, in increasing order of
 * precedence: facts remembered from earlier scans, facts the model reported during *this* scan,
 * this scan's prompt fields, and the barcode itself.
 *
 * `freshNotes` outranking remembered facts is the point of the ordering, not an incidental
 * detail: Memory persists across scans, so a leftover `asin` or `title` from the previous item
 * would otherwise satisfy the call and act on the wrong product.
 */
export function buildApiValues(args: {
  memoryText: string | undefined;
  freshNotes: string[];
  promptFields: ContextPromptField[] | undefined;
  fieldValues: Record<string, string> | undefined;
  scan: string;
}): Record<string, string> {
  return {
    ...parseMemoryFacts(args.memoryText),
    ...parseMemoryFacts(args.freshNotes.join('\n')),
    ...expandFieldAliases(args.promptFields, args.fieldValues),
    scan: args.scan,
  };
}

const TOKEN_RE = /\{\{(\w+)\}\}/g;

function tokensIn(text: string | undefined): string[] {
  return [...(text ?? '').matchAll(TOKEN_RE)].map((m) => m[1]);
}

/**
 * Every value name this operation will look for, in the order they appear. Excludes `{{scan}}`
 * (always supplied from the barcode) and headers the spec can mint on demand, e.g. x-access-token.
 */
export function requiredValueNames(
  op: ApiOperation,
  paramValues: Record<string, string> | undefined,
  bodyTemplate: string | undefined,
): string[] {
  const auto = new Set(autoFilledHeaders(op));
  const names: string[] = [];

  for (const param of op.parameters) {
    if (auto.has(param.name)) continue;
    const template = paramValues?.[param.name];
    if (template) {
      names.push(...tokensIn(template));
    } else if (param.required) {
      // No template: callOperation falls back to a value of the same name as the parameter.
      names.push(param.name);
    }
    // An optional parameter with no template is simply omitted — nothing is needed for it.
  }
  names.push(...tokensIn(bodyTemplate));

  const seen = new Set<string>();
  return names.filter((name) => {
    if (name === 'scan' || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/**
 * The subset of requiredValueNames() that `values` can't satisfy. Matching ignores case and
 * separators (so a remembered `shipment_id` counts for `shipmentId`), and a value that resolves
 * to the empty string counts as missing — callOperation drops empties, which would leave a path
 * placeholder unfilled.
 */
export function missingValueNames(
  op: ApiOperation,
  paramValues: Record<string, string> | undefined,
  bodyTemplate: string | undefined,
  values: Record<string, string>,
): string[] {
  return requiredValueNames(op, paramValues, bodyTemplate).filter((name) => !lookupEntry(name, values)?.value);
}
