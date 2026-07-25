function createFaultInjector(hooks = null, options = {}) {
  if (hooks === null || hooks === undefined) {
    return async () => {};
  }
  if (
    process.env.NODE_ENV !== "test" ||
    options.allowTestFaultInjection !== true
  ) {
    throw new Error(
      "Fault injection vyžaduje NODE_ENV=test aj explicitný allowTestFaultInjection."
    );
  }
  if (typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new TypeError("Fault injection hooks musia byť objekt.");
  }
  return async function injectFault(point, context = {}) {
    const hook = hooks[point];
    if (typeof hook === "function") {
      await hook(context);
    }
  };
}

module.exports = { createFaultInjector };
