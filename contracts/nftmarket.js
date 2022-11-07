/* eslint-disable no-await-in-loop */
/* eslint-disable max-len */
/* eslint-disable prefer-template */
/* eslint-disable no-underscore-dangle */
/* global actions, api */

const CONTRACT_NAME = "nftmarket";

// cannot buy or sell more than this number of NFT instances in one action
const MAX_NUM_UNITS_OPERABLE = 50;

actions.createSSC = async () => {
  const tableExists = await api.db.tableExists("params");
  if (tableExists === false) {
    await api.db.createTable("params", ["symbol"]);
  }
};

// check that token transfers succeeded
const isTokenTransferVerified = (
  result,
  from,
  to,
  symbol,
  quantity,
  eventStr
) => {
  if (
    result.errors === undefined &&
    result.events &&
    result.events.find(
      (el) =>
        el.contract === "tokens" &&
        el.event === eventStr &&
        el.data.from === from &&
        el.data.to === to &&
        el.data.quantity === quantity &&
        el.data.symbol === symbol
    ) !== undefined
  ) {
    return true;
  }
  return false;
};

const countDecimals = (value) => api.BigNumber(value).dp();

// a valid Hive account is between 3 and 16 characters in length
const isValidHiveAccountLength = (account) =>
  account.length >= 3 && account.length <= 16;

// helper for buy action
const makeMapKey = (account, type) => account + "-" + type;

// helper for updating open interest
const makeGroupingKey = (grouping, groupBy) => {
  let key = "";
  groupBy.forEach((name) => {
    key = key + ":" + name + ":" + grouping[name];
  });
  return key;
};

const isValidIdArray = (arr) => {
  try {
    if (
      !api.assert(
        arr && typeof arr === "object" && Array.isArray(arr),
        "invalid id list"
      )
    ) {
      return false;
    }

    if (
      !api.assert(
        arr.length <= MAX_NUM_UNITS_OPERABLE,
        `cannot act on more than ${MAX_NUM_UNITS_OPERABLE} IDs at once`
      )
    ) {
      return false;
    }

    for (let i = 0; i < arr.length; i += 1) {
      const id = arr[i];
      if (
        !api.assert(
          id &&
            typeof id === "string" &&
            !api.BigNumber(id).isNaN() &&
            api.BigNumber(id).gt(0),
          "invalid id list"
        )
      ) {
        return false;
      }
    }
  } catch (e) {
    return false;
  }
  return true;
};

actions.enableMarket = async (payload) => {
  const { symbol, isSignedWithActiveKey } = payload;

  if (
    api.assert(
      isSignedWithActiveKey === true,
      "you must use a custom_json signed with your active key"
    ) &&
    api.assert(symbol && typeof symbol === "string", "invalid params")
  ) {
    // make sure NFT exists and verify ownership
    const nft = await api.db.findOneInTable("nft", "nfts", { symbol });
    if (
      api.assert(nft !== null, "symbol does not exist") &&
      api.assert(nft.issuer === api.sender, "must be the issuer")
    ) {
      // create a new table to hold market orders for this NFT
      // eslint-disable-next-line prefer-template
      const marketTableName = symbol + "sellBook";
      const metricsTableName = symbol + "openInterest";
      const historyTableName = symbol + "tradesHistory";
      const tableExists = await api.db.tableExists(marketTableName);
      if (api.assert(tableExists === false, "market already enabled")) {
        await api.db.createTable(marketTableName, [
          "ownedBy",
          "account",
          "nftId",
          "grouping",
          "priceSymbol",
        ]);
        await api.db.createTable(metricsTableName, [
          "side",
          "priceSymbol",
          "grouping",
        ]);
        await api.db.createTable(historyTableName, [
          "priceSymbol",
          "timestamp",
        ]);

        api.emit("enableMarket", { symbol });
      }
    }
  }
};

const updateOpenInterest = async (
  side,
  symbol,
  priceSymbol,
  groups,
  groupBy
) => {
  const metricsTableName = symbol + "openInterest";

  // collect all the groupings to fetch
  const groupKeys = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const info of Object.values(groups)) {
    groupKeys.push(info.grouping);
  }

  if (groupKeys.length <= 0) {
    return;
  }

  const openInterest = await api.db.find(
    metricsTableName,
    {
      side,
      priceSymbol,
      grouping: {
        $in: groupKeys,
      },
    },
    MAX_NUM_UNITS_OPERABLE,
    0,
    [
      { index: "side", descending: false },
      { index: "priceSymbol", descending: false },
      { index: "grouping", descending: false },
    ]
  );

  // update existing records...
  for (let i = 0; i < openInterest.length; i += 1) {
    const metric = openInterest[i];
    const key = makeGroupingKey(metric.grouping, groupBy);
    if (key in groups) {
      // eslint-disable-next-line no-param-reassign
      groups[key].isInCollection = true;
      metric.count += groups[key].count;
      if (metric.count < 0) {
        metric.count = 0; // shouldn't happen, but need to safeguard
      }

      await api.db.update(metricsTableName, metric);
    }
  }

  // ...and add new ones
  // eslint-disable-next-line no-restricted-syntax
  for (const info of Object.values(groups)) {
    if (!info.isInCollection) {
      const finalCount = info.count > 0 ? info.count : 0;
      const newMetric = {
        side,
        priceSymbol,
        grouping: info.grouping,
        count: finalCount,
      };

      await api.db.insert(metricsTableName, newMetric);
    }
  }
};

const updateTradesHistory = async (
  type,
  account,
  ownedBy,
  counterparties,
  symbol,
  priceSymbol,
  price,
  isMarketFeePaid,
  marketAccount,
  fee,
  isAgentFeePaid,
  agentAccount,
  agentFee,
  volume
) => {
  const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
  const timestampSec = blockDate.getTime() / 1000;
  const timestampMinus24hrs =
    blockDate.setUTCDate(blockDate.getUTCDate() - 1) / 1000;
  const historyTableName = symbol + "tradesHistory";

  // clean history
  let tradesToDelete = await api.db.find(
    historyTableName,
    {
      priceSymbol,
      timestamp: {
        $lt: timestampMinus24hrs,
      },
    },
    1000,
    0,
    [{ index: "_id", descending: false }]
  );
  let nbTradesToDelete = tradesToDelete.length;

  while (nbTradesToDelete > 0) {
    for (let index = 0; index < nbTradesToDelete; index += 1) {
      const trade = tradesToDelete[index];
      await api.db.remove(historyTableName, trade);
    }
    tradesToDelete = await api.db.find(
      historyTableName,
      {
        priceSymbol,
        timestamp: {
          $lt: timestampMinus24hrs,
        },
      },
      1000,
      0,
      [{ index: "_id", descending: false }]
    );
    nbTradesToDelete = tradesToDelete.length;
  }

  // add order to the history
  const newTrade = {};
  newTrade.type = type;
  newTrade.account = account;
  newTrade.ownedBy = ownedBy;
  newTrade.counterparties = counterparties;
  newTrade.priceSymbol = priceSymbol;
  newTrade.price = price;
  if (isMarketFeePaid) {
    newTrade.marketAccount = marketAccount;
    newTrade.fee = fee;
  }
  if (isAgentFeePaid) {
    newTrade.agentAccount = agentAccount;
    newTrade.agentFee = agentFee;
  }
  newTrade.timestamp = timestampSec;
  newTrade.volume = volume;
  await api.db.insert(historyTableName, newTrade);
};

actions.setMarketParams = async (payload) => {
  const { symbol, officialMarket, agentCut, minFee, isSignedWithActiveKey } =
    payload;

  if (!api.assert(symbol && typeof symbol === "string", "invalid params")) {
    return false;
  }

  // if no parameters supplied, we have nothing to do
  if (
    officialMarket === undefined &&
    agentCut === undefined &&
    minFee === undefined
  ) {
    return false;
  }

  const marketTableName = symbol + "sellBook";
  const tableExists = await api.db.tableExists(marketTableName);

  if (
    api.assert(
      isSignedWithActiveKey === true,
      "you must use a custom_json signed with your active key"
    ) &&
    api.assert(tableExists, "market not enabled for symbol") &&
    api.assert(
      (officialMarket === undefined ||
        (officialMarket &&
          typeof officialMarket === "string" &&
          isValidHiveAccountLength(officialMarket.trim().toLowerCase()))) &&
        (agentCut === undefined ||
          (typeof agentCut === "number" &&
            agentCut >= 0 &&
            agentCut <= 10000 &&
            Number.isInteger(agentCut))) &&
        (minFee === undefined ||
          (typeof minFee === "number" &&
            minFee >= 0 &&
            minFee <= 10000 &&
            Number.isInteger(minFee))),
      "invalid params"
    )
  ) {
    const nft = await api.db.findOneInTable("nft", "nfts", { symbol });

    if (nft) {
      if (api.assert(nft.issuer === api.sender, "must be the issuer")) {
        let shouldUpdate = false;
        let isFirstTimeSet = false;
        const update = {
          symbol,
        };

        let params = await api.db.findOne("params", { symbol });
        if (!params) {
          isFirstTimeSet = true;
          params = {
            symbol,
          };
        }

        const finalOfficialMarket =
          officialMarket !== undefined
            ? officialMarket.trim().toLowerCase()
            : null;
        if (
          officialMarket !== undefined &&
          (params.officialMarket === undefined ||
            finalOfficialMarket !== params.officialMarket)
        ) {
          if (params.officialMarket !== undefined) {
            update.oldOfficialMarket = params.officialMarket;
          }
          params.officialMarket = finalOfficialMarket;
          update.officialMarket = finalOfficialMarket;
          shouldUpdate = true;
        }
        if (
          agentCut !== undefined &&
          (params.agentCut === undefined || agentCut !== params.agentCut)
        ) {
          if (params.agentCut !== undefined) {
            update.oldAgentCut = params.agentCut;
          }
          params.agentCut = agentCut;
          update.agentCut = agentCut;
          shouldUpdate = true;
        }
        if (
          minFee !== undefined &&
          (params.minFee === undefined || minFee !== params.minFee)
        ) {
          if (params.minFee !== undefined) {
            update.oldMinFee = params.minFee;
          }
          params.minFee = minFee;
          update.minFee = minFee;
          shouldUpdate = true;
        }

        if (shouldUpdate) {
          if (isFirstTimeSet) {
            await api.db.insert("params", params);
          } else {
            await api.db.update("params", params);
          }

          api.emit("setMarketParams", update);
          return true;
        }
      }
    }
  }
  return false;
};

actions.changePrice = async (payload) => {
  const { symbol, nfts, price, isSignedWithActiveKey } = payload;

  if (!api.assert(symbol && typeof symbol === "string", "invalid params")) {
    return;
  }

  const marketTableName = symbol + "sellBook";
  const tableExists = await api.db.tableExists(marketTableName);

  if (
    api.assert(
      isSignedWithActiveKey === true,
      "you must use a custom_json signed with your active key"
    ) &&
    isValidIdArray(nfts) &&
    api.assert(
      price && typeof price === "string" && !api.BigNumber(price).isNaN(),
      "invalid params"
    ) &&
    api.assert(tableExists, "market not enabled for symbol")
  ) {
    // look up order info
    const orders = await api.db.find(
      marketTableName,
      {
        nftId: {
          $in: nfts,
        },
      },
      MAX_NUM_UNITS_OPERABLE,
      0,
      [{ index: "nftId", descending: false }]
    );

    if (orders.length > 0) {
      // need to make sure that caller is actually the owner of each order
      // and all orders have the same price symbol
      let priceSymbol = "";
      for (let i = 0; i < orders.length; i += 1) {
        const order = orders[i];
        if (priceSymbol === "") {
          ({ priceSymbol } = order);
        }
        if (
          !api.assert(
            order.account === api.sender && order.ownedBy === "u",
            "all orders must be your own"
          ) ||
          !api.assert(
            priceSymbol === order.priceSymbol,
            "all orders must have the same price symbol"
          )
        ) {
          return;
        }
      }
      // get the price token params
      const token = await api.db.findOneInTable("tokens", "tokens", {
        symbol: priceSymbol,
      });
      if (
        api.assert(
          token &&
            api.BigNumber(price).gt(0) &&
            countDecimals(price) <= token.precision,
          "invalid price"
        )
      ) {
        const finalPrice = api.BigNumber(price).toFixed(token.precision);
        for (let i = 0; i < orders.length; i += 1) {
          const order = orders[i];
          const oldPrice = order.price;
          order.price = finalPrice;
          order.priceDec = { $numberDecimal: finalPrice };

          await api.db.update(marketTableName, order);

          api.emit("changePrice", {
            symbol,
            nftId: order.nftId,
            oldPrice,
            newPrice: order.price,
            priceSymbol: order.priceSymbol,
            orderId: order._id,
          });
        }
      }
    }
  }
};

actions.cancel = async (payload) => {
  const { symbol, nfts, isSignedWithActiveKey } = payload;

  if (!api.assert(symbol && typeof symbol === "string", "invalid params")) {
    return;
  }

  const marketTableName = symbol + "sellBook";
  const tableExists = await api.db.tableExists(marketTableName);

  if (
    api.assert(
      isSignedWithActiveKey === true,
      "you must use a custom_json signed with your active key"
    ) &&
    isValidIdArray(nfts) &&
    api.assert(tableExists, "market not enabled for symbol")
  ) {
    const nft = await api.db.findOneInTable("nft", "nfts", { symbol });
    if (
      !api.assert(
        nft && nft.groupBy && nft.groupBy.length > 0,
        "market grouping not set"
      )
    ) {
      return;
    }

    // look up order info
    const orders = await api.db.find(
      marketTableName,
      {
        nftId: {
          $in: nfts,
        },
      },
      MAX_NUM_UNITS_OPERABLE,
      0,
      [{ index: "nftId", descending: false }]
    );

    if (orders.length > 0) {
      // need to make sure that caller is actually the owner of each order
      const ids = [];
      const idMap = {};
      let priceSymbol = "";
      for (let i = 0; i < orders.length; i += 1) {
        const order = orders[i];
        if (priceSymbol === "") {
          ({ priceSymbol } = order);
        }
        if (
          !api.assert(
            order.account === api.sender && order.ownedBy === "u",
            "all orders must be your own"
          ) ||
          !api.assert(
            priceSymbol === order.priceSymbol,
            "all orders must have the same price symbol"
          )
        ) {
          return;
        }
        ids.push(order.nftId);
        idMap[order.nftId] = order;
      }

      // move the locked NFTs back to their owner
      const nftArray = [];
      const wrappedNfts = {
        symbol,
        ids,
      };
      nftArray.push(wrappedNfts);
      const res = await api.executeSmartContract("nft", "transfer", {
        fromType: "contract",
        to: api.sender,
        toType: "user",
        nfts: nftArray,
        isSignedWithActiveKey,
      });

      // it's possible (but unlikely) that some transfers could have failed
      // due to validation errors & whatnot, so we need to loop over the
      // transfer results and only cancel orders for the transfers that succeeded
      if (res.events) {
        const groupingMap = {};
        for (let j = 0; j < res.events.length; j += 1) {
          const ev = res.events[j];
          if (
            ev.contract &&
            ev.event &&
            ev.data &&
            ev.contract === "nft" &&
            ev.event === "transfer" &&
            ev.data.from === CONTRACT_NAME &&
            ev.data.fromType === "c" &&
            ev.data.to === api.sender &&
            ev.data.toType === "u" &&
            ev.data.symbol === symbol
          ) {
            // transfer is verified, now we can cancel the order
            const instanceId = ev.data.id;
            if (instanceId in idMap) {
              const order = idMap[instanceId];

              await api.db.remove(marketTableName, order);

              api.emit("cancelOrder", {
                account: order.account,
                ownedBy: order.ownedBy,
                symbol,
                nftId: order.nftId,
                timestamp: order.timestamp,
                price: order.price,
                priceSymbol: order.priceSymbol,
                fee: order.fee,
                orderId: order._id,
              });

              const key = makeGroupingKey(order.grouping, nft.groupBy);
              const groupInfo =
                key in groupingMap
                  ? groupingMap[key]
                  : {
                      grouping: order.grouping,
                      isInCollection: false,
                      count: 0,
                    };
              groupInfo.count -= 1;
              groupingMap[key] = groupInfo;
            }
          }
        }

        // update open interest metrics
        await updateOpenInterest(
          "sell",
          symbol,
          priceSymbol,
          groupingMap,
          nft.groupBy
        );
      }
    }
  }
};

actions.buy = async (payload) => {
  const {
    symbol,
    nfts,
    marketAccount,
    expPrice,
    expPriceSymbol,
    isSignedWithActiveKey,
  } = payload;

  if (
    !api.assert(
      symbol &&
        typeof symbol === "string" &&
        marketAccount &&
        typeof marketAccount === "string" &&
        (expPrice === undefined ||
          (expPrice &&
            typeof expPrice === "string" &&
            !api.BigNumber(expPrice).isNaN())) &&
        (expPriceSymbol === undefined ||
          (expPriceSymbol && typeof expPriceSymbol === "string")),
      "invalid params"
    )
  ) {
    return;
  }

  const marketTableName = symbol + "sellBook";
  const tableExists = await api.db.tableExists(marketTableName);

  if (
    api.assert(
      isSignedWithActiveKey === true,
      "you must use a custom_json signed with your active key"
    ) &&
    isValidIdArray(nfts) &&
    api.assert(tableExists, "market not enabled for symbol")
  ) {
    const finalMarketAccount = marketAccount.trim().toLowerCase();
    if (
      api.assert(
        isValidHiveAccountLength(finalMarketAccount),
        "invalid market account"
      ) &&
      api.assert(
        finalMarketAccount !== api.sender,
        "market account cannot be same as buyer"
      )
    ) {
      const nft = await api.db.findOneInTable("nft", "nfts", { symbol });
      if (
        !api.assert(
          nft && nft.groupBy && nft.groupBy.length > 0,
          "market grouping not set"
        )
      ) {
        return;
      }

      // look up order info
      const orders = await api.db.find(
        marketTableName,
        {
          nftId: {
            $in: nfts,
          },
        },
        MAX_NUM_UNITS_OPERABLE,
        0,
        [{ index: "nftId", descending: false }]
      );

      if (orders.length > 0) {
        // do a couple more sanity checks
        let priceSymbol = "";
        for (let i = 0; i < orders.length; i += 1) {
          const order = orders[i];
          if (priceSymbol === "") {
            ({ priceSymbol } = order);
          }
          if (
            !api.assert(
              !(order.ownedBy === "u" && order.account === api.sender),
              "cannot fill your own orders"
            ) ||
            !api.assert(
              priceSymbol === order.priceSymbol,
              "all orders must have the same price symbol"
            )
          ) {
            return;
          }
        }
        // verify we have the expected priceSymbol
        if (
          !api.assert(
            expPriceSymbol === undefined || expPriceSymbol === priceSymbol,
            `unexpected price symbol ${priceSymbol}`
          )
        ) {
          return;
        }

        // get the price token params
        const token = await api.db.findOneInTable("tokens", "tokens", {
          symbol: priceSymbol,
        });
        if (!token) {
          return;
        }

        // create order maps
        let feeTotal = api.BigNumber(0);
        let agentFeeTotal = api.BigNumber(0);
        let paymentTotal = api.BigNumber(0);
        let soldNfts = [];
        const sellers = [];
        const sellerMap = {};
        for (let i = 0; i < orders.length; i += 1) {
          const order = orders[i];
          const finalPrice = api.BigNumber(order.price);
          const feePercent = order.fee / 10000;
          let finalFee = finalPrice
            .multipliedBy(feePercent)
            .decimalPlaces(token.precision);
          if (finalFee.gt(finalPrice)) {
            finalFee = finalPrice; // unlikely but need to be sure
          }
          let finalPayment = finalPrice
            .minus(finalFee)
            .decimalPlaces(token.precision);
          if (finalPayment.lt(0)) {
            finalPayment = api.BigNumber(0); // unlikely but need to be sure
          }
          paymentTotal = paymentTotal.plus(finalPayment);
          feeTotal = feeTotal.plus(finalFee);

          const key = makeMapKey(order.account, order.ownedBy);
          const sellerInfo =
            key in sellerMap
              ? sellerMap[key]
              : {
                  account: order.account,
                  ownedBy: order.ownedBy,
                  nftIds: [],
                  nftSales: [],
                  paymentTotal: api.BigNumber(0),
                };

          sellerInfo.paymentTotal = sellerInfo.paymentTotal.plus(finalPayment);
          sellerInfo.nftIds.push(order.nftId);
          sellerMap[key] = sellerInfo;
          sellerInfo.nftSales.push({
            id: order.nftId,
            price: finalPrice,
            fee: finalFee,
            symbol: priceSymbol,
          });
        }

        const params = await api.db.findOne("params", { symbol });
        const officialMarketAccount =
          params && params.officialMarket
            ? params.officialMarket
            : finalMarketAccount;
        if (
          !api.assert(
            officialMarketAccount !== api.sender,
            "official market account cannot be same as buyer"
          )
        ) {
          return;
        }

        // check if we have to split the fee into market & agent fees
        if (
          params &&
          params.officialMarket &&
          params.agentCut !== undefined &&
          params.agentCut > 0 &&
          feeTotal.gt(0)
        ) {
          const agentFeePercent = params.agentCut / 10000;
          agentFeeTotal = feeTotal
            .multipliedBy(agentFeePercent)
            .decimalPlaces(token.precision);
          if (agentFeeTotal.gt(feeTotal)) {
            agentFeeTotal = api.BigNumber(feeTotal); // unlikely but need to be sure
          }
          feeTotal = feeTotal
            .minus(agentFeeTotal)
            .decimalPlaces(token.precision);
          if (feeTotal.lt(0)) {
            feeTotal = api.BigNumber(0); // unlikely but need to be sure
          }
        }

        // verify buyer has enough funds for payment, and check payment is what we expect
        const requiredBalance = paymentTotal
          .plus(feeTotal)
          .plus(agentFeeTotal)
          .toFixed(token.precision);
        if (
          !api.assert(
            expPrice === undefined ||
              api.BigNumber(expPrice).eq(requiredBalance),
            `total required payment ${requiredBalance} ${priceSymbol} does not match expected amount`
          )
        ) {
          return;
        }
        const buyerBalance = await api.db.findOneInTable("tokens", "balances", {
          account: api.sender,
          symbol: priceSymbol,
        });
        if (
          !api.assert(
            buyerBalance &&
              api.BigNumber(buyerBalance.balance).gte(requiredBalance),
            "you must have enough tokens for payment"
          )
        ) {
          return;
        }
        paymentTotal = paymentTotal.toFixed(token.precision);

        // send fee to market account
        let isMarketFeePaid = false;
        if (feeTotal.gt(0)) {
          isMarketFeePaid = true;
          feeTotal = feeTotal.toFixed(token.precision);
          const res = await api.executeSmartContract("tokens", "transfer", {
            to: officialMarketAccount,
            symbol: priceSymbol,
            quantity: feeTotal,
            isSignedWithActiveKey,
          });
          if (
            !api.assert(
              isTokenTransferVerified(
                res,
                api.sender,
                officialMarketAccount,
                priceSymbol,
                feeTotal,
                "transfer"
              ),
              "unable to transfer market fees"
            )
          ) {
            return;
          }
        }

        // send fee to agent account
        let isAgentFeePaid = false;
        if (agentFeeTotal.gt(0)) {
          isAgentFeePaid = true;
          agentFeeTotal = agentFeeTotal.toFixed(token.precision);
          const res = await api.executeSmartContract("tokens", "transfer", {
            to: finalMarketAccount,
            symbol: priceSymbol,
            quantity: agentFeeTotal,
            isSignedWithActiveKey,
          });
          if (
            !api.assert(
              isTokenTransferVerified(
                res,
                api.sender,
                finalMarketAccount,
                priceSymbol,
                agentFeeTotal,
                "transfer"
              ),
              "unable to transfer agent fees"
            )
          ) {
            return;
          }
        }

        // send payments to sellers
        // eslint-disable-next-line no-restricted-syntax
        for (const info of Object.values(sellerMap)) {
          if (info.paymentTotal.gt(0)) {
            const contractAction =
              info.ownedBy === "u" ? "transfer" : "transferToContract";
            info.paymentTotal = info.paymentTotal.toFixed(token.precision);
            const res = await api.executeSmartContract(
              "tokens",
              contractAction,
              {
                to: info.account,
                symbol: priceSymbol,
                quantity: info.paymentTotal,
                isSignedWithActiveKey,
              }
            );
            if (
              api.assert(
                isTokenTransferVerified(
                  res,
                  api.sender,
                  info.account,
                  priceSymbol,
                  info.paymentTotal,
                  contractAction
                ),
                `unable to transfer payment to ${info.account}`
              )
            ) {
              soldNfts = soldNfts.concat(info.nftIds);
              sellers.push(info);
            }
          } else {
            soldNfts = soldNfts.concat(info.nftIds);
            sellers.push(info);
          }
        }

        // transfer sold NFT instances to new owner
        const nftArray = [];
        const wrappedNfts = {
          symbol,
          ids: soldNfts,
        };
        nftArray.push(wrappedNfts);
        await api.executeSmartContract("nft", "transfer", {
          fromType: "contract",
          to: api.sender,
          toType: "user",
          nfts: nftArray,
          isSignedWithActiveKey,
        });

        // delete sold market orders
        const groupingMap = {};
        const soldSet = new Set(soldNfts);
        for (let i = 0; i < orders.length; i += 1) {
          const order = orders[i];
          if (soldSet.has(order.nftId)) {
            await api.db.remove(marketTableName, order);

            const key = makeGroupingKey(order.grouping, nft.groupBy);
            const groupInfo =
              key in groupingMap
                ? groupingMap[key]
                : {
                    grouping: order.grouping,
                    isInCollection: false,
                    count: 0,
                  };
            groupInfo.count -= 1;
            groupingMap[key] = groupInfo;
          }
        }

        // add the trade to the history
        await updateTradesHistory(
          "buy",
          api.sender,
          "u",
          sellers,
          symbol,
          priceSymbol,
          requiredBalance,
          isMarketFeePaid,
          officialMarketAccount,
          feeTotal,
          isAgentFeePaid,
          finalMarketAccount,
          agentFeeTotal,
          soldNfts.length
        );

        const ackPacket = {
          symbol,
          priceSymbol,
          account: api.sender,
          ownedBy: "u",
          sellers,
          paymentTotal,
        };
        if (isMarketFeePaid) {
          ackPacket.marketAccount = officialMarketAccount;
          ackPacket.feeTotal = feeTotal;
        }
        if (isAgentFeePaid) {
          ackPacket.agentAccount = finalMarketAccount;
          ackPacket.agentFeeTotal = agentFeeTotal;
        }

        api.emit("hitSellOrder", ackPacket);

        // update open interest metrics
        await updateOpenInterest(
          "sell",
          symbol,
          priceSymbol,
          groupingMap,
          nft.groupBy
        );
      }
    }
  }
};

actions.sell = async (payload) => {
  const { symbol, nfts, price, priceSymbol, fee, isSignedWithActiveKey } =
    payload;

  if (!api.assert(symbol && typeof symbol === "string", "invalid params")) {
    return;
  }

  const marketTableName = symbol + "sellBook";
  const instanceTableName = symbol + "instances";
  const tableExists = await api.db.tableExists(marketTableName);

  if (
    api.assert(
      isSignedWithActiveKey === true,
      "you must use a custom_json signed with your active key"
    ) &&
    api.assert(
      nfts &&
        typeof nfts === "object" &&
        Array.isArray(nfts) &&
        priceSymbol &&
        typeof priceSymbol === "string" &&
        price &&
        typeof price === "string" &&
        !api.BigNumber(price).isNaN() &&
        typeof fee === "number" &&
        fee >= 0 &&
        fee <= 10000 &&
        Number.isInteger(fee),
      "invalid params"
    ) &&
    api.assert(
      nfts.length <= MAX_NUM_UNITS_OPERABLE,
      `cannot sell more than ${MAX_NUM_UNITS_OPERABLE} NFT instances at once`
    ) &&
    api.assert(tableExists, "market not enabled for symbol")
  ) {
    const nft = await api.db.findOneInTable("nft", "nfts", { symbol });
    if (
      !api.assert(
        nft && nft.groupBy && nft.groupBy.length > 0,
        "market grouping not set"
      )
    ) {
      return;
    }

    const params = await api.db.findOne("params", { symbol });
    if (params && params.minFee !== undefined) {
      if (
        !api.assert(fee >= params.minFee, `fee must be >= ${params.minFee}`)
      ) {
        return;
      }
    }

    // get the price token params
    const token = await api.db.findOneInTable("tokens", "tokens", {
      symbol: priceSymbol,
    });
    if (
      api.assert(
        token &&
          api.BigNumber(price).gt(0) &&
          countDecimals(price) <= token.precision,
        "invalid price"
      )
    ) {
      // lock the NFTs to sell by moving them to this contract for safekeeping
      const nftArray = [];
      const wrappedNfts = {
        symbol,
        ids: nfts,
      };
      nftArray.push(wrappedNfts);
      const res = await api.executeSmartContract("nft", "transfer", {
        fromType: "user",
        to: CONTRACT_NAME,
        toType: "contract",
        nfts: nftArray,
        isSignedWithActiveKey,
      });

      // it's possible that some transfers could have failed due to validation
      // errors & whatnot, so we need to loop over the transfer results and
      // only create market orders for the transfers that succeeded
      if (res.events) {
        const blockDate = new Date(`${api.steemBlockTimestamp}.000Z`);
        const timestamp = blockDate.getTime();
        const finalPrice = api.BigNumber(price).toFixed(token.precision);
        const nftIntegerIdList = [];
        const orderDataMap = {};

        for (let i = 0; i < res.events.length; i += 1) {
          const ev = res.events[i];
          if (
            ev.contract &&
            ev.event &&
            ev.data &&
            ev.contract === "nft" &&
            ev.event === "transfer" &&
            ev.data.from === api.sender &&
            ev.data.fromType === "u" &&
            ev.data.to === CONTRACT_NAME &&
            ev.data.toType === "c" &&
            ev.data.symbol === symbol
          ) {
            // transfer is verified, now we can add a market order
            const instanceId = ev.data.id;

            const orderData = {
              nftId: instanceId,
              grouping: {},
              groupingKey: "",
            };
            const integerId = api.BigNumber(instanceId).toNumber();
            nftIntegerIdList.push(integerId);
            orderDataMap[integerId] = orderData;
          }
        }

        // query NFT instances to construct the grouping
        const instances = await api.db.findInTable(
          "nft",
          instanceTableName,
          {
            _id: {
              $in: nftIntegerIdList,
            },
          },
          MAX_NUM_UNITS_OPERABLE,
          0,
          [{ index: "_id", descending: false }]
        );

        for (let j = 0; j < instances.length; j += 1) {
          const instance = instances[j];
          const grouping = {};
          let groupingKey = "";
          nft.groupBy.forEach((name) => {
            if (
              instance.properties[name] !== undefined &&
              instance.properties[name] !== null
            ) {
              grouping[name] = instance.properties[name].toString();
            } else {
              grouping[name] = "";
            }
            groupingKey = groupingKey + ":" + name + ":" + grouping[name];
          });
          orderDataMap[instance._id].grouping = grouping;
          orderDataMap[instance._id].groupingKey = groupingKey;
        }

        // create the orders
        const groupingMap = {};
        for (let k = 0; k < nftIntegerIdList.length; k += 1) {
          const intId = nftIntegerIdList[k];
          const orderInfo = orderDataMap[intId];
          const order = {
            account: api.sender,
            ownedBy: "u",
            nftId: orderInfo.nftId,
            grouping: orderInfo.grouping,
            timestamp,
            price: finalPrice,
            priceDec: { $numberDecimal: finalPrice },
            priceSymbol,
            fee,
          };

          const result = await api.db.insert(marketTableName, order);

          api.emit("sellOrder", {
            account: order.account,
            ownedBy: order.ownedBy,
            symbol,
            nftId: order.nftId,
            timestamp,
            price: order.price,
            priceSymbol: order.priceSymbol,
            fee,
            orderId: result._id,
          });

          const groupInfo =
            orderInfo.groupingKey in groupingMap
              ? groupingMap[orderInfo.groupingKey]
              : {
                  grouping: orderInfo.grouping,
                  isInCollection: false,
                  count: 0,
                };
          groupInfo.count += 1;
          groupingMap[orderInfo.groupingKey] = groupInfo;
        }

        // update open interest metrics
        await updateOpenInterest(
          "sell",
          symbol,
          priceSymbol,
          groupingMap,
          nft.groupBy
        );
      }
    }
  }
};
