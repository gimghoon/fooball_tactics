export class EvidencePublicError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 503,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = new.target.name;
  }
}

export class EvidenceRequestValidationError extends EvidencePublicError {
  constructor(message = "근거 자료 요청이 올바르지 않습니다.") {
    super(400, message);
  }
}

export class EvidenceNotFoundError extends EvidencePublicError {
  constructor(message = "요청한 근거 자료를 찾을 수 없습니다.") {
    super(404, message);
  }
}

export class EvidenceConflictError extends EvidencePublicError {
  constructor(
    message = "근거 자료가 다른 변경으로 갱신되었습니다. 다시 시도해 주세요.",
  ) {
    super(409, message);
  }
}

export class EvidencePayloadTooLargeError extends EvidencePublicError {
  constructor(message = "업로드 요청이 허용된 크기를 초과했습니다.") {
    super(413, message);
  }
}

export class EvidenceUnsupportedMediaTypeError extends EvidencePublicError {
  constructor(message = "지원하지 않거나 올바르지 않은 파일 형식입니다.") {
    super(415, message);
  }
}

export class EvidenceUnavailableError extends EvidencePublicError {
  constructor(message = "근거 자료 서비스를 사용할 수 없습니다.") {
    super(503, message);
  }
}

export class EvidenceJobConfigurationConflictError extends EvidenceConflictError {
  constructor() {
    super("현재 분석 설정과 호환되지 않아 작업을 재시도할 수 없습니다.");
  }
}
