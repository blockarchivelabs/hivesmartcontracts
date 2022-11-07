/* eslint-disable */
const assert = require("assert");
const { MongoClient } = require("mongodb");

const { CONSTANTS } = require("../libs/Constants");
const { Database } = require("../libs/Database");
const blockchain = require("../plugins/Blockchain");
const { Transaction } = require("../libs/Transaction");
const { setupContractPayload } = require("../libs/util/contractUtil");
const { Fixture, conf } = require("../libs/util/testing/Fixture");
const { TableAsserts } = require("../libs/util/testing/TableAsserts");
const { assertError } = require("../libs/util/testing/Asserts");

const tknContractPayload = setupContractPayload(
  "tokens",
  "./contracts/tokens.js"
);
const pegContractPayload = setupContractPayload(
  "steempegged",
  "./contracts/steempegged.js"
);

const fixture = new Fixture();
const tableAsserts = new TableAsserts(fixture);

describe("Hive Pegged", function () {
  this.timeout(10000);

  before((done) => {
    new Promise(async (resolve) => {
      client = await MongoClient.connect(conf.databaseURL, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      });
      db = await client.db(conf.databaseName);
      await db.dropDatabase();
      resolve();
    }).then(() => {
      done();
    });
  });

  after((done) => {
    new Promise(async (resolve) => {
      await client.close();
      resolve();
    }).then(() => {
      done();
    });
  });

  beforeEach((done) => {
    new Promise(async (resolve) => {
      db = await client.db(conf.databaseName);
      resolve();
    }).then(() => {
      done();
    });
  });

  afterEach((done) => {
    // runs after each test in this block
    new Promise(async (resolve) => {
      await db.dropDatabase();
      resolve();
    }).then(() => {
      done();
    });
  });

  it(`buys ${CONSTANTS.STEEM_PEGGED_SYMBOL}`, (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          CONSTANTS.STEEM_ENGINE_ACCOUNT,
          "contract",
          "update",
          JSON.stringify(tknContractPayload)
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          CONSTANTS.STEEM_PEGGED_ACCOUNT,
          "contract",
          "update",
          JSON.stringify(pegContractPayload)
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          "harpagon",
          "steempegged",
          "buy",
          `{ "recipient": "${CONSTANTS.STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "0.002 HIVE", "isSignedWithActiveKey": true }`
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          "satoshi",
          "steempegged",
          "buy",
          `{ "recipient": "${CONSTANTS.STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "0.879 HIVE", "isSignedWithActiveKey": true }`
        )
      );

      let block = {
        refSteemBlockNumber: refBlockNumber,
        refSteemBlockId: "ABCD1",
        prevRefSteemBlockId: "ABCD2",
        timestamp: "2018-06-01T00:00:00",
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
        contract: "tokens",
        table: "balances",
        query: {
          symbol: CONSTANTS.STEEM_PEGGED_SYMBOL,
          account: {
            $in: ["harpagon", "satoshi"],
          },
        },
      });

      let balances = res;
      assert.equal(balances[0].balance, 0.001);
      assert.equal(balances[0].account, "harpagon");
      assert.equal(balances[0].symbol, CONSTANTS.STEEM_PEGGED_SYMBOL);

      assert.equal(balances[1].balance, 0.872);
      assert.equal(balances[1].account, "satoshi");
      assert.equal(balances[1].symbol, CONSTANTS.STEEM_PEGGED_SYMBOL);

      resolve();
    }).then(() => {
      fixture.tearDown();
      done();
    });
  });

  it("withdraws HIVE", (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          CONSTANTS.STEEM_ENGINE_ACCOUNT,
          "contract",
          "update",
          JSON.stringify(tknContractPayload)
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          CONSTANTS.STEEM_PEGGED_ACCOUNT,
          "contract",
          "update",
          JSON.stringify(pegContractPayload)
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          "harpagon",
          "steempegged",
          "buy",
          `{ "recipient": "${CONSTANTS.STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "0.003 HIVE", "isSignedWithActiveKey": true }`
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          "satoshi",
          "steempegged",
          "buy",
          `{ "recipient": "${CONSTANTS.STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "0.879 HIVE", "isSignedWithActiveKey": true }`
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          "harpagon",
          "steempegged",
          "withdraw",
          '{ "quantity": "0.002", "isSignedWithActiveKey": true }'
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          "satoshi",
          "steempegged",
          "withdraw",
          '{ "quantity": "0.3", "isSignedWithActiveKey": true }'
        )
      );

      let block = {
        refSteemBlockNumber: refBlockNumber,
        refSteemBlockId: "ABCD1",
        prevRefSteemBlockId: "ABCD2",
        timestamp: "2018-06-01T00:00:00",
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.find({
        contract: "tokens",
        table: "balances",
        query: {
          symbol: CONSTANTS.STEEM_PEGGED_SYMBOL,
          account: {
            $in: ["harpagon", "satoshi"],
          },
        },
      });

      let balances = res;

      assert.equal(balances[0].balance, 0);
      assert.equal(balances[0].account, "harpagon");
      assert.equal(balances[0].symbol, CONSTANTS.STEEM_PEGGED_SYMBOL);

      assert.equal(balances[1].balance, 0.572);
      assert.equal(balances[1].account, "satoshi");
      assert.equal(balances[1].symbol, CONSTANTS.STEEM_PEGGED_SYMBOL);

      res = await fixture.database.find({
        contract: "steempegged",
        table: "withdrawals",
        query: {},
      });

      let withdrawals = res;

      assert.equal(withdrawals[0].id, "TXID00000004-fee");
      assert.equal(withdrawals[0].type, "STEEM);
      assert.equal(withdrawals[0].recipient, CONSTANTS.STEEM_ENGINE_ACCOUNT);
      assert.equal(withdrawals[0].memo, "fee tx TXID00000004");
      assert.equal(withdrawals[0].quantity, 0.001);

      assert.equal(withdrawals[1].id, "TXID00000005-fee");
      assert.equal(withdrawals[1].type, "STEEM);
      assert.equal(withdrawals[1].recipient, CONSTANTS.STEEM_ENGINE_ACCOUNT);
      assert.equal(withdrawals[1].memo, "fee tx TXID00000005");
      assert.equal(withdrawals[1].quantity, 0.007);

      assert.equal(withdrawals[2].id, "TXID00000006");
      assert.equal(withdrawals[2].type, "STEEM);
      assert.equal(withdrawals[2].recipient, "harpagon");
      assert.equal(withdrawals[2].memo, "withdrawal tx TXID00000006");
      assert.equal(withdrawals[2].quantity, 0.001);

      assert.equal(withdrawals[3].id, "TXID00000006-fee");
      assert.equal(withdrawals[3].type, "STEEM);
      assert.equal(withdrawals[3].recipient, CONSTANTS.STEEM_ENGINE_ACCOUNT);
      assert.equal(withdrawals[3].memo, "fee tx TXID00000006");
      assert.equal(withdrawals[3].quantity, 0.001);

      assert.equal(withdrawals[4].id, "TXID00000007");
      assert.equal(withdrawals[4].type, "STEEM);
      assert.equal(withdrawals[4].recipient, "satoshi");
      assert.equal(withdrawals[4].memo, "withdrawal tx TXID00000007");
      assert.equal(withdrawals[4].quantity, 0.298);

      assert.equal(withdrawals[5].id, "TXID00000007-fee");
      assert.equal(withdrawals[5].type, "STEEM);
      assert.equal(withdrawals[5].recipient, CONSTANTS.STEEM_ENGINE_ACCOUNT);
      assert.equal(withdrawals[5].memo, "fee tx TXID00000007");
      assert.equal(withdrawals[5].quantity, 0.002);

      resolve();
    }).then(() => {
      fixture.tearDown();
      done();
    });
  });

  it("does not withdraw HIVE", (done) => {
    new Promise(async (resolve) => {
      await fixture.setUp();

      let refBlockNumber = fixture.getNextRefBlockNumber();
      let transactions = [];
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          CONSTANTS.STEEM_ENGINE_ACCOUNT,
          "contract",
          "update",
          JSON.stringify(tknContractPayload)
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          CONSTANTS.STEEM_PEGGED_ACCOUNT,
          "contract",
          "update",
          JSON.stringify(pegContractPayload)
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          "harpagon",
          "steempegged",
          "buy",
          `{ "recipient": "${CONSTANTS.STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "0.003 HIVE", "isSignedWithActiveKey": true }`
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          "satoshi",
          "steempegged",
          "buy",
          `{ "recipient": "${CONSTANTS.STEEM_PEGGED_ACCOUNT}", "amountSTEEMSBD": "0.879 HIVE", "isSignedWithActiveKey": true }`
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          "satoshi",
          "steempegged",
          "withdraw",
          '{ "quantity": "0.001", "isSignedWithActiveKey": true }'
        )
      );
      transactions.push(
        new Transaction(
          refBlockNumber,
          fixture.getNextTxId(),
          "satoshi",
          "steempegged",
          "withdraw",
          '{ "quantity": "0.0021", "isSignedWithActiveKey": true }'
        )
      );

      let block = {
        refSteemBlockNumber: refBlockNumber,
        refSteemBlockId: "ABCD1",
        prevRefSteemBlockId: "ABCD2",
        timestamp: "2018-06-01T00:00:00",
        transactions,
      };

      await fixture.sendBlock(block);

      let res = await fixture.database.findOne({
        contract: "tokens",
        table: "balances",
        query: {
          symbol: CONSTANTS.STEEM_PEGGED_SYMBOL,
          account: "satoshi",
        },
      });

      let balance = res;

      assert.equal(balance.balance, 0.872);
      assert.equal(balance.account, "satoshi");
      assert.equal(balance.symbol, CONSTANTS.STEEM_PEGGED_SYMBOL);

      res = await fixture.database.find({
        contract: "steempegged",
        table: "withdrawals",
        query: {
          recipient: "satoshi",
        },
      });

      let withdrawals = res;
      assert.equal(withdrawals.length, 0);

      resolve();
    }).then(() => {
      fixture.tearDown();
      done();
    });
  });
});
