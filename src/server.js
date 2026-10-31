import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { drainOnSignal } from './lib/shutdown.js';

const config = loadConfig();
if (config.MCG_RUNTIME !== 'api') throw new Error('Use src/runtime.js for worker runtimes');
const { app } = await buildApp(config);
drainOnSignal(app);
await app.listen({ host: config.HOST, port: config.PORT });
