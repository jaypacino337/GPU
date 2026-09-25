/** Local EVM used only by the end-to-end simulator test. No contracts are compiled. */
module.exports = {
  networks: {
    hardhat: {
      chainId: 31337,
      // Deterministic accounts so the e2e test can assert exact balances.
      accounts: { mnemonic: "test test test test test test test test test test test junk" },
      mining: { auto: true },
    },
  },
};
