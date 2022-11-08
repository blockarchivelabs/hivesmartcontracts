const axios = require("axios");
const log = require("loglevel");
const { Block } = require("../libs/Block");
const { Transaction } = require("../libs/Transaction");
const { IPC } = require("../libs/IPC");
const { Database } = require("../libs/Database");
const { Bootstrap } = require("../contracts/bootstrap/Bootstrap");

const PLUGIN_PATH = require.resolve(__filename);
const { PLUGIN_NAME, PLUGIN_ACTIONS } = require("./Blockchain.constants");

const actions = {};

const ipc = new IPC(PLUGIN_NAME);
let database = null;
let javascriptVMTimeout = 0;
let producing = false;
let stopRequested = false;
let enableHashVerification = false;

const createGenesisBlock = async (payload) => {
  // check if genesis block hasn't been generated already
  let genesisBlock = await database.getBlockInfo(0);

  if (!genesisBlock) {
    // insert the genesis block
    const { chainId, genesisSteemBlock } = payload;

    const genesisTransactions = await Bootstrap.getBootstrapTransactions(
      genesisSteemBlock
    );
    genesisTransactions.unshift(
      new Transaction(
        genesisSteemBlock,
        0,
        "null",
        "null",
        "null",
        JSON.stringify({ chainId, genesisSteemBlock })
      )
    );

    genesisBlock = new Block(
      "2018-06-01T00:00:00",
      0,
      "",
      "",
      genesisTransactions,
      -1,
      "0"
    );
    await genesisBlock.produceBlock(database, javascriptVMTimeout);

    const tokenBalances = database.database.collection("tokens_balances");
    await tokenBalances.insertOne({
      _id: 5,
      account: "sct",
      symbol: "STEEMP",
      balance: "10000",
      stake: "0",
      pendingUnstake: "0",
      delegationsIn: "0",
      delegationsOut: "0",
      pendingUndelegations: "0",
    });

    await tokenBalances.insertOne({
      _id: 6,
      account: "sct",
      symbol: "ENG",
      balance: "10000",
      stake: "0",
      pendingUnstake: "0",
      delegationsIn: "0",
      delegationsOut: "0",
      pendingUndelegations: "0",
    });
    await database.insertGenesisBlock(genesisBlock);
  }
};

function getLatestBlockMetadata() {
  return database.getLatestBlockMetadata();
}

function addBlock(block) {
  return database.addBlock(block);
}

function getRefBlockNumber(block) {
  if (block.otherHashChangeRefHiveBlocks) {
    return block.otherHashChangeRefHiveBlocks[
      block.otherHashChangeRefHiveBlocks.length - 1
    ];
  }
  return block.refSteemBlockNumber;
}

// produce all the pending transactions, that will result in the creation of a block
async function producePendingTransactions(
  refSteemBlockNumber,
  refSteemBlockId,
  prevRefSteemBlockId,
  transactions,
  timestamp
) {
  const previousBlock = await getLatestBlockMetadata();
  if (previousBlock) {
    // skip block if it has been parsed already
    const lastRefBlockNumber = getRefBlockNumber(previousBlock);
    if (refSteemBlockNumber <= lastRefBlockNumber) {
      // eslint-disable-next-line no-console
      console.warn(
        `skipping Hive block ${refSteemBlockNumber} as it has already been parsed`
      );
      return;
    }

    const newBlock = new Block(
      timestamp,
      refSteemBlockNumber,
      refSteemBlockId,
      prevRefSteemBlockId,
      transactions,
      previousBlock.blockNumber,
      previousBlock.hash,
      previousBlock.databaseHash
    );

    const session = database.startSession();

    const mainBlock = !enableHashVerification
      ? null
      : (
          await axios({
            url: "https://localhost/rpc/blockchain",
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            data: {
              jsonrpc: "2.0",
              id: 10,
              method: "getBlockInfo",
              params: { blockNumber: newBlock.blockNumber },
            },
          })
        ).data.result;
    try {
      await session.withTransaction(async () => {
        await newBlock.produceBlock(database, javascriptVMTimeout, mainBlock);

        if (
          newBlock.transactions.length > 0 ||
          newBlock.virtualTransactions.length > 0
        ) {
          if (mainBlock && newBlock.hash) {
            console.log(
              `Sidechain Block ${mainBlock.blockNumber}, Main db hash: ${mainBlock.databaseHash}, Main block hash: ${mainBlock.hash}, This db hash: ${newBlock.databaseHash}, This block hash: ${newBlock.hash}`
            ); // eslint-disable-line no-console

            if (
              mainBlock.databaseHash !== newBlock.databaseHash ||
              mainBlock.hash !== newBlock.hash
            ) {
              throw new Error(
                `Block mismatch with api \nMain: ${JSON.stringify(
                  mainBlock,
                  null,
                  2
                )}, \nThis: ${JSON.stringify(newBlock, null, 2)}`
              );
            }
          }

          await addBlock(newBlock);
        }
      });
    } catch (e) {
      console.error(e); // eslint-disable-line no-console
      throw e;
    } finally {
      await database.endSession();
    }
  } else {
    throw new Error("block not found");
  }
}

const produceNewBlockSync = async (block, callback = null) => {
  if (stopRequested) return;
  producing = true;
  // the stream parsed transactions from the Hive blockchain
  const {
    refSteemBlockNumber,
    refSteemBlockId,
    prevRefSteemBlockId,
    transactions,
    timestamp,
    virtualTransactions,
    replay,
  } = block;
  const newTransactions = [];

  transactions.forEach((transaction) => {
    const finalTransaction = transaction;

    newTransactions.push(
      new Transaction(
        finalTransaction.refSteemBlockNumber,
        finalTransaction.transactionId,
        finalTransaction.sender,
        finalTransaction.contract,
        finalTransaction.action,
        finalTransaction.payload
      )
    );
  });

  // if there are transactions pending we produce a block
  if (
    newTransactions.length > 0 ||
    (virtualTransactions && virtualTransactions.length > 0) ||
    replay
  ) {
    await producePendingTransactions(
      refSteemBlockNumber,
      refSteemBlockId,
      prevRefSteemBlockId,
      newTransactions,
      timestamp
    );
  }
  producing = false;

  if (callback) callback();
};

// when stopping, we wait until the current block is produced
function stop(callback) {
  stopRequested = true;
  if (producing) {
    setTimeout(() => stop(callback), 500);
  } else {
    stopRequested = false;
    if (database) database.close();
    callback();
  }
}

const init = async (conf, callback) => {
  const { databaseURL, databaseName, lightNode, blocksToKeep } = conf;
  javascriptVMTimeout = conf.javascriptVMTimeout; // eslint-disable-line prefer-destructuring
  enableHashVerification = conf.enableHashVerification; // eslint-disable-line prefer-destructuring
  log.setDefaultLevel(conf.defaultLogLevel ? conf.defaultLogLevel : "warn");

  database = new Database();
  await database.init(databaseURL, databaseName, lightNode, blocksToKeep);

  await createGenesisBlock(conf);

  callback(null);
};

ipc.onReceiveMessage((message) => {
  const {
    action,
    payload,
    // from,
  } = message;

  if (action === "init") {
    init(payload, (res) => {
      console.log("successfully initialized"); // eslint-disable-line no-console
      ipc.reply(message, res);
    });
  } else if (action === "stop") {
    stop(() => {
      console.log("successfully stopped"); // eslint-disable-line no-console
      ipc.reply(message);
    });
  } else if (action === PLUGIN_ACTIONS.PRODUCE_NEW_BLOCK_SYNC) {
    produceNewBlockSync(payload, () => {
      ipc.reply(message);
    });
  } else if (action && typeof actions[action] === "function") {
    ipc.reply(message, actions[action](payload));
  } else {
    ipc.reply(message);
  }
});

module.exports.producePendingTransactions = producePendingTransactions;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLUGIN_PATH = PLUGIN_PATH;
module.exports.PLUGIN_ACTIONS = PLUGIN_ACTIONS;
