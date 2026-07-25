function buildChildPrefixes(parentPrefix, algorithm) {
  if (!algorithm.partitionCompletenessProven) {
    return {
      supported: false,
      reason: "unsupported_character_partition",
      prefixes: [],
    };
  }
  if (!Array.isArray(algorithm.partitionCharacters) || !algorithm.partitionCharacters.length) {
    return {
      supported: false,
      reason: "unsupported_character_partition",
      prefixes: [],
    };
  }
  return {
    supported: true,
    reason: null,
    prefixes: algorithm.partitionCharacters.map(
      (character) => `${parentPrefix}${character}`
    ),
  };
}

module.exports = { buildChildPrefixes };
