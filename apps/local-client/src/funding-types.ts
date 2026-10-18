import type { DevelopmentNetwork } from '@rgb-exchange/contracts';

export type FundingOperation = {
  id: string;
  status: 'PREVIEW' | 'SIGNING' | 'SIGNED' | 'BROADCAST' | 'CONFIRMED' | 'RECONCILING';
  network: 'regtest';
  address: string;
  amountSats: string;
  feeSats: string;
  maxFeeSats: string;
  expiresAt: number;
  txid?: string;
  reason?: string;
};

export type FundingStatus = {
  available: boolean;
  reason?: string;
  network: DevelopmentNetwork;
  address?: string;
  balanceSats?: string;
  operation: FundingOperation | null;
};
