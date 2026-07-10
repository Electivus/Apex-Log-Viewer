import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeLogText } from '../src/logTriage.ts';

type PositiveCase = {
  codes: string[];
  logText: string;
  name: string;
  primaryReason: string;
};

const positiveCases: PositiveCase[] = [
  {
    name: 'reports validation failure and rollback in priority order',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|error|"Error [statusCode=FIELD_CUSTOM_VALIDATION_EXCEPTION, code=null, message=Could not save..., fields=[Name]]"|0x3722c840\n' +
      '17:11:52.525 (530873859)|ROLLBACK|[111]|Savepoint restored',
    primaryReason: 'Validation failure',
    codes: ['validation_failure', 'rollback_detected']
  },
  {
    name: 'reports a fatal exception for uncategorized fatal errors',
    logText:
      '17:11:53.0 (1600140461)|EXCEPTION_THROWN|[834]|System.IllegalArgumentException: DeveloperName is required',
    primaryReason: 'Fatal exception',
    codes: ['fatal_exception']
  },
  {
    name: 'does not classify validation literals inside unrelated exception text',
    logText:
      '17:11:53.0 (1600140461)|EXCEPTION_THROWN|[834]|System.IllegalArgumentException: FIELD_CUSTOM_VALIDATION_EXCEPTION used as a literal',
    primaryReason: 'Fatal exception',
    codes: ['fatal_exception']
  },
  {
    name: 'does not classify dml literals inside unrelated fatal exception text',
    logText:
      '17:11:53.0 (1600140461)|FATAL_ERROR|System.IllegalArgumentException: REQUIRED_FIELD_MISSING used as a label',
    primaryReason: 'Fatal exception',
    codes: ['fatal_exception']
  },
  {
    name: 'reports fatal exceptions when timestamps omit duration',
    logText: '17:11:53.0|EXCEPTION_THROWN|[834]|System.IllegalArgumentException: DeveloperName is required',
    primaryReason: 'Fatal exception',
    codes: ['fatal_exception']
  },
  {
    name: 'treats bare fatal error events as fatal diagnostics',
    logText: '17:11:53.0|FATAL_ERROR|Internal Salesforce.com Error',
    primaryReason: 'Fatal exception',
    codes: ['fatal_exception']
  },
  {
    name: 'prefers assertion failures over a generic fatal exception',
    logText: '17:11:53.0 (1600140462)|FATAL_ERROR|System.AssertException: Assertion Failed',
    primaryReason: 'Assertion failure',
    codes: ['assertion_failure']
  },
  {
    name: 'does not classify assertion literals inside unrelated exception text',
    logText:
      '17:11:53.0 (1600140462)|EXCEPTION_THROWN|[834]|System.IllegalArgumentException: Assertion Failed used as a literal',
    primaryReason: 'Fatal exception',
    codes: ['fatal_exception']
  },
  {
    name: 'reports dml failures from exception payloads',
    logText:
      '17:11:52.320 (372616767)|EXCEPTION_THROWN|[131]|System.DmlException: Insert failed. First exception on row 0; first error: REQUIRED_FIELD_MISSING, Required fields are missing: [Name]: [Name]',
    primaryReason: 'DML failure',
    codes: ['dml_failure']
  },
  {
    name: 'reports suspicious serialized error payloads',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|error|"Error [statusCode=UNKNOWN_EXCEPTION, code=null, message=Queueable job failed unexpectedly, fields=[]]"|0x3722c840',
    primaryReason: 'Suspicious error payload',
    codes: ['suspicious_error_payload']
  },
  {
    name: 'classifies exception payloads stored in variables as fatal diagnostics',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|err|"System.NullPointerException: Attempt to de-reference a null object"|0x3722c840',
    primaryReason: 'Fatal exception',
    codes: ['fatal_exception']
  },
  {
    name: 'classifies locationless variable assignment exception payloads',
    logText:
      '17:11:52.319|VARIABLE_ASSIGNMENT|err|"System.NullPointerException: Attempt to de-reference a null object"|0x1',
    primaryReason: 'Fatal exception',
    codes: ['fatal_exception']
  },
  {
    name: 'classifies bare exception type names stored in variables',
    logText: '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|typeName|"System.NullPointerException"|0x3722c840',
    primaryReason: 'Fatal exception',
    codes: ['fatal_exception']
  },
  {
    name: 'classifies assert exceptions stored in variables as assertion failures',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|err|"System.AssertException: Assertion Failed"|0x3722c840',
    primaryReason: 'Assertion failure',
    codes: ['assertion_failure']
  },
  {
    name: 'classifies dml exception payloads stored in variables with specific reasons',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|err|"System.DmlException: Insert failed. First exception on row 0; first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, Could not save..., fields=[Name]"|0x3722c840',
    primaryReason: 'Validation failure',
    codes: ['validation_failure', 'dml_failure']
  },
  {
    name: 'classifies plain validation messages stored in variables',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|msg|"FIELD_CUSTOM_VALIDATION_EXCEPTION, Could not save record"|0x3722c840',
    primaryReason: 'Validation failure',
    codes: ['validation_failure']
  },
  {
    name: 'classifies bare validation status codes stored in variables',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|statusCode|"FIELD_CUSTOM_VALIDATION_EXCEPTION"|0x3722c840',
    primaryReason: 'Validation failure',
    codes: ['validation_failure']
  },
  {
    name: 'classifies plain dml messages stored in variables',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|msg|"Insert failed. First exception on row 0; first error: REQUIRED_FIELD_MISSING, Required fields are missing: [Name]"|0x3722c840',
    primaryReason: 'DML failure',
    codes: ['dml_failure']
  },
  {
    name: 'classifies dml status-code payloads stored in variables',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|saveError|"REQUIRED_FIELD_MISSING, Required fields are missing: [Name]"|0x3722c840',
    primaryReason: 'DML failure',
    codes: ['dml_failure']
  },
  {
    name: 'classifies additional dml status-code payloads stored in variables',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|saveError|"DUPLICATE_VALUE, duplicate value found: Name duplicates value on record with id: 001xx"|0x3722c840',
    primaryReason: 'DML failure',
    codes: ['dml_failure']
  },
  {
    name: 'classifies plain assertion messages stored in variables',
    logText: '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|msg|"Assertion Failed: expected 1, got 2"|0x3722c840',
    primaryReason: 'Assertion failure',
    codes: ['assertion_failure']
  },
  {
    name: 'classifies bare assertion messages stored in variables',
    logText: '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|msg|"Assertion Failed"|0x3722c840',
    primaryReason: 'Assertion failure',
    codes: ['assertion_failure']
  },
  {
    name: 'treats no-detail fatal log entries as fatal diagnostics',
    logText: '17:11:53.0|FATAL_ERROR',
    primaryReason: 'Fatal exception',
    codes: ['fatal_exception']
  },
  {
    name: 'treats no-detail exception-thrown entries as fatal diagnostics',
    logText: '17:11:53.0|EXCEPTION_THROWN|[834]',
    primaryReason: 'Fatal exception',
    codes: ['fatal_exception']
  },
  {
    name: 'keeps validation and dml reasons when both appear on one line',
    logText:
      '17:11:52.320 (372616767)|EXCEPTION_THROWN|[131]|System.DmlException: Insert failed. First exception on row 0; first error: FIELD_CUSTOM_VALIDATION_EXCEPTION, Could not save..., fields=[Name]',
    primaryReason: 'Validation failure',
    codes: ['validation_failure', 'dml_failure']
  },
  {
    name: 'classifies AssertException from EXCEPTION_THROWN as assertion failures',
    logText: '17:11:53.0 (1600140462)|EXCEPTION_THROWN|[834]|System.AssertException: Assertion Failed',
    primaryReason: 'Assertion failure',
    codes: ['assertion_failure']
  },
  {
    name: 'treats rollback-only logs as triage hits',
    logText: '17:11:52.525 (530873859)|ROLLBACK|[111]|Savepoint restored',
    primaryReason: 'Rollback detected',
    codes: ['rollback_detected']
  },
  {
    name: 'preserves event context for multiline variable assignments',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|error|payloadStart\n' +
      'Error [statusCode=UNKNOWN_EXCEPTION, code=null, message=Queueable job failed unexpectedly, fields=[]]',
    primaryReason: 'Suspicious error payload',
    codes: ['suspicious_error_payload']
  }
];

for (const fixture of positiveCases) {
  test(fixture.name, () => {
    const summary = summarizeLogText(fixture.logText);
    assert.equal(summary.hasErrors, true);
    assert.equal(summary.primaryReason, fixture.primaryReason);
    assert.deepEqual(
      summary.reasons.map(reason => reason.code),
      fixture.codes
    );
  });
}

const negativeCases: Array<{ name: string; logText: string }> = [
  {
    name: 'does not classify assertion labels stored in variables',
    logText: '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|msg|"This label says Assertion Failed"|0x3722c840'
  },
  {
    name: 'does not classify exception labels stored in variables as fatal diagnostics',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|label|"System.NullPointerException used as a label"|0x3722c840'
  },
  {
    name: 'does not classify successful status payloads as errors',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|response|"HttpResponse [statusCode=200, message=OK]"|0x3722c840'
  },
  {
    name: 'does not classify serialized success payloads as suspicious errors',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|response|"ApiResponse [statusCode=SUCCESS, message=Done]"|0x3722c840'
  },
  {
    name: 'does not classify serialized no-error messages as suspicious errors',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|response|"ApiResponse [statusCode=SUCCESS, message=No error]"|0x3722c840'
  },
  {
    name: 'does not classify benign NO_ERROR status codes as suspicious errors',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|response|"ApiResponse [statusCode=NO_ERROR, message=Done]"|0x3722c840'
  },
  {
    name: 'does not classify rollback literals in user debug lines as rollbacks',
    logText:
      '17:11:52.525 (530873859)|USER_DEBUG|[111]|DEBUG|Database.rollback(sp) mentions ROLLBACK as a string literal'
  },
  {
    name: 'ignores execute anonymous source lines outside structured log events',
    logText: "Execute Anonymous:\nSystem.debug('FIELD_CUSTOM_VALIDATION_EXCEPTION');"
  },
  {
    name: 'does not classify user debug literals as validation failures',
    logText: '17:11:53.0 (1600140462)|USER_DEBUG|[5]|DEBUG|FIELD_CUSTOM_VALIDATION_EXCEPTION used as a literal'
  },
  {
    name: 'does not classify benign variable assignment labels as validation failures',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|msg|"FIELD_CUSTOM_VALIDATION_EXCEPTION used as a label"|0x3722c840'
  },
  {
    name: 'does not classify user debug literals as dml failures',
    logText:
      '17:11:53.0 (1600140462)|USER_DEBUG|[5]|DEBUG|Insert failed is just a string literal with REQUIRED_FIELD_MISSING'
  },
  {
    name: 'does not classify benign variable assignment labels as dml failures',
    logText:
      '17:11:52.319 (372616766)|VARIABLE_ASSIGNMENT|[131]|msg|"Insert failed is just a label with REQUIRED_FIELD_MISSING"|0x3722c840'
  },
  {
    name: 'returns no reasons for non-error log lines',
    logText:
      '17:11:52.1 (6438204)|METHOD_ENTRY|[31]||System.OrgLimits.getMap()\n' +
      '17:11:52.1 (96974034)|METHOD_EXIT|[31]||System.OrgLimits.getMap()'
  }
];

for (const fixture of negativeCases) {
  test(fixture.name, () => {
    const summary = summarizeLogText(fixture.logText);
    assert.equal(summary.hasErrors, false);
    assert.equal(summary.primaryReason, undefined);
    assert.deepEqual(summary.reasons, []);
  });
}

test('keeps Apex source locations and event types in diagnostics', () => {
  const summary = summarizeLogText(
    '17:11:53.0 (1600140461)|EXCEPTION_THROWN|[834]|System.IllegalArgumentException: DeveloperName is required'
  );

  assert.equal(summary.reasons[0]?.line, 834);
  assert.equal(summary.reasons[0]?.eventType, 'EXCEPTION_THROWN');
});

test('accepts whitespace around event delimiters', () => {
  const summary = summarizeLogText('12:00:00.000 | EXCEPTION_THROWN | [6] | boom');

  assert.equal(summary.hasErrors, true);
  assert.equal(summary.primaryReason, 'Fatal exception');
  assert.equal(summary.reasons[0]?.code, 'fatal_exception');
});
