import type { CustomLogsMessages } from '../../i18n';
import { fillTemplate } from './format';
import type { FilterParseError } from './filterGrammar';
import type { ServerConditionError } from './guidedFilter';

export type FilterSubmitResult = { ok: true } | { ok: false; message: string; position: number };

const PARSE_MESSAGE = {
  expectedField: 'expectedField',
  expectedOperator: 'expectedOperator',
  expectedValue: 'expectedValue',
  unterminatedString: 'unterminatedString',
  unsupportedOr: 'unsupportedOr',
  expectedAnd: 'expectedAnd',
  expectedConditionAfterAnd: 'expectedConditionAfterAnd'
} as const;

export function describeParseError(t: CustomLogsMessages['errors'], error: FilterParseError): FilterSubmitResult & { ok: false } {
  return {
    ok: false,
    message: fillTemplate(t[PARSE_MESSAGE[error.code]], { token: error.token ?? '' }),
    position: error.position
  };
}

export function describeServerError(t: CustomLogsMessages['errors'], error: ServerConditionError): FilterSubmitResult & { ok: false } {
  switch (error.code) {
    case 'serverOperator':
      return {
        ok: false,
        message: fillTemplate(t.serverOperator, { field: error.field, allowed: error.allowed.join(' ') }),
        position: error.at
      };
    case 'serverUnsupported':
      return { ok: false, message: fillTemplate(t.serverUnsupported, { field: error.field }), position: error.at };
    case 'serverLevel':
    case 'serverSince':
    case 'serverSource':
      return { ok: false, message: t[error.code], position: error.at };
  }
}
