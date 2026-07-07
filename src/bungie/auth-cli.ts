import { runLogin } from './login.js';

runLogin()
  .then(() => {
    console.log('[ghost] Authenticated ✨ Tokens saved. You can start the app with `npm run dev`.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[ghost] Login failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
