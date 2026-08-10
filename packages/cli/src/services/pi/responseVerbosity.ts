import type { Api, Model } from '@earendil-works/pi-ai';
import type { ResponseVerbositySelection } from '../../config/types.js';

export type { ResponseVerbositySelection };

export const RESPONSE_VERBOSITY_SELECTIONS = [
  'auto',
  'low',
  'medium',
  'high',
] as const satisfies readonly ResponseVerbositySelection[];

export type ResponseVerbosityEffective =
  | 'provider-default'
  | Exclude<ResponseVerbositySelection, 'auto'>;

export interface ResponseVerbosityConfiguration {
  selection: ResponseVerbositySelection;
  effective: ResponseVerbosityEffective;
  supported: Exclude<ResponseVerbositySelection, 'auto'>[];
  providerValue?: Exclude<ResponseVerbositySelection, 'auto'>;
}

const OPENAI_VERBOSITY_APIS = new Set<Api>([
  'openai-completions',
  'openai-responses',
  'openai-codex-responses',
  'azure-openai-responses',
]);

function isGpt5Model(model: Model<Api>): boolean {
  return /(?:^|[/.:_-])gpt-5(?:$|[/.:_-])/i.test(model.id);
}

export function isResponseVerbositySelection(
  value: unknown
): value is ResponseVerbositySelection {
  return (
    typeof value === 'string' &&
    RESPONSE_VERBOSITY_SELECTIONS.includes(value as ResponseVerbositySelection)
  );
}

export function getSupportedResponseVerbosities(
  model: Model<Api>
): Exclude<ResponseVerbositySelection, 'auto'>[] {
  if (
    model.api === 'openai-codex-responses' ||
    (OPENAI_VERBOSITY_APIS.has(model.api) && isGpt5Model(model))
  ) {
    return ['low', 'medium', 'high'];
  }
  return [];
}

export function resolveResponseVerbosity(
  model: Model<Api>,
  selection: ResponseVerbositySelection
): ResponseVerbosityConfiguration {
  const supported = getSupportedResponseVerbosities(model);
  if (selection !== 'auto' && !supported.includes(selection)) {
    throw new Error(
      `Response verbosity ${selection} is not supported by ${model.name}`
    );
  }
  if (selection === 'auto') {
    return { selection, effective: 'provider-default', supported };
  }
  return {
    selection,
    effective: selection,
    supported,
    providerValue: selection,
  };
}
