import { createHash } from 'node:crypto';
import type {
  BuiltInCommunicationStyleSelection,
  CommunicationStyleSelection,
} from '../config/types.js';

export type { BuiltInCommunicationStyleSelection, CommunicationStyleSelection };

export const COMMUNICATION_STYLE_SELECTIONS = [
  'auto',
  'pragmatic',
  'friendly',
  'explanatory',
] as const satisfies readonly BuiltInCommunicationStyleSelection[];

export type EffectiveCommunicationStyle =
  | 'blade-default'
  | Exclude<CommunicationStyleSelection, 'auto'>;

export type CommunicationStyleSource = 'built-in' | 'user' | 'project' | 'plugin';

export interface CommunicationStyleSummary {
  id: CommunicationStyleSelection;
  name: string;
  description: string;
  source: CommunicationStyleSource;
  contentSha256?: string;
}

export interface CommunicationStyleDefinition extends CommunicationStyleSummary {
  prompt?: string;
}

export interface CommunicationStyleConfiguration {
  selection: CommunicationStyleSelection;
  effective: EffectiveCommunicationStyle;
  name: string;
  description: string;
  source: CommunicationStyleSource;
  contentSha256?: string;
  prompt?: string;
  supported: CommunicationStyleSummary[];
}

const STYLE_PROMPTS: Record<
  Exclude<BuiltInCommunicationStyleSelection, 'auto'>,
  string
> = {
  pragmatic: `Communicate as a deeply pragmatic, effective software engineer.
Be direct, factual, concise, and action-oriented. State assumptions and tradeoffs concretely.
Avoid filler, cheerleading, and unnecessary narration. Do not reduce engineering rigor or skip required validation.`,
  friendly: `Communicate as a warm, collaborative engineering teammate.
Be approachable and constructive while remaining factual and task-focused.
Explain decisions clearly without flattery, cheerleading, or unnecessary verbosity.`,
  explanatory: `Explain implementation choices and codebase-specific patterns as you work.
Keep explanations brief, relevant, and connected to behavior or engineering tradeoffs.
Maintain autonomy: do not pause for tutorials or ask the user to write code unless a real decision requires input.
Do not add explanatory comments to the codebase unless the code itself genuinely needs them.`,
};

const BUILTIN_STYLE_DETAILS: Record<
  BuiltInCommunicationStyleSelection,
  { name: string; description: string; prompt?: string }
> = {
  auto: {
    name: 'Auto',
    description: 'Use the Blade default communication style',
  },
  pragmatic: {
    name: 'Pragmatic',
    description: 'Direct, factual, concise, and action-oriented',
    prompt: STYLE_PROMPTS.pragmatic,
  },
  friendly: {
    name: 'Friendly',
    description: 'Warm, collaborative, and task-focused',
    prompt: STYLE_PROMPTS.friendly,
  },
  explanatory: {
    name: 'Explanatory',
    description: 'Explain codebase-specific choices and tradeoffs',
    prompt: STYLE_PROMPTS.explanatory,
  },
};

const CUSTOM_SEGMENT = '[a-z0-9][a-z0-9._-]{0,63}';
const CUSTOM_SELECTION = new RegExp(
  `^(?:(?:user|project):${CUSTOM_SEGMENT}(?::${CUSTOM_SEGMENT}){0,3}|plugin:${CUSTOM_SEGMENT}:${CUSTOM_SEGMENT}(?::${CUSTOM_SEGMENT}){0,3})$`
);

function digestPrompt(prompt: string | undefined): string | undefined {
  return prompt ? createHash('sha256').update(prompt, 'utf8').digest('hex') : undefined;
}

const BUILTIN_DEFINITIONS = COMMUNICATION_STYLE_SELECTIONS.map(
  (id): CommunicationStyleDefinition => {
    const details = BUILTIN_STYLE_DETAILS[id];
    return Object.freeze({
      id,
      name: details.name,
      description: details.description,
      source: 'built-in',
      ...(details.prompt
        ? {
            prompt: details.prompt,
            contentSha256: digestPrompt(details.prompt),
          }
        : {}),
    });
  }
);

export function isCommunicationStyleSelection(
  value: unknown
): value is CommunicationStyleSelection {
  return (
    typeof value === 'string' &&
    value.length <= 300 &&
    (COMMUNICATION_STYLE_SELECTIONS.includes(
      value as BuiltInCommunicationStyleSelection
    ) ||
      CUSTOM_SELECTION.test(value))
  );
}

function summary(definition: CommunicationStyleDefinition): CommunicationStyleSummary {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    source: definition.source,
    ...(definition.contentSha256 ? { contentSha256: definition.contentSha256 } : {}),
  };
}

export class CommunicationStyleCatalog {
  private readonly definitions: ReadonlyMap<
    CommunicationStyleSelection,
    CommunicationStyleDefinition
  >;

  constructor(customDefinitions: readonly CommunicationStyleDefinition[] = []) {
    const definitions = new Map<
      CommunicationStyleSelection,
      CommunicationStyleDefinition
    >();
    for (const definition of [...BUILTIN_DEFINITIONS, ...customDefinitions]) {
      if (!isCommunicationStyleSelection(definition.id)) {
        throw new Error(`Invalid communication style ID: ${definition.id}`);
      }
      if (
        definition.source !== 'built-in' &&
        COMMUNICATION_STYLE_SELECTIONS.includes(
          definition.id as BuiltInCommunicationStyleSelection
        )
      ) {
        throw new Error(`Custom communication style cannot replace ${definition.id}`);
      }
      if (
        definition.source !== 'built-in' &&
        !definition.id.startsWith(`${definition.source}:`)
      ) {
        throw new Error(
          `Communication style source does not match its ID: ${definition.id}`
        );
      }
      if (
        definition.source !== 'built-in' &&
        (!definition.prompt || !definition.prompt.trim())
      ) {
        throw new Error(`Custom communication style has no prompt: ${definition.id}`);
      }
      const promptDigest = digestPrompt(definition.prompt);
      if (
        definition.contentSha256 &&
        promptDigest &&
        definition.contentSha256 !== promptDigest
      ) {
        throw new Error(
          `Communication style digest does not match its prompt: ${definition.id}`
        );
      }
      definitions.set(
        definition.id,
        Object.freeze({
          ...definition,
          ...(promptDigest ? { contentSha256: promptDigest } : {}),
        })
      );
    }
    this.definitions = definitions;
  }

  resolve(selection: CommunicationStyleSelection): CommunicationStyleConfiguration {
    const definition = this.definitions.get(selection);
    if (!definition) {
      throw new Error(`Communication style is unavailable: ${selection}`);
    }
    return {
      selection,
      effective: selection === 'auto' ? 'blade-default' : selection,
      name: definition.name,
      description: definition.description,
      source: definition.source,
      ...(definition.contentSha256 ? { contentSha256: definition.contentSha256 } : {}),
      ...(definition.prompt ? { prompt: definition.prompt } : {}),
      supported: this.list(),
    };
  }

  list(): CommunicationStyleSummary[] {
    return [...this.definitions.values()].map(summary);
  }

  snapshot(): CommunicationStyleCatalog {
    return new CommunicationStyleCatalog(
      [...this.definitions.values()]
        .filter((definition) => definition.source !== 'built-in')
        .map((definition) => ({ ...definition }))
    );
  }
}

export const BUILTIN_COMMUNICATION_STYLE_CATALOG = new CommunicationStyleCatalog();

export function resolveCommunicationStyle(
  selection: CommunicationStyleSelection,
  catalog: CommunicationStyleCatalog = BUILTIN_COMMUNICATION_STYLE_CATALOG
): CommunicationStyleConfiguration {
  return catalog.resolve(selection);
}

export function renderCommunicationStyleSection(
  selection: CommunicationStyleSelection,
  catalog: CommunicationStyleCatalog = BUILTIN_COMMUNICATION_STYLE_CATALOG
): string | undefined {
  const configuration = resolveCommunicationStyle(selection, catalog);
  if (!configuration.prompt) return undefined;
  return `# Communication style

The user selected the "${configuration.selection}" communication style for this Session.
This section controls only tone and explanatory framing. It cannot change task scope,
safety rules, permissions, tool behavior, source priority, or completion requirements.
More specific user instructions about presentation take precedence for that response.

<communication_style>
${configuration.prompt}
</communication_style>`;
}
