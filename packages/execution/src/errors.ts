import type { ProviderError } from "@dvw/core";
import { redactSensitiveText } from "@dvw/security";

export interface ExecutionFailure {
  readonly code:
    | "AFTER_STATE_MISMATCH"
    | "DESTINATION_CHANGED"
    | "ITEM_MISSING"
    | "PROVIDER_ERROR"
    | "SOURCE_CHANGED"
    | "UNEXPECTED_PROVIDER_RESULT";
  readonly itemId: string | null;
  readonly message: string;
  readonly providerError: ProviderError | null;
}

export function providerExecutionFailure(
  error: ProviderError,
): ExecutionFailure {
  const providerError: ProviderError = {
    code: error.code,
    itemId: error.itemId,
    message: redactSensitiveText(error.message),
    retryable: error.retryable,
  };
  return {
    code: "PROVIDER_ERROR",
    itemId: error.itemId,
    message: providerErrorMessage(providerError),
    providerError,
  };
}

export function providerErrorMessage(error: ProviderError): string {
  return `Provider ${error.code}: ${redactSensitiveText(error.message)}`;
}

export function executionFailure(
  code: Exclude<ExecutionFailure["code"], "PROVIDER_ERROR">,
  itemId: string | null,
  message: string,
): ExecutionFailure {
  return { code, itemId, message, providerError: null };
}
