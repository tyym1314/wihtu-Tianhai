/** All engine amounts are integer minor units: 100 units = one displayed coin. */
export type TigerSymbol = 'tiger' | 'ingot' | 'coin' | 'jade' | 'envelope' | 'firecracker' | 'orange';
export type TigerRandom = (maxExclusive: number) => number;
export interface TigerLineWin {
  lineIndex: number;
  symbol: TigerSymbol;
  indices: number[];
  payout: number;
}
export interface TigerStep {
  index: number;
  kind: 'spin' | 'respin';
  board: TigerSymbol[];
  /** Cells held for the next re-spin; also includes the final held positions. */
  lockedIndices: number[];
  /** Newly held cells on this step. Empty when the feature ends without adding symbols. */
  addedIndices: number[];
  lineWins: TigerLineWin[];
  winningIndices: number[];
  baseWin: number;
  fullBoard: boolean;
}
export interface TigerRoundInput { bet: number }
export interface TigerRoundResult {
  mathVersion: string;
  bet: number;
  initialBoard: TigerSymbol[];
  steps: TigerStep[];
  endBoard: TigerSymbol[];
  baseWin: number;
  totalWin: number;
  fullBoard: boolean;
  multiplier: 1 | 10;
  respinCount: number;
  featureSymbol: TigerSymbol | null;
}
export interface TigerDemoRound {
  id: string;
  requestId: string;
  epoch: number;
  bet: number;
  win: number;
  balanceBefore: number;
  balanceAfter: number;
  createdAt: string;
  engine: TigerRoundResult;
}
export interface TigerSession {
  mode: 'demo';
  sessionId: string;
  epoch: number;
  stateVersion: number;
  mathVersion: string;
  balance: number;
  betChoices: number[];
  pendingRound: TigerDemoRound | null;
}
