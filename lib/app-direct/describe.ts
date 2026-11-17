import type { Definition, Operation } from '@/lib/app-direct/definition';

/**
 * What the bot server is told about a key app, so a Brick can use it: the operations as tools, with the heading each falls under.
 * Never the key, the origin's path rules or anything of the definition's insides beyond what a tool needs.
 */

export type ActionHeading = 'looksUp' | 'makesNew' | 'changesThings' | 'deletesOrSends';

const HEADING_OF: Record<Operation['category'], ActionHeading> = { lookUp: 'looksUp', make: 'makesNew', change: 'changesThings', deleteSend: 'deletesOrSends' };

/**
 * The one classification every use goes by, here and nowhere else (chat, goals and pages alike). An operation we tested keeps its
 * category. A custom operation is unverified whatever its method: it never counts as a look-up that runs unasked, so it is at
 * least "changes things", which asks first unless the person already said yes to exactly this operation of this version.
 */
export function headingOf(operation: Operation): ActionHeading {
  const declared = HEADING_OF[operation.category];
  if (operation.verified) return declared;
  return declared === 'looksUp' || declared === 'makesNew' ? 'changesThings' : declared;
}

/** The JSON Schema the model fills in for one operation: only the parameters the operation names, nothing else allowed. */
export function inputSchemaOf(operation: Operation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of operation.params) {
    const property: Record<string, unknown> = { type: param.type };
    if (param.description) property.description = param.description;
    if (param.oneOf) property.enum = param.oneOf;
    else if (param.type === 'string') property.maxLength = param.maxLength ?? 500;
    properties[param.name] = property;
    if (param.required) required.push(param.name);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
}

export interface KeyAppOperationView {
  id: string;
  label: string;
  category: Operation['category'];
  /** The heading it falls under (`headingOf`): the bot server asks, remembers and refuses by the grant's setting for it. */
  heading: ActionHeading;
  verified: boolean;
  inputSchema: Record<string, unknown>;
}

export const operationViews = (definition: Definition): KeyAppOperationView[] =>
  definition.operations.map((operation) => ({
    id: operation.id,
    label: operation.label,
    category: operation.category,
    heading: headingOf(operation),
    verified: operation.verified,
    inputSchema: inputSchemaOf(operation),
  }));
