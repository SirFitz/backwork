// Side-effect entry for preloading (Bun: `bun --preload @backwork/node/start`,
// or as the first import in your entry file). Uses NodeSDK explicitly, which is
// the most reliable path on Bun.
import { start } from "./index.mjs";
await start();
