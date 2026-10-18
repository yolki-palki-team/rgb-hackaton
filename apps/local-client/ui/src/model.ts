export type AssetCode = string;
export type View = 'home' | 'trade' | 'topup';
export type Draft = {
  giveAsset: AssetCode;
  giveAmount: string;
  receiveAsset: AssetCode;
  minReceiveAmount: string;
  maxFeeSats: string;
  expiresMinutes: string;
  allowPartial: boolean;
  minGiveAmount: string;
};

export type Balance = { code: AssetCode; amount: string; label: string; unit: string };
export type Order = {
  id: string;
  owner: string;
  giveAsset: AssetCode;
  giveAmount: string;
  receiveAsset: AssetCode;
  minReceiveAmount: string;
  status: string;
  fillSummary?: string;
  minimumFill?: string;
  mine?: boolean;
};
export type Trade = {
  id: string;
  txid?: string;
  cancellationTxid?: string;
  signingAuthorized?: boolean;
  recoveryRequired?: boolean;
  chainConfirmed?: boolean;
  rgbAccepted?: boolean;
  kind: 'direct' | 'ring';
  status: string;
  participants: { name: string; give: string; receive: string; mine?: boolean }[];
  legs: { from: string; to: string; amount: string }[];
  feeSats: string;
  reason?: string;
  validatedPreview?: {
    give: string;
    receive: string;
    feeSats: string;
    btcDeltaSats: string;
    digest: string;
  };
};

export const initialDraft: Draft = {
  giveAsset: 'X',
  giveAmount: '',
  receiveAsset: 'DUSD',
  minReceiveAmount: '',
  maxFeeSats: '1000',
  expiresMinutes: '30',
  allowPartial: false,
  minGiveAmount: '',
};

export const sampleBalances: Balance[] = [
  { code: 'BTC', amount: '0.00250000', label: 'Bitcoin', unit: 'BTC' },
  { code: 'X', amount: '250', label: 'Test RGB X', unit: 'X' },
  { code: 'DUSD', amount: '0', label: 'Test DUSD', unit: 'DUSD' },
];

export const sampleOrders: Order[] = [
  {
    id: 'DEMO-A1',
    owner: 'Wallet B',
    giveAsset: 'DUSD',
    giveAmount: '100',
    receiveAsset: 'BTC',
    minReceiveAmount: '100 000 sats',
    status: 'Open',
  },
  {
    id: 'DEMO-C1',
    owner: 'Wallet C',
    giveAsset: 'BTC',
    giveAmount: '100 000 sats',
    receiveAsset: 'X',
    minReceiveAmount: '100',
    status: 'Open',
  },
  {
    id: 'DEMO-A2',
    owner: 'Wallet A',
    giveAsset: 'X',
    giveAmount: '100',
    receiveAsset: 'DUSD',
    minReceiveAmount: '100',
    status: 'Sample',
    mine: true,
  },
];

export const sampleTrades: Record<'direct' | 'ring', Trade> = {
  direct: {
    id: 'DEMO-DIRECT',
    kind: 'direct',
    status: 'Sample plan',
    feeSats: '≤ 1 000',
    participants: [
      { name: 'You · wallet A', give: '100 000 sats', receive: '100 DUSD', mine: true },
      { name: 'Wallet B', give: '100 DUSD', receive: '100 000 sats' },
    ],
    legs: [
      { from: 'A', to: 'B', amount: '100 000 sats' },
      { from: 'B', to: 'A', amount: '100 DUSD' },
    ],
  },
  ring: {
    id: 'DEMO-RING',
    kind: 'ring',
    status: 'Sample plan',
    feeSats: '≤ 1 000',
    participants: [
      { name: 'You · wallet A', give: '100 X', receive: '100 DUSD', mine: true },
      { name: 'Wallet B', give: '100 DUSD', receive: '100 000 sats' },
      { name: 'Wallet C', give: '100 000 sats', receive: '100 X' },
    ],
    legs: [
      { from: 'A', to: 'C', amount: '100 X' },
      { from: 'B', to: 'A', amount: '100 DUSD' },
      { from: 'C', to: 'B', amount: '100 000 sats' },
    ],
  },
};
