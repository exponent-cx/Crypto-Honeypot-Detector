export interface HoneypotStatus {
  type: 'HoneypotStatus';
  isHoneypot: boolean;
  buyFee: number | string;
  sellFee: number | string;
  buyGas: number | string;
  sellGas: number | string;
  maxTokenTransaction: number | string;
  maxTokenTransactionMain: number | string;
  tokenSymbol: string;
  nativeTokenSymbol: string;
  priceImpact: string | number;
  problem: boolean;
  message: string | null;
}

export interface NotHoneypotLowLiquidity {
  type: 'NotHoneypotLowLiquidity';
  isHoneypot: false;
  tokenSymbol: string;
  nativeTokenSymbol: string;
  problem: true;
  liquidity: true;
  message: 'Token liquidity is extremely low or has problems with the purchase!';
}

export interface UnexpectedJsonError {
  type: 'UnexpectedJsonError';
  error: true;
}

export interface ContractDontExistError {
  type: 'ContractDontExistError';
  error: true;
  isHoneypot: false;
  tokenSymbol: null;
  problem: true;
  message: 'Token probably destroyed itself or does not exist!';
}

export type ResolvedHoneypot =
  | HoneypotStatus
  | NotHoneypotLowLiquidity
  | UnexpectedJsonError
  | ContractDontExistError;
