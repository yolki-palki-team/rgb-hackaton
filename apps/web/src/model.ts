export type AssetCode = 'BTC' | 'X' | 'DUSD';
export type View = 'home' | 'market' | 'trade';
export type Draft = {
  giveAsset: AssetCode;
  giveAmount: string;
  receiveAsset: AssetCode;
  minReceiveAmount: string;
  maxFeeSats: string;
  expiresMinutes: string;
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
  mine?: boolean;
};
export type Trade = {
  id: string;
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
  giveAsset: 'X', giveAmount: '100', receiveAsset: 'DUSD', minReceiveAmount: '100', maxFeeSats: '1000', expiresMinutes: '30',
};

export const sampleBalances: Balance[] = [
  { code: 'BTC', amount: '0.00250000', label: 'Bitcoin', unit: 'BTC' },
  { code: 'X', amount: '250', label: 'Тестовый RGB X', unit: 'X' },
  { code: 'DUSD', amount: '0', label: 'Тестовый DUSD', unit: 'DUSD' },
];

export const sampleOrders: Order[] = [
  { id: 'DEMO-A1', owner: 'Кошелёк B', giveAsset: 'DUSD', giveAmount: '100', receiveAsset: 'BTC', minReceiveAmount: '100 000 sats', status: 'Открыта' },
  { id: 'DEMO-C1', owner: 'Кошелёк C', giveAsset: 'BTC', giveAmount: '100 000 sats', receiveAsset: 'X', minReceiveAmount: '100', status: 'Открыта' },
  { id: 'DEMO-A2', owner: 'Кошелёк A', giveAsset: 'X', giveAmount: '100', receiveAsset: 'DUSD', minReceiveAmount: '100', status: 'Образец', mine: true },
];

export const sampleTrades: Record<'direct' | 'ring', Trade> = {
  direct: {
    id: 'DEMO-DIRECT', kind: 'direct', status: 'Образец плана', feeSats: '≤ 1 000',
    participants: [
      { name: 'Вы · кошелёк A', give: '100 000 sats', receive: '100 DUSD', mine: true },
      { name: 'Кошелёк B', give: '100 DUSD', receive: '100 000 sats' },
    ],
    legs: [
      { from: 'A', to: 'B', amount: '100 000 sats' },
      { from: 'B', to: 'A', amount: '100 DUSD' },
    ],
  },
  ring: {
    id: 'DEMO-RING', kind: 'ring', status: 'Образец плана', feeSats: '≤ 1 000',
    participants: [
      { name: 'Вы · кошелёк A', give: '100 X', receive: '100 DUSD', mine: true },
      { name: 'Кошелёк B', give: '100 DUSD', receive: '100 000 sats' },
      { name: 'Кошелёк C', give: '100 000 sats', receive: '100 X' },
    ],
    legs: [
      { from: 'A', to: 'C', amount: '100 X' },
      { from: 'B', to: 'A', amount: '100 DUSD' },
      { from: 'C', to: 'B', amount: '100 000 sats' },
    ],
  },
};
