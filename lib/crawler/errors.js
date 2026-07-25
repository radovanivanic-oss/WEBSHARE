class CrawlerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || "crawler_error";
    this.cause = options.cause;
    this.retryable = options.retryable === true;
    this.blocked = options.blocked === true;
  }
}

class RecoveryRequiredError extends CrawlerError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || "recovery_required" });
  }
}

class CrawlerInvariantError extends RecoveryRequiredError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || "invariant_violation" });
  }
}

class LockActiveError extends CrawlerError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code || "lock_active" });
  }
}

module.exports = {
  CrawlerError,
  CrawlerInvariantError,
  LockActiveError,
  RecoveryRequiredError,
};
