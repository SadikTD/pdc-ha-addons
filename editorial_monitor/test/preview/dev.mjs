// Local preview server: node test/preview/dev.mjs <data dir> [port]
import { join } from 'node:path';
process.env.DATA_DIR = process.argv[2] || join(process.cwd(), '.preview-data');
process.env.ALLOW_ALL = '1';
process.env.PORT = process.env.PORT || process.argv[3] || "8123";
await import('../../server.mjs');
