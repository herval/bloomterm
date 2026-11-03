import alpaca from './alpaca/index.ts';
import b3 from './b3/index.ts';
import bcb from './bcb/index.ts';
import brapi from './brapi/index.ts';
import coinbase from './coinbase/index.ts';
import cvm from './cvm/index.ts';
import rss from './rss/index.ts';
import secEdgar from './sec-edgar/index.ts';
import { checkRegistry, type Integration } from './sdk.ts';

export * from './sdk.ts';
export { getJson, getText, num, ProviderError, USER_AGENT } from './http.ts';
export { checkReadme, folderFiles, folderHash, importInFolder, importIntegration, installSdk } from './local.ts';
export { sdk, type Sdk } from './sdk-surface.ts';

/**
 * Every integration bloomterm loads; only modules listed here ever run (SPEC §6.8).
 * For market data the order matters: the first feed that supports a security serves it.
 * News comes from every integration that has a `news` feed.
 */
export const integrations: readonly Integration[] = checkRegistry([alpaca, brapi, coinbase, bcb, b3, rss, cvm, secEdgar]);
