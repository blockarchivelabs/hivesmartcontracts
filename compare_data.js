/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-underscore-dangle */
require("dotenv").config();
const axios = require("axios");

let id = 1;

const contractNames = [
  "tokens",
  "claimdrops",
  "distribution",
  "nftmarket",
  "mining",
  "packmanager",
  "nft",
  "airdrops",
  "inflation",
  "marketmaker",
  "botcontroller",
  "market",
  "crittermanager",
  "steempegged",
];

const node1 = "https://localhost/rpc/contracts";
const node2 = "http://127.0.0.1:5000/contracts";

async function getData(url, contract, tablekey, offset, query = {}) {
  if (!tablekey) return null;
  const table = tablekey.split("_")[1];
  try {
    id += 1;
    const data = (
      await axios({
        url,
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        data: {
          jsonrpc: "2.0",
          id,
          method: "find",
          params: {
            contract,
            table,
            query,
            offset,
          },
        },
      })
    ).data.result;
    return data;
  } catch (error) {
    console.error(error);
  }
  return null;
}

async function compare(contractName) {
  console.log(`comparing ${contractName}`);
  id += 1;
  const contract = (
    await axios({
      url: "https://localhost/rpc/contracts",
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      data: {
        jsonrpc: "2.0",
        id,
        method: "getContract",
        params: { name: contractName },
      },
    })
  ).data.result;
  const tableNames = Object.keys(contract.tables);
  for (let i = 0; i < tableNames.length; i += 1) {
    const t = tableNames[i];
    let offset = 0;
    console.log(`comparing ${contractName}: ${t}`);
    let done = false;
    while (!done) {
      const data1 = await getData(node1, contractName, t, offset);
      const data2 = await getData(node2, contractName, t, offset);
      let mismatch = false;
      for (let j = 0; j < data1.length; j += 1) {
        if (JSON.stringify(data1[j]) !== JSON.stringify(data2[j])) {
          // 1 attempt to retry
          const data1Retry = await getData(node1, contractName, t, 0, {
            _id: data1[j]._id,
          });
          const data2Retry = await getData(node2, contractName, t, 0, {
            _id: data2[j]._id,
          });

          if (JSON.stringify(data1Retry) !== JSON.stringify(data2Retry)) {
            console.error(
              `Mismatch in ${contractName}:${t} at _id ${data1[j]._id}`
            );
            console.error(JSON.stringify(data1Retry));
            console.error(JSON.stringify(data2Retry));
            mismatch = true;
          }
        }
      }
      if (!mismatch) {
        console.log(`compared ${contractName}:${t} at offset ${offset}`);
      }
      offset += 1000;
      if (data1.length < 1000) {
        done = true;
      }
    }
  }
}

contractNames.forEach(compare);
