/* globals artifacts */

import BN from "bn.js";
import chai from "chai";
import bnChai from "bn-chai";
import { ethers } from "ethers";

import { WAD } from "../../helpers/constants";
import { checkErrorRevert, forwardTime, web3GetBalance } from "../../helpers/test-helper";
import { setupColonyNetwork, setupRandomToken, setupRandomColony, setupColony } from "../../helpers/test-data-generator";

const { expect } = chai;
chai.use(bnChai(web3.utils.BN));

const Token = artifacts.require("Token");
const CoinMachine = artifacts.require("CoinMachine");
const CoinMachineFactory = artifacts.require("CoinMachineFactory");

contract("Coin Machine", (accounts) => {
  let colony;
  let token;
  let purchaseToken;

  let colonyNetwork;

  let coinMachine;
  let coinMachineFactory;

  const USER0 = accounts[0];
  const USER1 = accounts[1];

  before(async () => {
    colonyNetwork = await setupColonyNetwork();
    coinMachineFactory = await CoinMachineFactory.new();
  });

  beforeEach(async () => {
    ({ colony, token } = await setupRandomColony(colonyNetwork));
    purchaseToken = await setupRandomToken();

    await coinMachineFactory.deployExtension(colony.address);
    const coinMachineAddress = await coinMachineFactory.deployedExtensions(colony.address);
    coinMachine = await CoinMachine.at(coinMachineAddress);
    await colony.setRootRole(coinMachineAddress, true);
  });

  describe("using the extension factory", async () => {
    it("can install the extension factory once if root and uninstall", async () => {
      ({ colony } = await setupRandomColony(colonyNetwork));
      await checkErrorRevert(coinMachineFactory.deployExtension(colony.address, { from: USER1 }), "colony-extension-user-not-root");
      await coinMachineFactory.deployExtension(colony.address, { from: USER0 });
      await checkErrorRevert(coinMachineFactory.deployExtension(colony.address, { from: USER0 }), "colony-extension-already-deployed");
      await coinMachineFactory.removeExtension(colony.address, { from: USER0 });
    });

    it("can initialise", async () => {
      await coinMachine.initialise(purchaseToken.address, 60, 256, 10, 10, 0);
    });

    it("can handle a large windowSize", async () => {
      await coinMachine.initialise(purchaseToken.address, 60, 256, 10, 10, 0);

      // Advance an entire window
      await forwardTime(60 * 256 + 1, this);

      await coinMachine.updatePeriod();
    });

    it("cannot initialise with bad arguments", async () => {
      await checkErrorRevert(coinMachine.initialise(purchaseToken.address, 0, 256, 10, 10, 0), "coin-machine-period-too-small");
      await checkErrorRevert(coinMachine.initialise(purchaseToken.address, 60, 0, 10, 10, 0), "coin-machine-window-too-small");
      await checkErrorRevert(coinMachine.initialise(purchaseToken.address, 60, 257, 10, 10, 0), "coin-machine-window-too-large");
      await checkErrorRevert(coinMachine.initialise(purchaseToken.address, 60, 256, 0, 10, 0), "coin-machine-target-too-small");
      await checkErrorRevert(coinMachine.initialise(purchaseToken.address, 60, 256, 10, 9, 0), "coin-machine-max-too-small");
    });

    it("cannot initialise twice", async () => {
      await coinMachine.initialise(purchaseToken.address, 60, 256, 10, 10, 0);
      await checkErrorRevert(coinMachine.initialise(purchaseToken.address, 60, 256, 10, 10, 0), "coin-machine-already-initialised");
    });
  });

  describe("buying tokens", async () => {
    beforeEach(async () => {
      await coinMachine.initialise(
        purchaseToken.address, // purchase token
        60 * 60, // period length
        10, // number of periods for averaging
        WAD.muln(100), // tokens per period
        WAD.muln(200), // max per period
        WAD // starting price
      );
    });

    it("can buy tokens", async () => {
      await purchaseToken.mint(USER0, WAD, { from: USER0 });
      await purchaseToken.approve(coinMachine.address, WAD, { from: USER0 });

      await coinMachine.buyTokens(WAD, { from: USER0 });

      const balance = await token.balanceOf(USER0);
      expect(balance).to.eq.BN(WAD);

      // But not with insufficient funds
      await purchaseToken.approve(coinMachine.address, WAD, { from: USER0 });
      await checkErrorRevert(coinMachine.buyTokens(WAD, { from: USER0 }), "ds-token-insufficient-balance");
    });

    it("can buy tokens with eth", async () => {
      await coinMachineFactory.removeExtension(colony.address, { from: USER0 });
      await coinMachineFactory.deployExtension(colony.address, { from: USER0 });
      const coinMachineAddress = await coinMachineFactory.deployedExtensions(colony.address);
      coinMachine = await CoinMachine.at(coinMachineAddress);
      await colony.setRootRole(coinMachineAddress, true);

      await coinMachine.initialise(ethers.constants.AddressZero, 60 * 60, 10, WAD.muln(100), WAD.muln(200), WAD);
      const currentPrice = await coinMachine.getCurrentPrice();

      // Check purchase functionality
      await coinMachine.buyTokens(WAD, { from: USER0, value: currentPrice });

      const balance = await token.balanceOf(USER0);
      expect(balance).to.eq.BN(WAD);

      // But not with insufficient funds
      await checkErrorRevert(coinMachine.buyTokens(WAD, { from: USER0, value: currentPrice.subn(1) }), "coin-machine-insufficient-funds");

      // Check refund functionality
      const balanceBefore = await web3GetBalance(coinMachine.address);
      await coinMachine.buyTokens(WAD, { from: USER0, value: currentPrice.muln(2) });
      const balanceAfter = await web3GetBalance(coinMachine.address);
      expect(new BN((balanceAfter - balanceBefore).toString())).to.eq.BN(currentPrice);
    });

    it("can buy up to the maximum amount of tokens per period", async () => {
      const maxPerPeriod = await coinMachine.getMaxPerPeriod();
      const tokensToBuy = maxPerPeriod.add(WAD);

      await purchaseToken.mint(USER0, tokensToBuy, { from: USER0 });
      await purchaseToken.approve(coinMachine.address, tokensToBuy, { from: USER0 });

      await coinMachine.buyTokens(tokensToBuy, { from: USER0 });

      const balance = await token.balanceOf(USER0);
      expect(balance).to.eq.BN(maxPerPeriod);
    });

    it("can buy tokens over multiple periods", async () => {
      const windowSize = await coinMachine.getWindowSize();
      const periodLength = await coinMachine.getPeriodLength();
      const targetPerPeriod = await coinMachine.getTargetPerPeriod();
      const currentPrice = await coinMachine.getCurrentPrice();

      const numPurchases = windowSize.addn(1).toNumber();
      const totalCost = targetPerPeriod.mul(currentPrice).muln(numPurchases);

      await purchaseToken.mint(USER0, totalCost, { from: USER0 });
      await purchaseToken.approve(coinMachine.address, totalCost, { from: USER0 });

      for (let i = 0; i < numPurchases; i += 1) {
        await coinMachine.buyTokens(targetPerPeriod, { from: USER0 });
        await forwardTime(periodLength.toNumber(), this);
      }

      const balance = await token.balanceOf(USER0);
      expect(balance).to.eq.BN(targetPerPeriod.muln(numPurchases));
    });

    it("can adjust prices according to demand", async () => {
      const periodLength = await coinMachine.getPeriodLength();
      const maxPerPeriod = await coinMachine.getMaxPerPeriod();

      let currentPrice;

      await purchaseToken.mint(USER0, maxPerPeriod.muln(10), { from: USER0 });
      await purchaseToken.approve(coinMachine.address, maxPerPeriod.muln(10), { from: USER0 });

      currentPrice = await coinMachine.getCurrentPrice();
      expect(currentPrice).to.eq.BN(WAD);

      await coinMachine.buyTokens(maxPerPeriod, { from: USER0 });
      await forwardTime(periodLength.toNumber(), this);
      await coinMachine.updatePeriod();

      // Expect price to increase by 10% since we sold 200% in 1/10 of the periods
      // No deficit though since we include the unsold tokens in this period
      currentPrice = await coinMachine.getCurrentPrice();
      expect(currentPrice).to.eq.BN(WAD.divn(10).muln(11));

      await forwardTime(periodLength.toNumber(), this);
      await coinMachine.updatePeriod();

      // Expect price to return to baseline since we sold no tokens
      currentPrice = await coinMachine.getCurrentPrice();
      expect(currentPrice).to.eq.BN(WAD);

      await forwardTime(periodLength.toNumber(), this);
      await coinMachine.updatePeriod();

      // Expect price to decrease by 10% to baseline since we sold 0% in 1/10 periods
      currentPrice = await coinMachine.getCurrentPrice();
      expect(currentPrice).to.eq.BN(WAD.divn(10).muln(9));
    });

    it("can handle long periods of inactivity", async () => {
      const windowSize = await coinMachine.getWindowSize();
      const periodLength = await coinMachine.getPeriodLength();

      let currentPrice = await coinMachine.getCurrentPrice();
      expect(currentPrice).to.eq.BN(WAD);

      await forwardTime(periodLength.mul(windowSize).muln(1000).toNumber(), this);

      // Check virtual price
      currentPrice = await coinMachine.getCurrentPrice();
      expect(currentPrice).to.be.zero;

      await coinMachine.updatePeriod();

      // Check actual price
      currentPrice = await coinMachine.getCurrentPrice();
      expect(currentPrice).to.be.zero;
    });

    it("can virtually update counters", async () => {
      const periodLength = await coinMachine.getPeriodLength();
      const targetPerPeriod = await coinMachine.getTargetPerPeriod();
      const maxPerPeriod = await coinMachine.getMaxPerPeriod();

      let currentPrice = await coinMachine.getCurrentPrice();
      let numAvailable = await coinMachine.getNumAvailable();

      expect(currentPrice).to.eq.BN(WAD);
      expect(numAvailable).to.eq.BN(maxPerPeriod);

      await purchaseToken.mint(USER0, maxPerPeriod.muln(2), { from: USER0 });
      await purchaseToken.approve(coinMachine.address, maxPerPeriod.muln(2), { from: USER0 });

      // Buy tokens during a period, watch counters adapt
      await coinMachine.buyTokens(targetPerPeriod.divn(2), { from: USER0 });

      currentPrice = await coinMachine.getCurrentPrice();
      numAvailable = await coinMachine.getNumAvailable();

      expect(currentPrice).to.eq.BN(WAD);
      expect(numAvailable).to.eq.BN(maxPerPeriod.sub(targetPerPeriod.divn(2)));

      await coinMachine.buyTokens(targetPerPeriod.divn(2), { from: USER0 });

      currentPrice = await coinMachine.getCurrentPrice();
      numAvailable = await coinMachine.getNumAvailable();

      expect(currentPrice).to.eq.BN(WAD);
      expect(numAvailable).to.eq.BN(maxPerPeriod.sub(targetPerPeriod));

      await coinMachine.buyTokens(targetPerPeriod, { from: USER0 });

      currentPrice = await coinMachine.getCurrentPrice();
      numAvailable = await coinMachine.getNumAvailable();

      expect(currentPrice).to.eq.BN(WAD);
      expect(numAvailable).to.be.zero;

      // Advance to next period without calling `updatePeriod`
      await forwardTime(periodLength.toNumber(), this);

      currentPrice = await coinMachine.getCurrentPrice();
      numAvailable = await coinMachine.getNumAvailable();

      // Bought maxPerPeriod tokens so price should be up 10%
      expect(currentPrice).to.eq.BN(WAD.divn(10).muln(11));
      expect(numAvailable).to.eq.BN(maxPerPeriod);

      // Advance to next period without calling `updatePeriod`
      // Now we are two periods advanced from `currentPeriod`
      await forwardTime(periodLength.toNumber(), this);

      currentPrice = await coinMachine.getCurrentPrice();
      numAvailable = await coinMachine.getNumAvailable();

      expect(currentPrice).to.eq.BN(WAD);
      expect(numAvailable).to.eq.BN(maxPerPeriod);

      // Now buy some tokens
      await coinMachine.buyTokens(maxPerPeriod, { from: USER0 });

      currentPrice = await coinMachine.getCurrentPrice();
      numAvailable = await coinMachine.getNumAvailable();

      expect(currentPrice).to.eq.BN(WAD);
      expect(numAvailable).to.be.zero;
    });

    it("can handle sales tokens with different decimals", async () => {
      token = await Token.new("Test Token", "TEST", 9);
      colony = await setupColony(colonyNetwork, token.address);
      await token.unlock();
      await token.setOwner(colony.address);

      await coinMachineFactory.deployExtension(colony.address);
      const coinMachineAddress = await coinMachineFactory.deployedExtensions(colony.address);
      coinMachine = await CoinMachine.at(coinMachineAddress);
      await colony.setRootRole(coinMachineAddress, true);
      await coinMachine.initialise(purchaseToken.address, 60 * 60, 10, WAD.muln(100), WAD.muln(200), WAD);

      await purchaseToken.mint(USER0, WAD, { from: USER0 });
      await purchaseToken.approve(coinMachine.address, WAD, { from: USER0 });

      await coinMachine.buyTokens(WAD, { from: USER0 });

      const balance = await token.balanceOf(USER0);
      expect(balance).to.eq.BN(WAD);
    });

    it("can handle purchase tokens with different decimals", async () => {
      purchaseToken = await Token.new("Test Token", "TEST", 9);
      await purchaseToken.unlock();

      await coinMachineFactory.removeExtension(colony.address);
      await coinMachineFactory.deployExtension(colony.address);
      const coinMachineAddress = await coinMachineFactory.deployedExtensions(colony.address);
      coinMachine = await CoinMachine.at(coinMachineAddress);
      await colony.setRootRole(coinMachineAddress, true);
      await coinMachine.initialise(purchaseToken.address, 60 * 60, 10, WAD.muln(100), WAD.muln(200), WAD);

      await purchaseToken.mint(USER0, WAD, { from: USER0 });
      await purchaseToken.approve(coinMachine.address, WAD, { from: USER0 });

      await coinMachine.buyTokens(WAD, { from: USER0 });

      const balance = await token.balanceOf(USER0);
      expect(balance).to.eq.BN(WAD);
    });
  });
});