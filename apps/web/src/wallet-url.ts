const walletPort = Number(import.meta.env?.VITE_LOCAL_WALLET_PORT ?? 4101);
if (!Number.isInteger(walletPort) || walletPort < 1024 || walletPort > 65535 || walletPort === 5173)
  throw new Error('Invalid local wallet port');
export const walletUrl = `http://127.0.0.1:${walletPort}/`;
