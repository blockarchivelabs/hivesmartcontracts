const { Base64 } = require("js-base64");
const fs = require("fs-extra");
const { Transaction } = require("../../libs/Transaction");
const { CONSTANTS } = require("../../libs/Constants");

class Bootstrap {
  static async getBootstrapTransactions(genesisSteemBlock) {
    const transactions = [];

    let contractCode;
    let base64ContractCode;
    let contractPayload;

    // tokens contract
    contractCode = await fs.readFileSync("./contracts/bootstrap/tokens.js");
    contractCode = contractCode.toString();

    contractCode = contractCode.replace(
      /'\$\{CONSTANTS.UTILITY_TOKEN_PRECISION\}\$'/g,
      CONSTANTS.UTILITY_TOKEN_PRECISION
    );
    contractCode = contractCode.replace(
      /'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g,
      CONSTANTS.UTILITY_TOKEN_SYMBOL
    );
    contractCode = contractCode.replace(
      /'\$\{CONSTANTS.STEEM_PEGGED_SYMBOL\}\$'/g,
      CONSTANTS.STEEM_PEGGED_SYMBOL
    );

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: "tokens",
      params: "",
      code: base64ContractCode,
    };

    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        CONSTANTS.STEEM_ENGINE_ACCOUNT,
        "contract",
        "deploy",
        JSON.stringify(contractPayload)
      )
    );

    // hive-pegged asset contract
    contractCode = await fs.readFileSync(
      "./contracts/bootstrap/steempegged.js"
    );
    contractCode = contractCode.toString();

    contractCode = contractCode.replace(
      /'\$\{CONSTANTS.ACCOUNT_RECEIVING_FEES\}\$'/g,
      CONSTANTS.ACCOUNT_RECEIVING_FEES
    );

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: "steempegged",
      params: "",
      code: base64ContractCode,
    };

    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        CONSTANTS.STEEM_PEGGED_ACCOUNT,
        "contract",
        "deploy",
        JSON.stringify(contractPayload)
      )
    );

    contractCode = await fs.readFileSync("./contracts/bootstrap/market.js");
    contractCode = contractCode.toString();

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: "market",
      params: "",
      code: base64ContractCode,
    };

    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "null",
        "contract",
        "deploy",
        JSON.stringify(contractPayload)
      )
    );

    contractCode = await fs.readFileSync("./contracts/bootstrap/nft.js");
    contractCode = contractCode.toString();
    contractCode = contractCode.replace(
      /'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g,
      CONSTANTS.UTILITY_TOKEN_SYMBOL
    );

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: "nft",
      params: "",
      code: base64ContractCode,
    };

    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        CONSTANTS.STEEM_ENGINE_ACCOUNT,
        "contract",
        "deploy",
        JSON.stringify(contractPayload)
      )
    );

    contractCode = await fs.readFileSync("./contracts/bootstrap/nftmarket.js");
    contractCode = contractCode.toString();

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: "nftmarket",
      params: "",
      code: base64ContractCode,
    };

    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        CONSTANTS.STEEM_ENGINE_ACCOUNT,
        "contract",
        "deploy",
        JSON.stringify(contractPayload)
      )
    );

    contractCode = await fs.readFileSync("./contracts/bootstrap/inflation.js");
    contractCode = contractCode.toString();
    contractCode = contractCode.replace(
      /'\$\{CONSTANTS.UTILITY_TOKEN_SYMBOL\}\$'/g,
      CONSTANTS.UTILITY_TOKEN_SYMBOL
    );
    contractCode = contractCode.replace(
      /'\$\{CONSTANTS.STEEM_ENGINE_ACCOUNT\}\$'/g,
      CONSTANTS.STEEM_ENGINE_ACCOUNT
    );

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: "inflation",
      params: "",
      code: base64ContractCode,
    };

    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "null",
        "contract",
        "deploy",
        JSON.stringify(contractPayload)
      )
    );

    // bootstrap transactions
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "null",
        "tokens",
        "create",
        `{ "name": "Steem Engine Token", "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "precision": ${CONSTANTS.UTILITY_TOKEN_PRECISION}, "maxSupply": "${Number.MAX_SAFE_INTEGER}", "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "null",
        "tokens",
        "enableStaking",
        `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "unstakingCooldown": 40, "numberTransactions": 4, "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "null",
        "tokens",
        "enableDelegation",
        `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "undelegationCooldown": 7, "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "null",
        "tokens",
        "updateMetadata",
        `{"symbol":"${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "metadata": { "url":"https://hive-engine.com", "icon": "https://s3.amazonaws.com/steem-engine/images/icon_steem-engine_gradient.svg", "desc": "STEEMP is the native token for the Steem Engine platform" }}`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "null",
        "tokens",
        "issue",
        `{ "symbol": "${CONSTANTS.UTILITY_TOKEN_SYMBOL}", "to": "${CONSTANTS.STEEM_ENGINE_ACCOUNT}", "quantity": "1500000", "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        CONSTANTS.STEEM_PEGGED_ACCOUNT,
        "tokens",
        "create",
        `{ "name": "STEEM Pegged", "symbol": "${CONSTANTS.STEEM_PEGGED_SYMBOL}", "precision": 8, "maxSupply": "${Number.MAX_SAFE_INTEGER}", "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        CONSTANTS.STEEM_PEGGED_ACCOUNT,
        "tokens",
        "updateMetadata",
        '{"symbol":"STEEMP", "metadata": { "desc": "STEEM backed by the steem-engine team" }}'
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        CONSTANTS.STEEM_PEGGED_ACCOUNT,
        "tokens",
        "issue",
        `{ "symbol": "${CONSTANTS.STEEM_PEGGED_SYMBOL}", "to": "${CONSTANTS.STEEM_PEGGED_ACCOUNT}", "quantity": "${Number.MAX_SAFE_INTEGER}", "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        CONSTANTS.STEEM_ENGINE_ACCOUNT,
        "tokens",
        "updateParams",
        `{ "tokenCreationFee": "${CONSTANTS.INITIAL_TOKEN_CREATION_FEE}", "enableDelegationFee": "${CONSTANTS.INITIAL_DELEGATION_ENABLEMENT_FEE}", "enableStakingFee": "${CONSTANTS.INITIAL_STAKING_ENABLEMENT_FEE}" }`
      )
    );

    // SCT
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "sct",
        "tokens",
        "create",
        `{ "name": "steemcoinpan token", "symbol": "SCT", "precision": 3, "maxSupply": "10000000000", "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        CONSTANTS.STEEM_PEGGED_ACCOUNT,
        "tokens",
        "updateMetadata",
        '{"symbol":"SCT", "metadata": { "desc": "steemcoinpan token" }}'
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "sct",
        "tokens",
        "enableStaking",
        `{ "symbol": "SCT", "unstakingCooldown": 3, "numberTransactions": 4, "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "sct",
        "tokens",
        "enableDelegation",
        `{ "symbol": "SCT", "undelegationCooldown": 3, "isSignedWithActiveKey": true }`
      )
    );

    // SCTM
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "sct",
        "tokens",
        "create",
        `{ "name": "steemcoinpan mining token", "symbol": "SCTM", "precision": 5, "maxSupply": "1000000", "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        CONSTANTS.STEEM_PEGGED_ACCOUNT,
        "tokens",
        "updateMetadata",
        '{"symbol":"SCTM", "metadata": { "desc": "steemcoinpan mining token" }}'
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "sct",
        "tokens",
        "enableStaking",
        `{ "symbol": "SCTM", "unstakingCooldown": 1, "numberTransactions": 4, "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "sct",
        "tokens",
        "enableDelegation",
        `{ "symbol": "SCTM", "undelegationCooldown": 1, "isSignedWithActiveKey": true }`
      )
    );

    // KRWP
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "sct",
        "tokens",
        "create",
        `{ "name": "krwp", "symbol": "KRWP", "precision": 3, "maxSupply": "100000000", "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        CONSTANTS.STEEM_PEGGED_ACCOUNT,
        "tokens",
        "updateMetadata",
        '{"symbol":"KRWP", "metadata": { "desc": "krwp" }}'
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "sct",
        "tokens",
        "enableStaking",
        `{ "symbol": "KRWP", "unstakingCooldown": 3, "numberTransactions": 4, "isSignedWithActiveKey": true }`
      )
    );
    transactions.push(
      new Transaction(
        genesisSteemBlock,
        0,
        "sct",
        "tokens",
        "enableDelegation",
        `{ "symbol": "KRWP", "undelegationCooldown": 3, "isSignedWithActiveKey": true }`
      )
    );

    return transactions;
  }
}

module.exports.Bootstrap = Bootstrap;
