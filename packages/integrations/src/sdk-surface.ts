import { AllStrategiesFailedError, BlockedError, ChallengeError, defineBrowserAdapter, NeedsLoginError, RateLimitedError, z } from '@bloomterm/browser';
import { Account, AccountType, Balance, Bar, Currency, Indexer, Position, Quote, companyFor, lastSession, parseSecurity, rangeStart, tagText } from '@bloomterm/core';
import { getJson, getText, num, ProviderError, USER_AGENT } from './http.ts';
import { defineIntegration } from './sdk.ts';
import { decodeEntities, plain } from './text.ts';

// `@bloomterm/sdk`: everything an integration in your data folder (~/.bloomterm/integrations,
// SPEC §6.11) may import, from one module. bloomd hands it this very object (local.ts), so
// error classes and schemas are the ones bloomd checks against. Built-in integrations import
// the same things from their own packages instead.

export const sdk = {
  defineIntegration,
  defineBrowserAdapter,
  z,
  // Account data shapes (zod schemas), and the market ones.
  Account,
  AccountType,
  Balance,
  Currency,
  Indexer,
  Position,
  Bar,
  Quote,
  // Securities and companies.
  parseSecurity,
  companyFor,
  tagText,
  rangeStart,
  lastSession,
  // HTTP for `api` integrations: bloomterm's honest user agent, errors you can read.
  getJson,
  getText,
  num,
  ProviderError,
  USER_AGENT,
  // Text from feeds.
  plain,
  decodeEntities,
  // What a browser strategy throws to tell the host what happened.
  NeedsLoginError,
  ChallengeError,
  BlockedError,
  RateLimitedError,
  AllStrategiesFailedError,
};

export type Sdk = typeof sdk;

export {
  defineIntegration,
  defineBrowserAdapter,
  z,
  Account,
  AccountType,
  Balance,
  Currency,
  Indexer,
  Position,
  Bar,
  Quote,
  parseSecurity,
  companyFor,
  tagText,
  rangeStart,
  lastSession,
  getJson,
  getText,
  num,
  ProviderError,
  USER_AGENT,
  plain,
  decodeEntities,
  NeedsLoginError,
  ChallengeError,
  BlockedError,
  RateLimitedError,
  AllStrategiesFailedError,
};

export type { Integration, IntegrationContext, MarketFeed, NewsData, NewsFeed, QuoteData, SecretLookup, SecretSpec } from './sdk.ts';
export type { DailyRange, Market, NewsKind, Range, Sector, Security } from '@bloomterm/core';
export type { BrowserAdapterDef, CheckContext, DatasetDef, DownloadedFile, LoginDef, Strategy, StrategyContext, StrategyKind, WriteRule } from '@bloomterm/browser';
