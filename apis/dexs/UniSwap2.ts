import { Request, Response } from 'express';
import Web3 from 'web3';
import {
  MAX_UINT,
  priceImp,
  maxBuyFee,
  maxSellFee,
} from '../../config/const.ts';
import {
  nativeTokenAddress,
  routerAddress,
  ETHERMulticalladdress as multicallAddress,
  ownerAddress,
  nativeTokenToSell,
  maxgas,
  minNative,
} from '../../config/UniSwap2.ts';
import { ETHERprovider as provider } from '../../startConnection.ts';
import { routerAbi, tokenAbi, multicallAbi } from '../../abis/UniSwap2.ts';
import type {
  HoneypotStatus,
  NotHoneypotLowLiquidity,
  UnexpectedJsonError,
  ContractDontExistError,
  ResolvedHoneypot,
} from '../../types/honeypot.d.ts';
// @ts-ignore
const web3 = new Web3(provider);

// Number of tokens with fixed decimals (return a string)
function setDecimals(number: string, decimals: number) {
  number = number.toString();
  const numberAbs = number.split('.')[0];
  let numberDecimals = number.split('.')[1] ? number.split('.')[1] : '';
  while (numberDecimals.length < decimals) {
    numberDecimals += '0';
  }
  return numberAbs + numberDecimals;
}

// Honeypot test
async function testHoneypot(
  web3: any,
  tokenAddress: string,
  nativeTokenAddress: string,
  routerAddress: string,
  multicallAddress: string,
  nativeTokenToSell: string,
  maxgas: number,
  minNative: number,
): Promise<ResolvedHoneypot> {
  return new Promise(async (resolve) => {
    try {
      // Create contracts
      // @ts-ignore
      const nativeTokencontract = new web3.eth.Contract(
        tokenAbi,
        nativeTokenAddress,
      );
      // @ts-ignore
      const tokenContract = new web3.eth.Contract(tokenAbi, tokenAddress);
      // @ts-ignore
      const routerContract = new web3.eth.Contract(routerAbi, routerAddress);
      // @ts-ignore
      const multicallContract = new web3.eth.Contract(
        multicallAbi,
        multicallAddress,
        { from: ownerAddress },
      );

      // Read decimals and symbols
      const nativeTokenDecimals = await nativeTokencontract.methods
        .decimals()
        .call();
      const nativeTokenSymbol = await nativeTokencontract.methods
        .symbol()
        .call();
      const tokenSymbol = await tokenContract.methods.symbol().call();
      const tokenDecimals = await tokenContract.methods.decimals().call();

      // For swaps, 20 minutes from now in time
      const timeStamp = web3.utils.toHex(
        Math.round(Date.now() / 1000) + 60 * 20,
      );

      // Fixed value of MainTokens to sell
      const nativeTokenToSellfixed = setDecimals(
        nativeTokenToSell,
        nativeTokenDecimals,
      );

      // Approve to sell the MainToken in the Dex call
      const approveMainToken = nativeTokencontract.methods.approve(
        routerAddress,
        MAX_UINT,
      );
      const approveMainTokenABI = approveMainToken.encodeABI();

      // Swap MainToken to Token call
      const swapMainforTokens = routerContract.methods.swapExactTokensForTokens(
        nativeTokenToSellfixed,
        0,
        [nativeTokenAddress, tokenAddress],
        multicallAddress,
        timeStamp,
      );
      const swapMainforTokensABI = swapMainforTokens.encodeABI();

      let calls = [
        {
          target: nativeTokenAddress,
          callData: approveMainTokenABI,
          ethtosell: 0,
          gastouse: maxgas,
        }, // Approve MainToken sell
        {
          target: routerAddress,
          callData: swapMainforTokensABI,
          ethtosell: 0,
          gastouse: maxgas,
        }, // MainToken -> Token
      ];

      // Before running the main multicall
      // Run another multicall that return the number of Tokens expected to receive from the swap (liquidity check also...)
      // We will try to sell half of the expected tokens
      let tokensToSell = null;
      let tokensToSellfixed = null;
      const result = await multicallContract.methods
        .aggregate(calls)
        .call()
        .catch((err: Error) => console.log(err));

      // If error it means there is not enough liquidity
      let error = false;
      if (result.returnData[0] != '0x00' && result.returnData[1] != '0x00') {
        // @ts-ignore
        const receivedTokens =
          web3.eth.abi.decodeLog(
            [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
            result.returnData[1],
          ).amounts[1] *
          10 ** -tokenDecimals;

        // We will try to sell half of the Tokens
        let fixd = tokenDecimals;
        if (fixd > 8) fixd = 8;
        tokensToSell = parseFloat(String(receivedTokens / 2)).toFixed(fixd);
        tokensToSellfixed = setDecimals(tokensToSell, tokenDecimals);
      } else {
        error = true;
      }

      // Honeypot check constiable
      let honeypot = false;
      if (!error) {
        // For checking if some problems and message messages
        let problem = false;
        let message = null;

        // Approve to sell the MainToken in the Dex call
        const approveMainToken = nativeTokencontract.methods.approve(
          routerAddress,
          MAX_UINT,
        );
        const approveMainTokenABI = approveMainToken.encodeABI();

        // Swap MainToken to Token call
        const swapMainforTokens =
          routerContract.methods.swapExactTokensForTokens(
            nativeTokenToSellfixed,
            0,
            [nativeTokenAddress, tokenAddress],
            multicallAddress,
            timeStamp,
          );
        const swapMainforTokensABI = swapMainforTokens.encodeABI();

        // Approve to sell the Token in the Dex call
        const approveToken = tokenContract.methods.approve(
          routerAddress,
          MAX_UINT,
        );
        const approveTokenABI = approveToken.encodeABI();

        // Swap Token to MainToken call
        const swapTokensforMain =
          routerContract.methods.swapExactTokensForTokens(
            tokensToSellfixed,
            0,
            [tokenAddress, nativeTokenAddress],
            multicallAddress,
            timeStamp,
          );
        const swapTokensforMainABI = swapTokensforMain.encodeABI();

        // Swap Token to MainToken call if the previous one fails
        const swapTokensforMainFees =
          routerContract.methods.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            tokensToSellfixed,
            0,
            [tokenAddress, nativeTokenAddress],
            multicallAddress,
            timeStamp,
          );
        const swapTokensforMainFeesABI = swapTokensforMainFees.encodeABI();

        // MainToken Balance call
        const nativeTokenBalance =
          nativeTokencontract.methods.balanceOf(multicallAddress);
        const nativeTokenBalanceABI = nativeTokenBalance.encodeABI();

        // Token Balance call
        const tokenBalance = tokenContract.methods.balanceOf(multicallAddress);
        const tokenBalanceABI = tokenBalance.encodeABI();

        // Expected MainToken from the Token to MainToken swap call
        const amountOut = routerContract.methods.getAmountsOut(
          tokensToSellfixed,
          [tokenAddress, nativeTokenAddress],
        );
        const amountOutABI = amountOut.encodeABI();

        // Initial price in MainToken of 1 Token, for calculating price impact
        const amountOutAsk = routerContract.methods.getAmountsOut(
          setDecimals('1', tokenDecimals),
          [tokenAddress, nativeTokenAddress],
        );
        const amountOutAskABI = amountOutAsk.encodeABI();
        let initialPrice = 0;
        let finalPrice = 0;
        let priceImpact = 0;
        try {
          const initPrice = await amountOutAsk.call();
          initialPrice = initPrice[1];
        } catch (err) {}

        // Check if Token has Max Transaction amount
        let maxTokenTransaction = null;
        let maxTokenTransactionMain = null;
        try {
          maxTokenTransaction = await tokenContract.methods
            ._maxTxAmount()
            .call();
          maxTokenTransactionMain = await routerContract.methods
            .getAmountsOut(maxTokenTransaction, [
              tokenAddress,
              nativeTokenAddress,
            ])
            .call();
          maxTokenTransactionMain = parseFloat(
            String(maxTokenTransactionMain[1] * 10 ** -nativeTokenDecimals),
          ).toFixed(4);
          maxTokenTransaction = maxTokenTransaction * 10 ** -tokenDecimals;
        } catch (err) {}

        // Calls to run in the multicall
        calls = [
          {
            target: nativeTokenAddress,
            callData: approveMainTokenABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Approve MainToken sell
          {
            target: routerAddress,
            callData: swapMainforTokensABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // MainToken -> Token
          {
            target: tokenAddress,
            callData: tokenBalanceABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Token balance
          {
            target: tokenAddress,
            callData: approveTokenABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Approve Token sell
          {
            target: routerAddress,
            callData: swapTokensforMainABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Token -> MainToken
          {
            target: nativeTokenAddress,
            callData: nativeTokenBalanceABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // MainToken Balance
          {
            target: routerAddress,
            callData: amountOutABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Expected MainToken from the Token to MainToken swap
          {
            target: routerAddress,
            callData: swapTokensforMainFeesABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Token -> MainToken
          {
            target: nativeTokenAddress,
            callData: nativeTokenBalanceABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // MainToken Balance
          {
            target: routerAddress,
            callData: amountOutAskABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Final price of the Token
        ];

        // Run the multicall
        const result = await multicallContract.methods
          .aggregate(calls)
          .call()
          .catch((err: Error) => console.log(err));

        // constiables useful for calculating fees
        let output = 0; // Expected Tokens
        let realOutput = 0; // Obtained Tokens
        let expected = 0; // Expected MainTokens
        let obtained = 0; // Obtained MainTokens
        let buyGas = 0;
        let sellGas = 0;

        // Simulate the steps
        if (result.returnData[1] != '0x00') {
          // @ts-ignore
          output =
            web3.eth.abi.decodeLog(
              [
                {
                  internalType: 'uint256[]',
                  name: 'amounts',
                  type: 'uint256[]',
                },
              ],
              result.returnData[1],
            ).amounts[1] *
            10 ** -tokenDecimals;
          buyGas = result.gasUsed[1];
        }
        if (result.returnData[2] != '0x00') {
          // @ts-ignore
          realOutput =
            web3.eth.abi.decodeLog(
              [{ internalType: 'uint256', name: '', type: 'uint256' }],
              result.returnData[2],
            )[0] *
            10 ** -tokenDecimals;
        }
        if (result.returnData[4] != '0x00') {
          // @ts-ignore
          obtained =
            web3.eth.abi.decodeLog(
              [
                {
                  internalType: 'uint256[]',
                  name: 'amounts',
                  type: 'uint256[]',
                },
              ],
              result.returnData[4],
            ).amounts[1] *
            10 ** -nativeTokenDecimals;
          sellGas = result.gasUsed[4];
        } else {
          if (result.returnData[7] != '0x00') {
            obtained =
              (result.returnData[8] - result.returnData[5]) *
              10 ** -nativeTokenDecimals;
            sellGas = result.gasUsed[7];
          } else {
            // If so... this is honeypot!
            honeypot = true;
            problem = true;
          }
        }
        if (result.returnData[6] != '0x00') {
          // @ts-ignore
          expected =
            web3.eth.abi.decodeLog(
              [
                {
                  internalType: 'uint256[]',
                  name: 'amounts',
                  type: 'uint256[]',
                },
              ],
              result.returnData[6],
            ).amounts[1] *
            10 ** -nativeTokenDecimals;
        }
        if (result.returnData[9] != '0x00') {
          // @ts-ignore
          finalPrice = web3.eth.abi.decodeLog(
            [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
            result.returnData[9],
          ).amounts[1];
          // @ts-ignore
          priceImpact = parseFloat(
            String(((finalPrice - initialPrice) / initialPrice) * 100),
          ).toFixed(1);
          if (priceImpact > priceImp) {
            problem = true;
            message =
              'Price change after the swaps is ' +
              priceImpact +
              '%, which is really high! (Too high percentages can cause false positives)';
          }
        }

        // Calculate the fees
        let buyTax: any = ((realOutput - output) / output) * -100;
        let sellTax: any = ((obtained - expected) / expected) * -100;
        if (buyTax < 0.0) buyTax = 0.0;
        if (sellTax < 0.0) sellTax = 0.0;
        buyTax = parseFloat(String(buyTax)).toFixed(1);
        sellTax = parseFloat(String(sellTax)).toFixed(1);
        if (buyTax > maxBuyFee || sellTax > maxSellFee) {
          problem = true;
        }
        if (maxTokenTransactionMain && maxTokenTransactionMain < minNative) {
          problem = true;
        }

        // Return the result
        resolve({
          type: 'HoneypotStatus',
          isHoneypot: honeypot,
          buyFee: buyTax,
          sellFee: sellTax,
          buyGas: buyGas,
          sellGas: sellGas,
          maxTokenTransaction: maxTokenTransaction,
          maxTokenTransactionMain: maxTokenTransactionMain,
          tokenSymbol: tokenSymbol,
          nativeTokenSymbol: nativeTokenSymbol,
          priceImpact: priceImpact < 0.0 ? '0.0' : priceImpact,
          problem: problem,
          message: message,
        } as HoneypotStatus);
      } else {
        resolve({
          type: 'NotHoneypotLowLiquidity',
          isHoneypot: false,
          tokenSymbol: tokenSymbol,
          nativeTokenSymbol: nativeTokenSymbol,
          problem: true,
          liquidity: true,
          message:
            'Token liquidity is extremely low or has problems with the purchase!',
        } as NotHoneypotLowLiquidity);
      }
    } catch (err: any) {
      if (err.message.includes('Invalid JSON')) {
        resolve({
          type: 'UnexpectedJsonError',
          error: true,
        } as UnexpectedJsonError);
      } else {
        // Probably the contract is self-destructed
        resolve({
          type: 'ContractDontExistError',
          error: true,
          isHoneypot: false,
          tokenSymbol: null,
          problem: true,
          message: 'Token probably destroyed itself or does not exist!',
        } as ContractDontExistError);
      }
    }
  });
}

// HoneypotPlus test
async function testHoneypotPlus(
  web3: any,
  myToken: string,
  tokenAddress: string,
  nativeTokenAddress: string,
  routerAddress: string,
  multicallAddress: string,
  nativeTokenToSell: string,
  maxgas: number,
  minNative: number,
): Promise<ResolvedHoneypot> {
  return new Promise(async (resolve) => {
    try {
      // Create contracts
      const nativeTokencontract = new web3.eth.Contract(
        tokenAbi,
        nativeTokenAddress,
      );
      const myTokencontract = new web3.eth.Contract(tokenAbi, myToken);
      const tokenContract = new web3.eth.Contract(tokenAbi, tokenAddress);
      const routerContract = new web3.eth.Contract(routerAbi, routerAddress);
      const multicallContract = new web3.eth.Contract(
        multicallAbi,
        multicallAddress,
        { from: ownerAddress },
      );

      // Read decimals and symbols
      const myTokenDecimals = await myTokencontract.methods.decimals().call();
      const nativeTokenDecimals = await nativeTokencontract.methods
        .decimals()
        .call();
      const nativeTokenSymbol = await nativeTokencontract.methods
        .symbol()
        .call();
      const tokenSymbol = await tokenContract.methods.symbol().call();
      const tokenDecimals = await tokenContract.methods.decimals().call();

      // For swaps, 20 minutes from now in time
      const timeStamp = web3.utils.toHex(
        Math.round(Date.now() / 1000) + 60 * 20,
      );

      // Fixed value of MyToken to sell
      const nativeTokenToSellfixed = setDecimals(
        nativeTokenToSell,
        myTokenDecimals,
      );

      // Approve to sell MyToken in the Dex call
      const approveMyToken = myTokencontract.methods.approve(
        routerAddress,
        MAX_UINT,
      );
      const approveMyTokenABI = approveMyToken.encodeABI();

      // Swap MyToken to MainToken call
      const swapMyforTokens = routerContract.methods.swapExactTokensForTokens(
        nativeTokenToSellfixed,
        0,
        [myToken, nativeTokenAddress],
        multicallAddress,
        timeStamp,
      );
      const swapMyforTokensABI = swapMyforTokens.encodeABI();

      let calls = [
        {
          target: myToken,
          callData: approveMyTokenABI,
          ethtosell: 0,
          gastouse: maxgas,
        }, // Approve MyToken sell
        {
          target: routerAddress,
          callData: swapMyforTokensABI,
          ethtosell: 0,
          gastouse: maxgas,
        }, // MyToken -> MainToken
      ];

      // Before running the main multicall
      // Run another multicall that return the number of MainToken expected to receive from the swap
      // We will try to sell half of the expected tokens
      let result = await multicallContract.methods
        .aggregate(calls)
        .call()
        .catch((err: Error) => console.log(err));

      let nativeTokenToSell2: any = 0;
      let nativeTokenToSell2fixed: any = 0;
      if (result.returnData[0] != '0x00' && result.returnData[1] != '0x00') {
        // @ts-ignore
        nativeTokenToSell2 =
          web3.eth.abi.decodeLog(
            [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
            result.returnData[1],
          ).amounts[1] *
          10 ** -nativeTokenDecimals;

        // We will try to sell half of the Tokens
        let fixd = nativeTokenDecimals;
        if (fixd > 8) fixd = 8;
        nativeTokenToSell2 = parseFloat(String(nativeTokenToSell2 / 2)).toFixed(
          fixd,
        );
        nativeTokenToSell2fixed = setDecimals(
          nativeTokenToSell2,
          nativeTokenDecimals,
        );
      }

      // Approve to sell the MainToken in the Dex call
      const approveMainToken = nativeTokencontract.methods.approve(
        routerAddress,
        MAX_UINT,
      );
      const approveMainTokenABI = approveMainToken.encodeABI();

      // Swap MainToken to Token call
      const swapMainforTokens = routerContract.methods.swapExactTokensForTokens(
        nativeTokenToSell2fixed,
        0,
        [nativeTokenAddress, tokenAddress],
        multicallAddress,
        timeStamp,
      );
      const firstSwapMainforTokensABI = swapMainforTokens.encodeABI();

      calls = [
        {
          target: myToken,
          callData: approveMyTokenABI,
          ethtosell: 0,
          gastouse: maxgas,
        }, // Approve MyToken sell
        {
          target: routerAddress,
          callData: swapMyforTokensABI,
          ethtosell: 0,
          gastouse: maxgas,
        }, // MyToken -> MainToken
        {
          target: nativeTokenAddress,
          callData: approveMainTokenABI,
          ethtosell: 0,
          gastouse: maxgas,
        }, // Approve MainToken sell
        {
          target: routerAddress,
          callData: firstSwapMainforTokensABI,
          ethtosell: 0,
          gastouse: maxgas,
        }, // MainToken -> Token
      ];

      // Before running the main multicall
      // Run another multicall that return the number of Tokens expected to receive from the swap (liquidity check also...)
      // We will try to sell half of the expected tokens
      let tokensToSell = null;
      let tokensToSellfixed = null;
      result = await multicallContract.methods
        .aggregate(calls)
        .call()
        .catch((err: Error) => console.log(err));

      // If error it means there is not enough liquidity
      let error = false;
      if (result.returnData[2] != '0x00' && result.returnData[3] != '0x00') {
        const receivedTokens =
          web3.eth.abi.decodeLog(
            [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
            result.returnData[3],
          ).amounts[1] *
          10 ** -tokenDecimals;

        // We will try to sell half of the Tokens
        let fixd = tokenDecimals;
        if (fixd > 8) fixd = 8;
        tokensToSell = parseFloat(String(receivedTokens / 2)).toFixed(fixd);
        tokensToSellfixed = setDecimals(tokensToSell, tokenDecimals);
      } else {
        error = true;
      }

      // Honeypot check constiable
      let honeypot = false;
      if (!error) {
        // Check if some problems and message messages
        let problem = false;
        let message = null;

        // Approve to sell the Token in the Dex call
        const approveToken = tokenContract.methods.approve(
          routerAddress,
          MAX_UINT,
        );
        const approveTokenABI = approveToken.encodeABI();

        // Swap Token to MainToken call
        const swapTokensforMain =
          routerContract.methods.swapExactTokensForTokens(
            tokensToSellfixed,
            0,
            [tokenAddress, nativeTokenAddress],
            multicallAddress,
            timeStamp,
          );
        const swapTokensforMainABI = swapTokensforMain.encodeABI();

        // Swap Token to MainToken call if the previous one fails
        const swapTokensforMainFees =
          routerContract.methods.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            tokensToSellfixed,
            0,
            [tokenAddress, nativeTokenAddress],
            multicallAddress,
            timeStamp,
          );
        const swapTokensforMainFeesABI = swapTokensforMainFees.encodeABI();

        // MainToken Balance call
        const nativeTokenBalance =
          nativeTokencontract.methods.balanceOf(multicallAddress);
        const nativeTokenBalanceABI = nativeTokenBalance.encodeABI();

        // Token Balance call
        const tokenBalance = tokenContract.methods.balanceOf(multicallAddress);
        const tokenBalanceABI = tokenBalance.encodeABI();

        // Expected MainToken from the Token to MainToken swap call
        const amountOut = routerContract.methods.getAmountsOut(
          tokensToSellfixed,
          [tokenAddress, nativeTokenAddress],
        );
        const amountOutABI = amountOut.encodeABI();

        // Initial price in MainToken of 1 Token, for calculating price impact
        const amountOutAsk = routerContract.methods.getAmountsOut(
          setDecimals('1', tokenDecimals),
          [tokenAddress, nativeTokenAddress],
        );
        const amountOutAskABI = amountOutAsk.encodeABI();
        let initialPrice = 0;
        let finalPrice = 0;
        let priceImpact = 0;
        try {
          const initPrice = await amountOutAsk.call();
          initialPrice = initPrice[1];
        } catch (err) {}

        // Check if Token has Max Transaction amount
        let maxTokenTransaction = null;
        let maxTokenTransactionMain = null;
        try {
          maxTokenTransaction = await tokenContract.methods
            ._maxTxAmount()
            .call();
          maxTokenTransactionMain = await routerContract.methods
            .getAmountsOut(maxTokenTransaction, [
              tokenAddress,
              nativeTokenAddress,
            ])
            .call();
          maxTokenTransactionMain = parseFloat(
            String(maxTokenTransactionMain[1] * 10 ** -nativeTokenDecimals),
          ).toFixed(4);
          maxTokenTransaction = maxTokenTransaction * 10 ** -tokenDecimals;
        } catch (err) {}

        // Calls to run in the multicall
        const calls = [
          {
            target: myToken,
            callData: approveMyTokenABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Approve MyToken sell
          {
            target: routerAddress,
            callData: swapMyforTokensABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // MyToken -> MainToken
          {
            target: nativeTokenAddress,
            callData: approveMainTokenABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Approve MainToken sell
          {
            target: routerAddress,
            callData: firstSwapMainforTokensABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // MainToken -> Token
          {
            target: tokenAddress,
            callData: tokenBalanceABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Token balance
          {
            target: tokenAddress,
            callData: approveTokenABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Approve Token sell
          {
            target: routerAddress,
            callData: swapTokensforMainABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Token -> MainToken
          {
            target: nativeTokenAddress,
            callData: nativeTokenBalanceABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // MainToken Balance
          {
            target: routerAddress,
            callData: amountOutABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Expected MainToken from the Token to MainToken swap
          {
            target: routerAddress,
            callData: swapTokensforMainFeesABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Token -> MainToken
          {
            target: nativeTokenAddress,
            callData: nativeTokenBalanceABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // MainToken Balance
          {
            target: routerAddress,
            callData: amountOutAskABI,
            ethtosell: 0,
            gastouse: maxgas,
          }, // Final price of the Token
        ];

        // Run the multicall
        const result = await multicallContract.methods
          .aggregate(calls)
          .call()
          .catch((err: Error) => console.log(err));

        // constiables useful for calculating fees
        let output = 0; // Expected Tokens
        let realOutput = 0; // Obtained Tokens
        let expected = 0; // Expected MainTokens
        let obtained = 0; // Obtained MainTokens
        let buyGas = 0;
        let sellGas = 0;

        // Simulate the steps
        if (result.returnData[3] != '0x00') {
          //@ts-ignore
          output =
            web3.eth.abi.decodeLog(
              [
                {
                  internalType: 'uint256[]',
                  name: 'amounts',
                  type: 'uint256[]',
                },
              ],
              result.returnData[3],
            ).amounts[1] *
            10 ** -tokenDecimals;
          buyGas = result.gasUsed[3];
        }
        if (result.returnData[4] != '0x00') {
          //@ts-ignore
          realOutput =
            web3.eth.abi.decodeLog(
              [{ internalType: 'uint256', name: '', type: 'uint256' }],
              result.returnData[4],
            )[0] *
            10 ** -tokenDecimals;
        }
        if (result.returnData[6] != '0x00') {
          //@ts-ignore
          obtained =
            web3.eth.abi.decodeLog(
              [
                {
                  internalType: 'uint256[]',
                  name: 'amounts',
                  type: 'uint256[]',
                },
              ],
              result.returnData[6],
            ).amounts[1] *
            10 ** -nativeTokenDecimals;
          sellGas = result.gasUsed[6];
        } else {
          if (result.returnData[9] != '0x00') {
            obtained =
              (result.returnData[10] - result.returnData[7]) *
              10 ** -nativeTokenDecimals;
            sellGas = result.gasUsed[9];
          } else {
            // If so... this is honeypot!
            honeypot = true;
            problem = true;
          }
        }
        if (result.returnData[8] != '0x00') {
          //@ts-ignore
          expected =
            web3.eth.abi.decodeLog(
              [
                {
                  internalType: 'uint256[]',
                  name: 'amounts',
                  type: 'uint256[]',
                },
              ],
              result.returnData[8],
            ).amounts[1] *
            10 ** -nativeTokenDecimals;
        }
        if (result.returnData[11] != '0x00') {
          //@ts-ignore
          finalPrice = web3.eth.abi.decodeLog(
            [{ internalType: 'uint256[]', name: 'amounts', type: 'uint256[]' }],
            result.returnData[11],
          ).amounts[1];
          //@ts-ignore
          priceImpact = parseFloat(
            String(((finalPrice - initialPrice) / initialPrice) * 100),
          ).toFixed(1);
          if (priceImpact > priceImp) {
            problem = true;
            message =
              'Price change after the swaps is ' +
              priceImpact +
              '%, which is really high! (Too high percentages can cause false positives)';
          }
        }

        // Calculate the fees
        let buyTax: any = ((realOutput - output) / output) * -100;
        let sellTax: any = ((obtained - expected) / expected) * -100;
        if (buyTax < 0.0) buyTax = 0.0;
        if (sellTax < 0.0) sellTax = 0.0;
        buyTax = parseFloat(buyTax).toFixed(1);
        sellTax = parseFloat(sellTax).toFixed(1);
        if (buyTax > maxBuyFee || sellTax > maxSellFee) {
          problem = true;
        }
        if (maxTokenTransactionMain && maxTokenTransactionMain < minNative) {
          problem = true;
        }

        // Return the result
        resolve({
          type: 'HoneypotStatus',
          isHoneypot: honeypot,
          buyFee: buyTax,
          sellFee: sellTax,
          buyGas: buyGas,
          sellGas: sellGas,
          maxTokenTransaction: maxTokenTransaction,
          maxTokenTransactionMain: maxTokenTransactionMain,
          tokenSymbol: tokenSymbol,
          nativeTokenSymbol: nativeTokenSymbol,
          priceImpact: priceImpact < 0.0 ? '0.0' : priceImpact,
          problem: problem,
          message: message,
        } as HoneypotStatus);
      } else {
        resolve({
          type: 'NotHoneypotLowLiquidity',
          isHoneypot: false,
          tokenSymbol: tokenSymbol,
          nativeTokenSymbol: nativeTokenSymbol,
          problem: true,
          liquidity: true,
          message:
            'Token liquidity is extremely low or has problems with the purchase!',
        } as NotHoneypotLowLiquidity);
      }
    } catch (err: any) {
      if (err.message.includes('Invalid JSON')) {
        resolve({
          type: 'UnexpectedJsonError',
          error: true,
        } as UnexpectedJsonError);
      } else {
        // Probably the contract is self-destructed
        resolve({
          type: 'ContractDontExistError',
          error: true,
          isHoneypot: false,
          tokenSymbol: null,
          problem: true,
          message: 'Token probably destroyed itself or does not exist!',
        } as ContractDontExistError);
      }
    }
  });
}

export async function main(req: Request, res: Response) {
  const tokenAddress = req.params.address;
  if (
    `${req.params.address2}`.toLowerCase() ==
      nativeTokenAddress.toLowerCase() ||
    `${req.params.address2}`.toLowerCase() == 'default'
  ) {
    const honeypot = await testHoneypot(
      web3,
      tokenAddress,
      nativeTokenAddress,
      routerAddress,
      multicallAddress,
      nativeTokenToSell,
      maxgas,
      minNative,
    );
    switch (honeypot.type) {
      case 'UnexpectedJsonError':
        return res.status(403).json({
          error: true,
          msg: 'Error testing the honeypot, retry!',
        });
      case 'ContractDontExistError':
        return res.status(404).json({
          error: true,
          data: honeypot,
        });
      default:
        res.json({
          data: honeypot,
        });
    }
  } else {
    const honeypotPlus = await testHoneypotPlus(
      web3,
      req.params.address2,
      tokenAddress,
      nativeTokenAddress,
      routerAddress,
      multicallAddress,
      nativeTokenToSell,
      maxgas,
      minNative,
    );
    switch (honeypotPlus.type) {
      case 'UnexpectedJsonError':
        return res.status(403).json({
          error: true,
          msg: 'Error testing the honeypot, retry!',
        });
      case 'ContractDontExistError':
        return res.status(404).json({
          error: true,
          data: honeypotPlus,
        });
      default:
        res.json({
          data: honeypotPlus,
        });
    }
  }
}
