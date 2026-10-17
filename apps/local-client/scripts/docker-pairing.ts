import { readPairing } from './docker-state.ts';

// Explicit local operator command; never put these tokens in web assets/logs.
console.log(
  JSON.stringify(
    readPairing().profiles.map((p) => ({
      profile: p.ownerId,
      url: `http://127.0.0.1:${p.port}`,
      sessionToken: p.sessionToken,
    })),
    null,
    2,
  ),
);
