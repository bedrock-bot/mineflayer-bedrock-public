const testedVersions = ['1.8.8', '1.9.4', '1.10.2', '1.11.2', '1.12.2', '1.13.2', '1.14.4', '1.15.2', '1.16.5', '1.17.1', '1.18.2', '1.19', '1.19.2', '1.19.3', '1.19.4', '1.20.1', '1.20.2', '1.20.4', '1.20.6', '1.21.1', '1.21.3', '1.21.4', '1.21.5', '1.21.6', '1.21.8']
const bedrockTestedVersions = ['1.21.130']

module.exports = (isBedrock) => {
  if (isBedrock) {
    return {
      testedVersions: bedrockTestedVersions,
      latestSupportedVersion: bedrockTestedVersions[bedrockTestedVersions.length - 1],
      oldestSupportedVersion: bedrockTestedVersions[0]
    };
  } else {
    return {
      testedVersions: testedVersions,
      latestSupportedVersion: testedVersions[testedVersions.length - 1],
      oldestSupportedVersion: testedVersions[0]
    };
  }
};
