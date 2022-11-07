const SMT_PRECISION = 10,
  MAX_VOTING_POWER = 1e4,
  MAX_WEIGHT = 1e4;
function calculateWeightRshares(rewardPool, voteRshareSum) {
  if (api.BigNumber(voteRshareSum).lte(0)) return api.BigNumber(0);
  if ("power" === rewardPool.config.postRewardCurve) {
    const postRewardExponent = api.BigNumber(
      rewardPool.config.postRewardCurveParameter
    );
    return postRewardExponent.eq("1") || postRewardExponent.eq("2")
      ? api
          .BigNumber(voteRshareSum)
          .pow(rewardPool.config.postRewardCurveParameter)
          .toFixed(10, api.BigNumber.ROUND_DOWN)
      : api
          .BigNumber(
            parseFloat(voteRshareSum) **
              parseFloat(rewardPool.config.postRewardCurveParameter)
          )
          .toFixed(10, api.BigNumber.ROUND_DOWN);
  }
  return api.BigNumber(voteRshareSum);
}
function calculateCurationWeightRshares(rewardPool, voteRshareSum) {
  if (api.BigNumber(voteRshareSum).lte(0)) return api.BigNumber(0);
  if ("power" === rewardPool.config.curationRewardCurve) {
    const curationRewardExponent = api.BigNumber(
      rewardPool.config.curationRewardCurveParameter
    );
    return curationRewardExponent.eq("0.5")
      ? api
          .BigNumber(voteRshareSum)
          .sqrt()
          .toFixed(10, api.BigNumber.ROUND_DOWN)
      : curationRewardExponent.eq("1")
      ? api.BigNumber(voteRshareSum).toFixed(10, api.BigNumber.ROUND_DOWN)
      : api
          .BigNumber(
            parseFloat(voteRshareSum) **
              parseFloat(rewardPool.config.curationRewardCurveParameter)
          )
          .toFixed(10, api.BigNumber.ROUND_DOWN);
  }
  return api.BigNumber(voteRshareSum);
}
async function payUser(symbol, quantity, user, stakedRewardPercentage, mute) {
  if (mute) return;
  const quantityBignum = api.BigNumber(quantity),
    stakedQuantity = quantityBignum
      .multipliedBy(stakedRewardPercentage)
      .dividedBy(100)
      .toFixed(quantityBignum.dp(), api.BigNumber.ROUND_DOWN),
    liquidQuantity = quantityBignum
      .minus(stakedQuantity)
      .toFixed(quantityBignum.dp(), api.BigNumber.ROUND_DOWN);
  let res;
  api.BigNumber(liquidQuantity).gt(0) &&
    ((res = await api.transferTokens(user, symbol, liquidQuantity, "user")),
    res.errors &&
      api.debug(
        `Error paying out liquid ${liquidQuantity} ${symbol} to ${user} (TXID ${api.transactionId}): \n${res.errors}`
      )),
    api.BigNumber(stakedQuantity).gt(0) &&
      ((res = await api.executeSmartContract("tokens", "stakeFromContract", {
        to: user,
        symbol: symbol,
        quantity: stakedQuantity,
      })),
      res.errors &&
        api.debug(
          `Error paying out staked ${stakedQuantity} ${symbol} to ${user} (TXID ${api.transactionId}): \n${res.errors}`
        ));
}
async function getMute(rewardPoolId, account) {
  const votingPower = await api.db.findOne("votingPower", {
    rewardPoolId: rewardPoolId,
    account: account,
  });
  return !!votingPower && votingPower.mute;
}
async function payOutBeneficiaries(rewardPool, token, post, authorBenePortion) {
  const {
    authorperm: authorperm,
    symbol: symbol,
    rewardPoolId: rewardPoolId,
    beneficiaries: beneficiaries,
  } = post;
  if (!beneficiaries || 0 === beneficiaries.length) return api.BigNumber(0);
  let totalBenePay = api.BigNumber(0);
  for (let i = 0; i < beneficiaries.length; i += 1) {
    const beneficiary = beneficiaries[i],
      benePay = api
        .BigNumber(authorBenePortion)
        .multipliedBy(beneficiary.weight)
        .dividedBy(1e4)
        .toFixed(token.precision, api.BigNumber.ROUND_DOWN),
      mute = await getMute(rewardPoolId, beneficiary.account),
      rewardLog = {
        rewardPoolId: rewardPoolId,
        authorperm: authorperm,
        symbol: symbol,
        account: beneficiary.account,
        quantity: benePay,
      };
    mute && (rewardLog.mute = !0),
      api.emit("beneficiaryReward", rewardLog),
      await payUser(
        symbol,
        benePay,
        beneficiary.account,
        rewardPool.config.stakedRewardPercentage,
        mute
      ),
      (totalBenePay = api.BigNumber(totalBenePay).plus(benePay));
  }
  return totalBenePay;
}
async function payOutCurators(rewardPool, token, post, curatorPortion, params) {
  const {
      authorperm: authorperm,
      symbol: symbol,
      rewardPoolId: rewardPoolId,
    } = post,
    { voteQueryLimit: voteQueryLimit } = params,
    response = { done: !1, votesProcessed: 0 },
    votesToPayout = await api.db.find(
      "votes",
      { rewardPoolId: rewardPoolId, authorperm: authorperm },
      voteQueryLimit,
      0,
      [{ index: "byTimestamp", descending: !1 }]
    );
  if (0 === votesToPayout.length) response.done = !0;
  else {
    for (let i = 0; i < votesToPayout.length; i += 1) {
      const vote = votesToPayout[i];
      if (api.BigNumber(vote.curationWeight) > 0) {
        const totalCurationWeight = calculateCurationWeightRshares(
            rewardPool,
            post.votePositiveRshareSum
          ),
          votePay = api
            .BigNumber(curatorPortion)
            .multipliedBy(vote.curationWeight)
            .dividedBy(totalCurationWeight)
            .toFixed(token.precision, api.BigNumber.ROUND_DOWN),
          mute = await getMute(rewardPoolId, vote.voter),
          rewardLog = {
            rewardPoolId: rewardPoolId,
            authorperm: authorperm,
            symbol: symbol,
            account: vote.voter,
            quantity: votePay,
          };
        mute && (rewardLog.mute = !0),
          api.emit("curationReward", rewardLog),
          await payUser(
            symbol,
            votePay,
            vote.voter,
            rewardPool.config.stakedRewardPercentage,
            mute
          );
      }
      await api.db.remove("votes", vote);
    }
    (response.votesProcessed += votesToPayout.length),
      votesToPayout.length < voteQueryLimit && (response.done = !0);
  }
  return response;
}
async function payOutPost(rewardPool, token, post, params) {
  const response = { totalPayoutValue: 0, votesProcessed: 0, done: !1 };
  if (post.declinePayout)
    return (
      api.emit("authorReward", {
        rewardPoolId: post.rewardPoolId,
        authorperm: post.authorperm,
        symbol: post.symbol,
        account: post.author,
        quantity: "0",
      }),
      (response.done = !0),
      await api.db.remove("posts", post),
      response
    );
  const postClaims = calculateWeightRshares(rewardPool, post.voteRshareSum),
    postPendingToken = api.BigNumber(rewardPool.intervalPendingClaims).gt(0)
      ? api
          .BigNumber(rewardPool.intervalRewardPool)
          .multipliedBy(postClaims)
          .dividedBy(rewardPool.intervalPendingClaims)
          .toFixed(token.precision, api.BigNumber.ROUND_DOWN)
      : "0";
  response.totalPayoutValue = postPendingToken;
  const curatorPortion = api
      .BigNumber(postPendingToken)
      .multipliedBy(rewardPool.config.curationRewardPercentage)
      .dividedBy(100)
      .toFixed(token.precision, api.BigNumber.ROUND_DOWN),
    authorBenePortion = api
      .BigNumber(postPendingToken)
      .minus(curatorPortion)
      .toFixed(token.precision, api.BigNumber.ROUND_DOWN),
    beneficiariesPayoutValue = await payOutBeneficiaries(
      rewardPool,
      token,
      post,
      authorBenePortion
    ),
    authorPortion = api
      .BigNumber(authorBenePortion)
      .minus(beneficiariesPayoutValue)
      .toFixed(token.precision, api.BigNumber.ROUND_DOWN),
    curatorPayStatus = await payOutCurators(
      rewardPool,
      token,
      post,
      curatorPortion,
      params
    );
  if (
    ((response.votesProcessed += curatorPayStatus.votesProcessed),
    (response.done = curatorPayStatus.done),
    curatorPayStatus.done)
  ) {
    const mute = await getMute(post.rewardPoolId, post.author),
      rewardLog = {
        rewardPoolId: post.rewardPoolId,
        authorperm: post.authorperm,
        symbol: post.symbol,
        account: post.author,
        quantity: authorPortion,
      };
    mute && (rewardLog.mute = !0),
      api.emit("authorReward", rewardLog),
      await payUser(
        post.symbol,
        authorPortion,
        post.author,
        rewardPool.config.stakedRewardPercentage,
        mute
      ),
      await api.db.remove("posts", post);
  }
  return response;
}
async function computePostRewards(params, rewardPool, token, endTimestamp) {
  const { lastClaimDecayTimestamp: lastClaimDecayTimestamp } = rewardPool,
    {
      maxPostsProcessedPerRound: maxPostsProcessedPerRound,
      maxVotesProcessedPerRound: maxVotesProcessedPerRound,
    } = params,
    postsToPayout = await api.db.find(
      "posts",
      {
        rewardPoolId: rewardPool._id,
        cashoutTime: { $gte: lastClaimDecayTimestamp, $lte: endTimestamp },
      },
      maxPostsProcessedPerRound,
      0,
      [
        { index: "byCashoutTime", descending: !1 },
        { index: "_id", descending: !1 },
      ]
    );
  let done = !1,
    deductFromRewardPool = api.BigNumber(0),
    votesProcessed = 0;
  if (postsToPayout && postsToPayout.length > 0) {
    let limitReached = !1;
    for (let i = 0; i < postsToPayout.length; i += 1) {
      const post = postsToPayout[i],
        postPayoutResponse = await payOutPost(rewardPool, token, post, params),
        { totalPayoutValue: totalPayoutValue } = postPayoutResponse;
      if (
        ((votesProcessed += postPayoutResponse.votesProcessed),
        postPayoutResponse.done &&
          (deductFromRewardPool = deductFromRewardPool.plus(totalPayoutValue)),
        !postPayoutResponse.done || votesProcessed >= maxVotesProcessedPerRound)
      ) {
        limitReached = !0;
        break;
      }
    }
    !limitReached &&
      postsToPayout.length < maxPostsProcessedPerRound &&
      (done = !0),
      (rewardPool.rewardPool = api
        .BigNumber(rewardPool.rewardPool)
        .minus(deductFromRewardPool)
        .toFixed(token.precision, api.BigNumber.ROUND_DOWN));
  } else done = !0;
  done && (rewardPool.lastClaimDecayTimestamp = endTimestamp);
}
async function postClaimsInInterval(params, rewardPool, start, end) {
  const { maxPostsProcessedPerRound: maxPostsProcessedPerRound } = params;
  let postOffset = 0,
    newPendingClaims = api.BigNumber(0),
    postsToPayout = await api.db.find(
      "posts",
      { rewardPoolId: rewardPool._id, cashoutTime: { $gte: start, $lte: end } },
      maxPostsProcessedPerRound,
      postOffset,
      [
        { index: "byCashoutTime", descending: !1 },
        { index: "_id", descending: !1 },
      ]
    );
  for (
    ;
    postsToPayout &&
    postsToPayout.length > 0 &&
    ((newPendingClaims = newPendingClaims
      .plus(
        postsToPayout.reduce(
          (x, y) => x.plus(calculateWeightRshares(rewardPool, y.voteRshareSum)),
          api.BigNumber(0)
        )
      )
      .dp(10, api.BigNumber.ROUND_DOWN)),
    !(postsToPayout.length < maxPostsProcessedPerRound));

  )
    (postOffset += maxPostsProcessedPerRound),
      (postsToPayout = await api.db.find(
        "posts",
        {
          rewardPoolId: rewardPool._id,
          cashoutTime: { $gte: start, $lte: end },
        },
        maxPostsProcessedPerRound,
        postOffset,
        [
          { index: "byCashoutTime", descending: !1 },
          { index: "_id", descending: !1 },
        ]
      ));
  return newPendingClaims;
}
async function tokenMaintenance() {
  const timestamp = new Date(api.steemBlockTimestamp + ".000Z").getTime(),
    params = await api.db.findOne("params", {}),
    {
      lastMaintenanceBlock: lastMaintenanceBlock,
      lastProcessedPoolId: lastProcessedPoolId,
      maintenanceTokensPerBlock: maintenanceTokensPerBlock,
    } = params;
  if (lastMaintenanceBlock >= api.blockNumber) return;
  params.lastMaintenanceBlock = api.blockNumber;
  const rewardPoolProcessingExpression = {
    $lte: [
      "$lastClaimDecayTimestamp",
      {
        $subtract: [
          timestamp,
          { $multiply: ["$config.rewardIntervalSeconds", 1e3] },
        ],
      },
    ],
  };
  let rewardPools = await api.db.find(
    "rewardPools",
    {
      active: !0,
      $expr: rewardPoolProcessingExpression,
      _id: { $gt: lastProcessedPoolId },
    },
    maintenanceTokensPerBlock,
    0,
    [{ index: "_id", descending: !1 }]
  );
  if (!rewardPools || rewardPools.length < maintenanceTokensPerBlock) {
    rewardPools || (rewardPools = []);
    const moreRewardPools = await api.db.find(
        "rewardPools",
        { active: !0, $expr: rewardPoolProcessingExpression },
        maintenanceTokensPerBlock - rewardPools.length,
        0,
        [{ index: "_id", descending: !1 }]
      ),
      existingIds = new Set(rewardPools.map((p) => p._id));
    moreRewardPools.forEach((mrp) => {
      existingIds.has(mrp._id) || rewardPools.push(mrp);
    });
  }
  if (rewardPools)
    for (let i = 0; i < rewardPools.length; i += 1) {
      const rewardPool = rewardPools[i];
      params.lastProcessedPoolId = rewardPool._id;
      const {
          symbol: symbol,
          lastClaimDecayTimestamp: lastClaimDecayTimestamp,
          lastRewardTimestamp: lastRewardTimestamp,
          config: config,
        } = rewardPool,
        {
          rewardIntervalSeconds: rewardIntervalSeconds,
          rewardPerInterval: rewardPerInterval,
          cashoutWindowDays: cashoutWindowDays,
        } = config,
        token = await api.db.findOneInTable("tokens", "tokens", {
          symbol: symbol,
        }),
        rewardIntervalDurationMillis = 1e3 * rewardIntervalSeconds,
        nextRewardTimestamp =
          lastRewardTimestamp + rewardIntervalDurationMillis,
        nextClaimDecayTimestamp =
          lastClaimDecayTimestamp + rewardIntervalDurationMillis;
      if (nextClaimDecayTimestamp >= nextRewardTimestamp) {
        const rewardToAdd = api.BigNumber(rewardPerInterval);
        api.BigNumber(rewardToAdd).gt(0) &&
          (await api.executeSmartContract("tokens", "issueToContract", {
            symbol: rewardPool.symbol,
            quantity: rewardToAdd,
            to: "comments",
            isSignedWithActiveKey: !0,
          }),
          (rewardPool.rewardPool = api
            .BigNumber(rewardPool.rewardPool)
            .plus(rewardToAdd)
            .toFixed(token.precision, api.BigNumber.ROUND_DOWN)));
        const adjustNumer = nextRewardTimestamp - lastRewardTimestamp,
          adjustDenom = 24 * (2 * cashoutWindowDays + 1) * 3600 * 1e3;
        (rewardPool.pendingClaims = api
          .BigNumber(rewardPool.pendingClaims)
          .minus(
            api
              .BigNumber(rewardPool.pendingClaims)
              .multipliedBy(adjustNumer)
              .dividedBy(adjustDenom)
          )
          .toFixed(10, api.BigNumber.ROUND_DOWN)),
          (rewardPool.pendingClaims = api
            .BigNumber(rewardPool.pendingClaims)
            .plus(
              await postClaimsInInterval(
                params,
                rewardPool,
                lastRewardTimestamp,
                nextRewardTimestamp
              )
            )
            .toFixed(10, api.BigNumber.ROUND_DOWN)),
          (rewardPool.lastRewardTimestamp = nextRewardTimestamp),
          (rewardPool.intervalPendingClaims = rewardPool.pendingClaims),
          (rewardPool.intervalRewardPool = rewardPool.rewardPool);
      }
      await computePostRewards(
        params,
        rewardPool,
        token,
        nextClaimDecayTimestamp
      ),
        await api.db.update("rewardPools", rewardPool);
    }
  await api.db.update("params", params);
}
async function getRewardPoolIds(payload) {
  const {
      rewardPools: rewardPools,
      jsonMetadata: jsonMetadata,
      parentAuthor: parentAuthor,
      parentPermlink: parentPermlink,
    } = payload,
    params = await api.db.findOne("params", {});
  if (parentAuthor && parentPermlink) {
    const parentAuthorperm = `@${parentAuthor}/${parentPermlink}`,
      parentPosts = await api.db.find("posts", {
        authorperm: parentAuthorperm,
      });
    return parentPosts && parentPosts.length > 0
      ? parentPosts.map((p) => p.rewardPoolId)
      : [];
  }
  if (
    jsonMetadata &&
    jsonMetadata.tags &&
    Array.isArray(jsonMetadata.tags) &&
    jsonMetadata.tags.every((t) => "string" == typeof t)
  ) {
    const searchTags = parentPermlink
        ? jsonMetadata.tags.concat([parentPermlink])
        : jsonMetadata.tags,
      tagRewardPools = await api.db.find(
        "rewardPools",
        { "config.tags": { $in: searchTags } },
        params.maxPoolsPerPost,
        0,
        [{ index: "_id", descending: !1 }]
      );
    if (tagRewardPools && tagRewardPools.length > 0)
      return tagRewardPools.map((r) => r._id);
  }
  return rewardPools && Array.isArray(rewardPools) && rewardPools.length > 0
    ? rewardPools.slice(0, params.maxPoolsPerPost)
    : [];
}
async function processVote(post, voter, weight, timestamp) {
  const {
    rewardPoolId: rewardPoolId,
    symbol: symbol,
    authorperm: authorperm,
    cashoutTime: cashoutTime,
  } = post;
  if (cashoutTime < timestamp) return;
  const rewardPool = await api.db.findOne("rewardPools", { _id: rewardPoolId });
  if (!rewardPool || !rewardPool.active) return;
  let votingPower = await api.db.findOne("votingPower", {
    rewardPoolId: rewardPoolId,
    account: voter,
  });
  votingPower
    ? ((votingPower.votingPower +=
        (1e4 * (timestamp - votingPower.lastVoteTimestamp)) /
        (24 * rewardPool.config.voteRegenerationDays * 3600 * 1e3)),
      (votingPower.votingPower = Math.floor(votingPower.votingPower)),
      (votingPower.votingPower = Math.min(votingPower.votingPower, 1e4)),
      (votingPower.downvotingPower +=
        (1e4 * (timestamp - votingPower.lastVoteTimestamp)) /
        (24 * rewardPool.config.downvoteRegenerationDays * 3600 * 1e3)),
      (votingPower.downvotingPower = Math.floor(votingPower.downvotingPower)),
      (votingPower.downvotingPower = Math.min(
        votingPower.downvotingPower,
        1e4
      )),
      (votingPower.lastVoteTimestamp = timestamp))
    : ((votingPower = {
        rewardPoolId: rewardPoolId,
        account: voter,
        lastVoteTimestamp: timestamp,
        votingPower: 1e4,
        downvotingPower: 1e4,
      }),
      (votingPower = await api.db.insert("votingPower", votingPower)));
  const voterTokenBalance = await api.db.findOneInTable("tokens", "balances", {
    symbol: symbol,
    account: voter,
  });
  let stake = voterTokenBalance ? voterTokenBalance.stake : "0";
  voterTokenBalance &&
    voterTokenBalance.delegationsIn &&
    api.BigNumber(voterTokenBalance.delegationsIn).isFinite() &&
    (stake = api.BigNumber(stake).plus(voterTokenBalance.delegationsIn));
  let voteRshares = "0",
    updatedPostRshares = "0",
    usedPower = 0,
    usedDownvotePower = 0,
    curationWeight = "0";
  if (weight > 0) {
    (voteRshares = api
      .BigNumber(stake)
      .multipliedBy(weight)
      .multipliedBy(votingPower.votingPower)
      .dividedBy(1e4)
      .dividedBy(1e4)
      .toFixed(10, api.BigNumber.ROUND_DOWN)),
      (usedPower = Math.floor(
        (votingPower.votingPower * Math.abs(weight) * 60 * 60 * 24) / 1e4
      ));
    const usedPowerDenom = Math.floor(
      864e6 / rewardPool.config.votePowerConsumption
    );
    (usedPower = Math.floor((usedPower + usedPowerDenom - 1) / usedPowerDenom)),
      (votingPower.votingPower = Math.max(
        0,
        Math.floor(votingPower.votingPower - usedPower)
      )),
      (curationWeight = api
        .BigNumber(
          calculateCurationWeightRshares(
            rewardPool,
            api.BigNumber(voteRshares).plus(post.votePositiveRshareSum)
          )
        )
        .minus(
          calculateCurationWeightRshares(rewardPool, post.votePositiveRshareSum)
        )
        .toFixed(10, api.BigNumber.ROUND_DOWN));
  } else if (weight < 0) {
    (voteRshares = api
      .BigNumber(stake)
      .multipliedBy(weight)
      .multipliedBy(votingPower.downvotingPower)
      .dividedBy(1e4)
      .dividedBy(1e4)
      .toFixed(10, api.BigNumber.ROUND_DOWN)),
      (usedDownvotePower = Math.floor(
        (votingPower.downvotingPower * Math.abs(weight) * 60 * 60 * 24) / 1e4
      ));
    const usedDownvotePowerDenom = Math.floor(
      864e6 / rewardPool.config.downvotePowerConsumption
    );
    (usedDownvotePower = Math.floor(
      (usedDownvotePower + usedDownvotePowerDenom - 1) / usedDownvotePowerDenom
    )),
      (votingPower.downvotingPower = Math.max(
        0,
        Math.floor(votingPower.downvotingPower - usedDownvotePower)
      ));
  }
  votingPower.mute && ((voteRshares = "0"), (curationWeight = "0")),
    await api.db.update("votingPower", votingPower);
  let vote = await api.db.findOne("votes", {
    rewardPoolId: rewardPoolId,
    authorperm: authorperm,
    voter: voter,
  });
  if (vote) {
    (vote.timestamp = timestamp),
      (vote.weight = weight),
      (vote.curationWeight = "0");
    const oldVoteRshares = vote.rshares;
    (vote.rshares = voteRshares),
      (updatedPostRshares = api
        .BigNumber(voteRshares)
        .minus(oldVoteRshares)
        .toFixed(10, api.BigNumber.ROUND_DOWN)),
      await api.db.update("votes", vote);
    const voteLog = {
      rewardPoolId: rewardPoolId,
      symbol: rewardPool.symbol,
      rshares: voteRshares,
    };
    votingPower.mute && (voteLog.mute = !0), api.emit("updateVote", voteLog);
  } else {
    (vote = {
      rewardPoolId: rewardPoolId,
      symbol: symbol,
      authorperm: authorperm,
      weight: weight,
      rshares: voteRshares,
      curationWeight: curationWeight,
      timestamp: timestamp,
      voter: voter,
    }),
      (updatedPostRshares = voteRshares),
      await api.db.insert("votes", vote);
    const voteLog = {
      rewardPoolId: rewardPoolId,
      symbol: rewardPool.symbol,
      rshares: voteRshares,
    };
    votingPower.mute && (voteLog.mute = !0), api.emit("newVote", voteLog);
  }
  const oldPostClaims = calculateWeightRshares(rewardPool, post.voteRshareSum);
  if (
    ((post.voteRshareSum = api
      .BigNumber(post.voteRshareSum)
      .plus(updatedPostRshares)
      .toFixed(10, api.BigNumber.ROUND_DOWN)),
    api.BigNumber(updatedPostRshares).gt(0) &&
      ((post.votePositiveRshareSum = api
        .BigNumber(post.votePositiveRshareSum)
        .plus(updatedPostRshares)
        .toFixed(10, api.BigNumber.ROUND_DOWN)),
      timestamp <
        rewardPool.createdTimestamp +
          24 * (2 * rewardPool.config.cashoutWindowDays + 1) * 3600 * 1e3))
  ) {
    const newPostClaims = calculateWeightRshares(
      rewardPool,
      post.voteRshareSum
    );
    (rewardPool.pendingClaims = api
      .BigNumber(rewardPool.pendingClaims)
      .plus(newPostClaims)
      .minus(oldPostClaims)
      .toFixed(10, api.BigNumber.ROUND_DOWN)),
      await api.db.update("rewardPools", rewardPool);
  }
  await api.db.update("posts", post);
}
(actions.createSSC = async () => {
  if (!1 === (await api.db.tableExists("rewardPools"))) {
    await api.db.createTable("params"),
      await api.db.createTable("rewardPools", [
        "config.tags",
        "lastClaimDecayTimestamp",
      ]),
      await api.db.createTable(
        "posts",
        [
          "authorperm",
          { name: "byCashoutTime", index: { rewardPoolId: 1, cashoutTime: 1 } },
        ],
        { primaryKey: ["authorperm", "rewardPoolId"] }
      ),
      await api.db.createTable(
        "votes",
        [
          {
            name: "byTimestamp",
            index: { rewardPoolId: 1, authorperm: 1, timestamp: 1 },
          },
        ],
        { primaryKey: ["rewardPoolId", "authorperm", "voter"] }
      ),
      await api.db.createTable("votingPower", [], {
        primaryKey: ["rewardPoolId", "account"],
      });
    const params = {
      setupFee: "1000",
      updateFee: "20",
      maxPoolsPerPost: 20,
      maxTagsPerPool: 5,
      maintenanceTokensPerBlock: 2,
      lastMaintenanceBlock: api.blockNumber,
      maxPostsProcessedPerRound: 20,
      voteQueryLimit: 100,
      maxVotesProcessedPerRound: 100,
      lastProcessedPoolId: 0,
    };
    await api.db.insert("params", params);
  }
}),
  (actions.updateParams = async (payload) => {
    if (api.sender !== api.owner) return;
    const {
        setupFee: setupFee,
        updateFee: updateFee,
        maintenanceTokensPerBlock: maintenanceTokensPerBlock,
        maxPostsProcessedPerRound: maxPostsProcessedPerRound,
        maxVotesProcessedPerRound: maxVotesProcessedPerRound,
        voteQueryLimit: voteQueryLimit,
      } = payload,
      params = await api.db.findOne("params", {});
    if (setupFee) {
      if (
        !api.assert(
          "string" == typeof setupFee &&
            !api.BigNumber(setupFee).isNaN() &&
            api.BigNumber(setupFee).gte(0),
          "invalid setupFee"
        )
      )
        return;
      params.setupFee = setupFee;
    }
    if (updateFee) {
      if (
        !api.assert(
          "string" == typeof updateFee &&
            !api.BigNumber(updateFee).isNaN() &&
            api.BigNumber(updateFee).gte(0),
          "invalid updateFee"
        )
      )
        return;
      params.updateFee = updateFee;
    }
    if (maintenanceTokensPerBlock) {
      if (
        !api.assert(
          Number.isInteger(maintenanceTokensPerBlock) &&
            maintenanceTokensPerBlock >= 1,
          "invalid maintenanceTokensPerBlock"
        )
      )
        return;
      params.maintenanceTokensPerBlock = maintenanceTokensPerBlock;
    }
    if (maxPostsProcessedPerRound) {
      if (
        !api.assert(
          Number.isInteger(maxPostsProcessedPerRound) &&
            maxPostsProcessedPerRound >= 1,
          "invalid maxPostsProcessedPerRound"
        )
      )
        return;
      params.maxPostsProcessedPerRound = maxPostsProcessedPerRound;
    }
    if (maxVotesProcessedPerRound) {
      if (
        !api.assert(
          Number.isInteger(maxVotesProcessedPerRound) &&
            maxVotesProcessedPerRound >= 1,
          "invalid maxVotesProcessedPerRound"
        )
      )
        return;
      params.maxVotesProcessedPerRound = maxVotesProcessedPerRound;
    }
    if (voteQueryLimit) {
      if (
        !api.assert(
          Number.isInteger(voteQueryLimit) && voteQueryLimit >= 1,
          "invalid voteQueryLimit"
        )
      )
        return;
      params.voteQueryLimit = voteQueryLimit;
    }
    await api.db.update("params", params);
  }),
  (actions.createRewardPool = async (payload) => {
    const {
      symbol: symbol,
      config: config,
      isSignedWithActiveKey: isSignedWithActiveKey,
    } = payload;
    if (
      !api.assert(
        !0 === isSignedWithActiveKey,
        "operation must be signed with your active key"
      )
    )
      return;
    const params = await api.db.findOne("params", {}),
      { setupFee: setupFee, maxTagsPerPool: maxTagsPerPool } = params,
      utilityTokenBalance = await api.db.findOneInTable("tokens", "balances", {
        account: api.sender,
        symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'",
      }),
      authorizedCreation =
        !(!api.BigNumber(setupFee).lte(0) && api.sender !== api.owner) ||
        (utilityTokenBalance &&
          api.BigNumber(utilityTokenBalance.balance).gte(setupFee));
    if (
      !api.assert(
        authorizedCreation,
        "you must have enough tokens to cover the creation fee"
      )
    )
      return;
    const token = await api.db.findOneInTable("tokens", "tokens", {
      symbol: symbol,
    });
    if (!api.assert(token, "token not found")) return;
    if (!api.assert(config && "object" == typeof config, "config invalid"))
      return;
    const {
      postRewardCurve: postRewardCurve,
      postRewardCurveParameter: postRewardCurveParameter,
      curationRewardCurve: curationRewardCurve,
      curationRewardCurveParameter: curationRewardCurveParameter,
      curationRewardPercentage: curationRewardPercentage,
      cashoutWindowDays: cashoutWindowDays,
      rewardPerInterval: rewardPerInterval,
      rewardIntervalSeconds: rewardIntervalSeconds,
      voteRegenerationDays: voteRegenerationDays,
      downvoteRegenerationDays: downvoteRegenerationDays,
      stakedRewardPercentage: stakedRewardPercentage,
      votePowerConsumption: votePowerConsumption,
      downvotePowerConsumption: downvotePowerConsumption,
      tags: tags,
    } = config;
    if (
      !api.assert(
        postRewardCurve && "power" === postRewardCurve,
        "postRewardCurve should be one of: [power]"
      )
    )
      return;
    const postExponent = api.BigNumber(postRewardCurveParameter);
    if (
      !api.assert(
        "string" == typeof postRewardCurveParameter &&
          postExponent.isFinite() &&
          postExponent.gte("1") &&
          postExponent.lte("2") &&
          postExponent.dp() <= 2,
        'postRewardCurveParameter should be between "1" and "2" with precision at most 2'
      )
    )
      return;
    if (
      !api.assert(
        curationRewardCurve && "power" === curationRewardCurve,
        "curationRewardCurve should be one of: [power]"
      )
    )
      return;
    const curationExponent = api.BigNumber(curationRewardCurveParameter);
    if (
      !api.assert(
        "string" == typeof curationRewardCurveParameter &&
          curationExponent.isFinite() &&
          curationExponent.gte("0.5") &&
          curationExponent.lte("1") &&
          curationExponent.dp() <= 2,
        'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2'
      )
    )
      return;
    if (
      !api.assert(
        Number.isInteger(curationRewardPercentage) &&
          curationRewardPercentage >= 0 &&
          curationRewardPercentage <= 100,
        "curationRewardPercentage should be an integer between 0 and 100"
      )
    )
      return;
    if (
      !api.assert(
        cashoutWindowDays &&
          Number.isInteger(cashoutWindowDays) &&
          cashoutWindowDays >= 1 &&
          cashoutWindowDays <= 30,
        "cashoutWindowDays should be an integer between 1 and 30"
      )
    )
      return;
    const parsedRewardPerInterval = api.BigNumber(rewardPerInterval);
    if (
      !api.assert(
        "string" == typeof rewardPerInterval &&
          parsedRewardPerInterval.isFinite() &&
          parsedRewardPerInterval.gt(0),
        "rewardPerInterval invalid"
      ) ||
      !api.assert(
        parsedRewardPerInterval.dp() <= token.precision,
        "token precision mismatch for rewardPerInterval"
      )
    )
      return;
    if (
      !api.assert(
        rewardIntervalSeconds &&
          Number.isInteger(rewardIntervalSeconds) &&
          rewardIntervalSeconds >= 3 &&
          rewardIntervalSeconds <= 86400 &&
          rewardIntervalSeconds % 3 == 0,
        "rewardIntervalSeconds should be an integer between 3 and 86400, and divisible by 3"
      )
    )
      return;
    if (
      !api.assert(
        voteRegenerationDays &&
          Number.isInteger(voteRegenerationDays) &&
          voteRegenerationDays >= 1 &&
          voteRegenerationDays <= 30,
        "voteRegenerationDays should be an integer between 1 and 30"
      )
    )
      return;
    if (
      !api.assert(
        downvoteRegenerationDays &&
          Number.isInteger(downvoteRegenerationDays) &&
          downvoteRegenerationDays >= 1 &&
          downvoteRegenerationDays <= 30,
        "downvoteRegenerationDays should be an integer between 1 and 30"
      )
    )
      return;
    if (
      !api.assert(
        Number.isInteger(stakedRewardPercentage) &&
          stakedRewardPercentage >= 0 &&
          stakedRewardPercentage <= 100,
        "stakedRewardPercentage should be an integer between 0 and 100"
      )
    )
      return;
    if (
      !api.assert(
        votePowerConsumption &&
          Number.isInteger(votePowerConsumption) &&
          votePowerConsumption >= 1 &&
          votePowerConsumption <= 1e4,
        "votePowerConsumption should be an integer between 1 and 10000"
      )
    )
      return;
    if (
      !api.assert(
        downvotePowerConsumption &&
          Number.isInteger(downvotePowerConsumption) &&
          downvotePowerConsumption >= 1 &&
          downvotePowerConsumption <= 1e4,
        "downvotePowerConsumption should be an integer between 1 and 10000"
      )
    )
      return;
    if (
      !api.assert(
        Array.isArray(tags) &&
          tags.length >= 1 &&
          tags.length <= maxTagsPerPool &&
          tags.every((t) => "string" == typeof t),
        "tags should be a non-empty array of strings of length at most " +
          maxTagsPerPool
      )
    )
      return;
    if (
      !api.assert(
        api.sender === token.issuer ||
          (api.sender === api.owner &&
            "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" === token.symbol),
        "must be issuer of token"
      )
    )
      return;
    if (!api.assert(token.stakingEnabled, "token must have staking enabled"))
      return;
    const existingRewardPool = await api.db.findOne("rewardPools", {
      symbol: symbol,
    });
    if (
      !api.assert(
        !existingRewardPool,
        "cannot create multiple reward pools per token"
      )
    )
      return;
    const timestamp = new Date(api.steemBlockTimestamp + ".000Z").getTime(),
      rewardPool = {
        symbol: symbol,
        rewardPool: "0",
        lastRewardTimestamp: timestamp,
        lastClaimDecayTimestamp: timestamp,
        createdTimestamp: timestamp,
        config: {
          postRewardCurve: postRewardCurve,
          postRewardCurveParameter: postRewardCurveParameter,
          curationRewardCurve: curationRewardCurve,
          curationRewardCurveParameter: curationRewardCurveParameter,
          curationRewardPercentage: curationRewardPercentage,
          cashoutWindowDays: cashoutWindowDays,
          rewardPerInterval: rewardPerInterval,
          rewardIntervalSeconds: rewardIntervalSeconds,
          voteRegenerationDays: voteRegenerationDays,
          downvoteRegenerationDays: downvoteRegenerationDays,
          stakedRewardPercentage: stakedRewardPercentage,
          votePowerConsumption: votePowerConsumption,
          downvotePowerConsumption: downvotePowerConsumption,
          tags: tags,
        },
        pendingClaims: "0",
        active: !0,
      },
      insertedRewardPool = await api.db.insert("rewardPools", rewardPool);
    api.sender !== api.owner &&
      api.BigNumber(setupFee).gt(0) &&
      (await api.executeSmartContract("tokens", "transfer", {
        to: "null",
        symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'",
        quantity: setupFee,
        isSignedWithActiveKey: isSignedWithActiveKey,
      })),
      api.emit("createRewardPool", { _id: insertedRewardPool._id });
  }),
  (actions.updateRewardPool = async (payload) => {
    const {
      rewardPoolId: rewardPoolId,
      config: config,
      isSignedWithActiveKey: isSignedWithActiveKey,
    } = payload;
    if (
      !api.assert(
        !0 === isSignedWithActiveKey,
        "operation must be signed with your active key"
      )
    )
      return;
    const params = await api.db.findOne("params", {}),
      { updateFee: updateFee, maxTagsPerPool: maxTagsPerPool } = params,
      utilityTokenBalance = await api.db.findOneInTable("tokens", "balances", {
        account: api.sender,
        symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'",
      }),
      authorized =
        !(!api.BigNumber(updateFee).lte(0) && api.sender !== api.owner) ||
        (utilityTokenBalance &&
          api.BigNumber(utilityTokenBalance.balance).gte(updateFee));
    if (
      !api.assert(
        authorized,
        "you must have enough tokens to cover the update fee"
      )
    )
      return;
    if (!api.assert(config && "object" == typeof config, "config invalid"))
      return;
    const {
        postRewardCurve: postRewardCurve,
        postRewardCurveParameter: postRewardCurveParameter,
        curationRewardCurve: curationRewardCurve,
        curationRewardCurveParameter: curationRewardCurveParameter,
        curationRewardPercentage: curationRewardPercentage,
        cashoutWindowDays: cashoutWindowDays,
        rewardPerInterval: rewardPerInterval,
        rewardIntervalSeconds: rewardIntervalSeconds,
        voteRegenerationDays: voteRegenerationDays,
        downvoteRegenerationDays: downvoteRegenerationDays,
        stakedRewardPercentage: stakedRewardPercentage,
        votePowerConsumption: votePowerConsumption,
        downvotePowerConsumption: downvotePowerConsumption,
        tags: tags,
      } = config,
      existingRewardPool = await api.db.findOne("rewardPools", {
        _id: rewardPoolId,
      });
    if (!api.assert(existingRewardPool, "reward pool not found")) return;
    const token = await api.db.findOneInTable("tokens", "tokens", {
      symbol: existingRewardPool.symbol,
    });
    if (
      !api.assert(
        postRewardCurve && "power" === postRewardCurve,
        "postRewardCurve should be one of: [power]"
      )
    )
      return;
    existingRewardPool.config.postRewardCurve = postRewardCurve;
    const postExponent = api.BigNumber(postRewardCurveParameter);
    if (
      !api.assert(
        "string" == typeof postRewardCurveParameter &&
          postExponent.isFinite() &&
          postExponent.gte("1") &&
          postExponent.lte("2") &&
          postExponent.dp() <= 2,
        'postRewardCurveParameter should be between "1" and "2" with precision at most 2'
      )
    )
      return;
    if (
      ((existingRewardPool.config.postRewardCurveParameter =
        postRewardCurveParameter),
      !api.assert(
        curationRewardCurve && "power" === curationRewardCurve,
        "curationRewardCurve should be one of: [power]"
      ))
    )
      return;
    const curationExponent = api.BigNumber(curationRewardCurveParameter);
    if (
      !api.assert(
        "string" == typeof curationRewardCurveParameter &&
          curationExponent.isFinite() &&
          curationExponent.gte("0.5") &&
          curationExponent.lte("1") &&
          curationExponent.dp() <= 2,
        'curationRewardCurveParameter can only be between "0.5" and "1" with precision at most 2'
      )
    )
      return;
    if (
      ((existingRewardPool.config.curationRewardCurveParameter =
        curationRewardCurveParameter),
      !api.assert(
        Number.isInteger(curationRewardPercentage) &&
          curationRewardPercentage >= 0 &&
          curationRewardPercentage <= 100,
        "curationRewardPercentage should be an integer between 0 and 100"
      ))
    )
      return;
    if (
      ((existingRewardPool.config.curationRewardPercentage =
        curationRewardPercentage),
      !api.assert(
        cashoutWindowDays &&
          Number.isInteger(cashoutWindowDays) &&
          cashoutWindowDays >= 1 &&
          cashoutWindowDays <= 30,
        "cashoutWindowDays should be an integer between 1 and 30"
      ))
    )
      return;
    existingRewardPool.config.cashoutWindowDays = cashoutWindowDays;
    const parsedRewardPerInterval = api.BigNumber(rewardPerInterval);
    api.assert(
      "string" == typeof rewardPerInterval &&
        parsedRewardPerInterval.isFinite() &&
        parsedRewardPerInterval.gt(0),
      "rewardPerInterval invalid"
    ) &&
      api.assert(
        parsedRewardPerInterval.dp() <= token.precision,
        "token precision mismatch for rewardPerInterval"
      ) &&
      ((existingRewardPool.config.rewardPerInterval = rewardPerInterval),
      api.assert(
        rewardIntervalSeconds &&
          Number.isInteger(rewardIntervalSeconds) &&
          rewardIntervalSeconds >= 3 &&
          rewardIntervalSeconds <= 86400 &&
          rewardIntervalSeconds % 3 == 0,
        "rewardIntervalSeconds should be an integer between 3 and 86400, and divisible by 3"
      ) &&
        ((existingRewardPool.config.rewardIntervalSeconds =
          rewardIntervalSeconds),
        api.assert(
          voteRegenerationDays &&
            Number.isInteger(voteRegenerationDays) &&
            voteRegenerationDays >= 1 &&
            voteRegenerationDays <= 30,
          "voteRegenerationDays should be an integer between 1 and 30"
        ) &&
          ((existingRewardPool.config.voteRegenerationDays =
            voteRegenerationDays),
          api.assert(
            downvoteRegenerationDays &&
              Number.isInteger(downvoteRegenerationDays) &&
              downvoteRegenerationDays >= 1 &&
              downvoteRegenerationDays <= 30,
            "downvoteRegenerationDays should be an integer between 1 and 30"
          ) &&
            ((existingRewardPool.config.downvoteRegenerationDays =
              downvoteRegenerationDays),
            api.assert(
              Number.isInteger(stakedRewardPercentage) &&
                stakedRewardPercentage >= 0 &&
                stakedRewardPercentage <= 100,
              "stakedRewardPercentage should be an integer between 0 and 100"
            ) &&
              ((existingRewardPool.config.stakedRewardPercentage =
                stakedRewardPercentage),
              api.assert(
                votePowerConsumption &&
                  Number.isInteger(votePowerConsumption) &&
                  votePowerConsumption >= 1 &&
                  votePowerConsumption <= 1e4,
                "votePowerConsumption should be an integer between 1 and 10000"
              ) &&
                ((existingRewardPool.config.votePowerConsumption =
                  votePowerConsumption),
                api.assert(
                  downvotePowerConsumption &&
                    Number.isInteger(downvotePowerConsumption) &&
                    downvotePowerConsumption >= 1 &&
                    downvotePowerConsumption <= 1e4,
                  "downvotePowerConsumption should be an integer between 1 and 10000"
                ) &&
                  ((existingRewardPool.config.downvotePowerConsumption =
                    downvotePowerConsumption),
                  api.assert(
                    Array.isArray(tags) &&
                      tags.length >= 1 &&
                      tags.length <= maxTagsPerPool &&
                      tags.every((t) => "string" == typeof t),
                    "tags should be a non-empty array of strings of length at most " +
                      maxTagsPerPool
                  ) &&
                    ((existingRewardPool.config.tags = tags),
                    api.assert(
                      api.sender === token.issuer ||
                        (api.sender === api.owner &&
                          "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'" ===
                            token.symbol),
                      "must be issuer of token"
                    ) &&
                      (api.sender !== api.owner &&
                        api.BigNumber(updateFee).gt(0) &&
                        (await api.executeSmartContract("tokens", "transfer", {
                          to: "null",
                          symbol: "'${CONSTANTS.UTILITY_TOKEN_SYMBOL}$'",
                          quantity: updateFee,
                          isSignedWithActiveKey: isSignedWithActiveKey,
                        })),
                      await api.db.update(
                        "rewardPools",
                        existingRewardPool
                      ))))))))));
  }),
  (actions.setActive = async (payload) => {
    const {
      rewardPoolId: rewardPoolId,
      active: active,
      isSignedWithActiveKey: isSignedWithActiveKey,
    } = payload;
    if (
      !api.assert(
        !0 === isSignedWithActiveKey,
        "operation must be signed with your active key"
      )
    )
      return;
    const existingRewardPool = await api.db.findOne("rewardPools", {
      _id: rewardPoolId,
    });
    if (!api.assert(existingRewardPool, "reward pool not found")) return;
    const token = await api.db.findOneInTable("tokens", "tokens", {
      symbol: existingRewardPool.symbol,
    });
    api.assert(
      api.sender === token.issuer || api.sender === api.owner,
      "must be issuer of token"
    ) &&
      ((existingRewardPool.active = active),
      await api.db.update("rewardPools", existingRewardPool));
  }),
  (actions.setMute = async (payload) => {
    const {
      rewardPoolId: rewardPoolId,
      account: account,
      mute: mute,
      isSignedWithActiveKey: isSignedWithActiveKey,
    } = payload;
    if (
      !api.assert(
        !0 === isSignedWithActiveKey,
        "operation must be signed with your active key"
      )
    )
      return;
    const existingRewardPool = await api.db.findOne("rewardPools", {
      _id: rewardPoolId,
    });
    if (!api.assert(existingRewardPool, "reward pool not found")) return;
    const token = await api.db.findOneInTable("tokens", "tokens", {
      symbol: existingRewardPool.symbol,
    });
    if (
      !api.assert(
        api.sender === token.issuer || api.sender === api.owner,
        "must be issuer of token"
      )
    )
      return;
    if (!api.assert(api.isValidAccountName(account), "invalid account")) return;
    if (!api.assert("boolean" == typeof mute, "mute must be a boolean")) return;
    const votingPower = await api.db.findOne("votingPower", {
      rewardPoolId: rewardPoolId,
      account: account,
    });
    if (votingPower)
      (votingPower.mute = mute),
        await api.db.update("votingPower", votingPower);
    else {
      const newVotingPower = {
        rewardPoolId: rewardPoolId,
        account: account,
        lastVoteTimestamp: new Date(
          api.steemBlockTimestamp + ".000Z"
        ).getTime(),
        votingPower: 1e4,
        downvotingPower: 1e4,
        mute: mute,
      };
      await api.db.insert("votingPower", newVotingPower);
    }
  }),
  (actions.comment = async (payload) => {
    const {
      author: author,
      permlink: permlink,
      rewardPools: rewardPools,
    } = payload;
    if (!api.assert("null" === api.sender, "action must use comment operation"))
      return;
    if (
      (await tokenMaintenance(),
      !api.assert(
        !rewardPools ||
          (Array.isArray(rewardPools) &&
            rewardPools.every((rp) => Number.isInteger(rp))),
        "rewardPools must be an array of integers"
      ))
    )
      return;
    const rewardPoolIds = await getRewardPoolIds(payload),
      authorperm = `@${author}/${permlink}`;
    if (await api.db.findOne("posts", { authorperm: authorperm })) return;
    const timestamp = new Date(api.steemBlockTimestamp + ".000Z").getTime();
    for (let i = 0; i < rewardPoolIds.length; i += 1) {
      const rewardPoolId = rewardPoolIds[i],
        rewardPool = await api.db.findOne("rewardPools", { _id: rewardPoolId });
      if (rewardPool && rewardPool.active) {
        const cashoutTime =
            timestamp + 24 * rewardPool.config.cashoutWindowDays * 3600 * 1e3,
          post = {
            rewardPoolId: rewardPoolId,
            symbol: rewardPool.symbol,
            authorperm: authorperm,
            author: author,
            created: timestamp,
            cashoutTime: cashoutTime,
            votePositiveRshareSum: "0",
            voteRshareSum: "0",
          };
        await api.db.insert("posts", post),
          api.emit("newComment", {
            rewardPoolId: rewardPoolId,
            symbol: rewardPool.symbol,
          });
      }
    }
  }),
  (actions.commentOptions = async (payload) => {
    const {
      author: author,
      permlink: permlink,
      maxAcceptedPayout: maxAcceptedPayout,
      beneficiaries: beneficiaries,
    } = payload;
    if (
      !api.assert(
        "null" === api.sender,
        "action must use commentOptions operation"
      )
    )
      return;
    const authorperm = `@${author}/${permlink}`,
      existingPosts = await api.db.find("posts", { authorperm: authorperm });
    if (!existingPosts) return;
    const declinePayout = maxAcceptedPayout.startsWith("0.000");
    for (let i = 0; i < existingPosts.length; i += 1) {
      const post = existingPosts[i];
      (post.declinePayout = declinePayout),
        (post.beneficiaries = beneficiaries),
        await api.db.update("posts", post);
    }
  }),
  (actions.vote = async (payload) => {
    const {
      voter: voter,
      author: author,
      permlink: permlink,
      weight: weight,
    } = payload;
    if (!api.assert("null" === api.sender, "can only vote with voting op"))
      return;
    if (
      (await tokenMaintenance(),
      !api.assert(
        Number.isInteger(weight) && weight >= -1e4 && weight <= 1e4,
        "weight must be an integer from -10000 to 10000"
      ))
    )
      return;
    const timestamp = new Date(api.steemBlockTimestamp + ".000Z").getTime(),
      authorperm = `@${author}/${permlink}`,
      posts = await api.db.find("posts", { authorperm: authorperm });
    if (posts)
      for (let i = 0; i < posts.length; i += 1) {
        const post = posts[i];
        await processVote(post, voter, weight, timestamp);
      }
  });
