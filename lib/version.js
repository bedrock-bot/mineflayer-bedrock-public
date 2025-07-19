const testedVersions = ['1.8.8', '1.9.4', '1.10.2', '1.11.2', '1.12.2', '1.13.2', '1.14.4', '1.15.2', '1.16.5', '1.17.1', '1.18.2', '1.19', '1.19.2', '1.19.3', '1.19.4', '1.20.1', '1.20.2', '1.20.4', '1.20.6', '1.21.1', '1.21.3', '1.21.4', '1.21.5']
const bedrockTestedVersions = ['1.17.10','1.18.30', '1.19.1', '1.19.30', '1.19.63', '1.19.70', '1.19.80', '1.20.40', '1.20.61', '1.20.71', '1.21.0', '1.21.42', '1.21.60', '1.21.70', '1.21.80', '1.21.90', '1.21.93', '1.21.100']

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
