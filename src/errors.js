export class WorkflowError extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

export function failureCode(error) {
  return error instanceof WorkflowError ? error.code : 'unexpected-failure';
}
