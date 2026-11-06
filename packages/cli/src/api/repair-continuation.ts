import {
  type RepairContinuationPreviewQueryV1,
  type RepairContinuationRequestV1,
  repairContinuationInspectionV1Schema,
  repairContinuationOperationV1Schema,
  repairContinuationPreviewV1Schema,
} from '@autopod/shared';

function unconfirmed(): never {
  throw new Error(
    'Unsupported or uncorrelated repair-continuation response. No qualification, coding or completion inferred; observe the original request ID.',
  );
}

export function repairOperation(
  value: unknown,
  podId: string,
  id: string,
  request?: RepairContinuationRequestV1,
) {
  const parsed = repairContinuationOperationV1Schema.safeParse(value);
  if (!parsed.success) return unconfirmed();
  const operation = parsed.data;
  const input = operation.request;
  if (
    operation.podId !== podId ||
    input.id !== id ||
    operation.originalGeneration !== input.expectedGeneration ||
    (request && JSON.stringify(input) !== JSON.stringify(request))
  )
    return unconfirmed();
  const proof = operation.qualification;
  if (
    proof &&
    (proof.binding.operationId !== id ||
      proof.binding.podId !== podId ||
      proof.binding.originalGeneration !== input.expectedGeneration ||
      proof.binding.originalResultHash !== input.expectedResultHash ||
      proof.binding.reportSetHash !== input.expectedReportSetHash ||
      proof.binding.replacementLaunchDigest !== input.expectedExecutionDigest ||
      proof.binding.source.head !== input.sourceHead ||
      proof.binding.candidateGeneration !== operation.candidateGeneration)
  )
    return unconfirmed();
  const final = operation.codingFinalSource;
  if (
    final &&
    (final.operationId !== id ||
      final.selectedHead !== input.sourceHead ||
      final.generation !== operation.candidateGeneration)
  )
    return unconfirmed();
  if (
    (operation.codingAdmission === 'consumed' || operation.state === 'qualified') &&
    proof?.outcome !== 'qualified'
  )
    return unconfirmed();
  if (final && operation.codingAdmission !== 'consumed') return unconfirmed();
  if (
    ['coding', 'sealing', 'checking', 'validated'].includes(operation.state) &&
    operation.codingAdmission !== 'consumed'
  )
    return unconfirmed();
  if (operation.checks !== 'not_started' && operation.checks !== 'unknown' && !final)
    return unconfirmed();
  if (operation.state === 'validated' && (operation.checks !== 'passed' || !final))
    return unconfirmed();
  return operation;
}

export function repairInspection(value: unknown, podId: string) {
  const parsed = repairContinuationInspectionV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.podId !== podId) return unconfirmed();
  if (parsed.data.operation)
    repairOperation(parsed.data.operation, podId, parsed.data.operation.request.id);
  return parsed.data;
}

export function repairPreview(
  value: unknown,
  podId: string,
  query: RepairContinuationPreviewQueryV1,
) {
  const parsed = repairContinuationPreviewV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.podId !== podId) return unconfirmed();
  const selection = parsed.data.selection;
  if (
    selection &&
    (selection.sourceHead !== query.sourceHead ||
      selection.executionProfileId !== query.executionProfileId)
  )
    return unconfirmed();
  if (
    parsed.data.conditionalAttemptEligible &&
    (parsed.data.configurationDiff?.after.target !== 'local' ||
      !parsed.data.configurationDiff.after.platform.startsWith('linux/'))
  )
    return unconfirmed();
  return parsed.data;
}
