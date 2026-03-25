require('dotenv').config();

const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { NewMessage } = require('telegram/events');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const COINGECKO_API_BASE_URL = 'https://api.coingecko.com/api/v3';
const ALERT_CHECK_INTERVAL_MS = 60 * 1000;
const ITEMS_PER_PAGE = 5;
const MAX_CONCURRENT_API_REQUESTS = 5;
const SPAM_WINDOW_MS = 10 * 1000;
const MAX_EXPENSIVE_COMMANDS_PER_WINDOW = 4;
const THROTTLE_NOTICE_COOLDOWN_MS = 15 * 1000;
const MAX_ACTIVE_EXPENSIVE_COMMANDS_PER_CHAT = 1;
const MAX_ALERTS_PER_CHAT = 10;
const MAX_TICKERS_PER_RESPONSE = 25;
const CACHE_TTL_MS = {
  coin: 60 * 60 * 1000,
  price: 15 * 1000,
  coinDetails: 60 * 1000,
  priceHistory: 5 * 60 * 1000
};

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const token = getRequiredEnv('TELEGRAM_BOT_TOKEN');
const apiId = Number.parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;
const userSessionString = process.env.USER_SESSION_STRING;
const hasUserClientConfig =
  Number.isInteger(apiId) && Boolean(apiHash) && Boolean(userSessionString);

const chatData = {};
const alertRequests = {};
const subscribers = new Set();
const coinLookupCache = new Map();
const responseCache = new Map();
const inFlightRequests = new Map();
const chatCommandState = new Map();
const apiRequestQueue = [];

let activeApiRequests = 0;

const bot = new TelegramBot(token, { polling: true });
const geckoApi = axios.create({
  baseURL: COINGECKO_API_BASE_URL,
  timeout: 10000,
  headers: {
    Accept: 'application/json',
    'User-Agent': 'cryptobot-bharga/1.0'
  }
});

const userClient = hasUserClientConfig
  ? new TelegramClient(new StringSession(userSessionString), apiId, apiHash, {})
  : null;

function normalizeCryptoQuery(value) {
  return value.trim().toLowerCase();
}

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

async function sendBotMessage(chatId, text, options = {}) {
  try {
    await bot.sendMessage(chatId, text, options);
  } catch (error) {
    console.error(`Failed to send message to chat ${chatId}:`, error.message);
  }
}

function getCachedValue(cache, key) {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function setCachedValue(cache, key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

async function memoizeAsync(cache, cacheKey, ttlMs, loader) {
  const cachedValue = getCachedValue(cache, cacheKey);
  if (cachedValue !== null) {
    return cachedValue;
  }

  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey);
  }

  const pendingRequest = (async () => {
    const result = await loader();
    setCachedValue(cache, cacheKey, result, ttlMs);
    return result;
  })();

  inFlightRequests.set(cacheKey, pendingRequest);

  try {
    return await pendingRequest;
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}

async function runWithApiConcurrencyLimit(task) {
  if (activeApiRequests >= MAX_CONCURRENT_API_REQUESTS) {
    await new Promise(resolve => {
      apiRequestQueue.push(resolve);
    });
  }

  activeApiRequests += 1;

  try {
    return await task();
  } finally {
    activeApiRequests -= 1;

    const nextRequest = apiRequestQueue.shift();
    if (nextRequest) {
      nextRequest();
    }
  }
}

async function geckoGet(url, config) {
  return runWithApiConcurrencyLimit(() => geckoApi.get(url, config));
}

function getChatCommandState(chatId) {
  const existingState = chatCommandState.get(chatId);

  if (existingState) {
    return existingState;
  }

  const nextState = {
    activeCommands: 0,
    recentExpensiveCommands: [],
    lastThrottleNoticeAt: 0,
    lastBusyNoticeAt: 0
  };

  chatCommandState.set(chatId, nextState);
  return nextState;
}

async function maybeSendCooldownNotice(chatId, noticeKey, message) {
  const state = getChatCommandState(chatId);
  const now = Date.now();
  const lastNoticeAt =
    noticeKey === 'busy' ? state.lastBusyNoticeAt : state.lastThrottleNoticeAt;

  if (now - lastNoticeAt < THROTTLE_NOTICE_COOLDOWN_MS) {
    return;
  }

  if (noticeKey === 'busy') {
    state.lastBusyNoticeAt = now;
  } else {
    state.lastThrottleNoticeAt = now;
  }

  await sendBotMessage(chatId, message);
}

async function runExpensiveCommand(chatId, commandHandler) {
  const state = getChatCommandState(chatId);
  const now = Date.now();

  state.recentExpensiveCommands = state.recentExpensiveCommands.filter(
    timestamp => now - timestamp < SPAM_WINDOW_MS
  );

  if (state.recentExpensiveCommands.length >= MAX_EXPENSIVE_COMMANDS_PER_WINDOW) {
    await maybeSendCooldownNotice(
      chatId,
      'throttle',
      'Too many requests in a short time. Please wait a few seconds before trying again.'
    );
    return;
  }

  if (state.activeCommands >= MAX_ACTIVE_EXPENSIVE_COMMANDS_PER_CHAT) {
    await maybeSendCooldownNotice(
      chatId,
      'busy',
      'Your previous request is still being processed. Please wait.'
    );
    return;
  }

  state.recentExpensiveCommands.push(now);
  state.activeCommands += 1;

  try {
    await commandHandler();
  } finally {
    state.activeCommands = Math.max(0, state.activeCommands - 1);
  }
}

function getFriendlyErrorMessage(error, fallbackMessage) {
  if (error.response?.status === 429) {
    return 'CoinGecko rate limit reached. Please try again in a moment.';
  }

  if (error.message) {
    return error.message;
  }

  return fallbackMessage;
}

async function resolveCoin(query) {
  const normalizedQuery = normalizeCryptoQuery(query);

  if (!normalizedQuery) {
    throw new Error('Please provide a cryptocurrency name or symbol.');
  }

  return memoizeAsync(
    coinLookupCache,
    normalizedQuery,
    CACHE_TTL_MS.coin,
    async () => {
      try {
        const response = await geckoGet(`/coins/${encodeURIComponent(normalizedQuery)}`, {
          params: {
            localization: false,
            tickers: false,
            market_data: false,
            community_data: false,
            developer_data: false,
            sparkline: false
          }
        });

        return {
          id: response.data.id,
          name: response.data.name,
          symbol: response.data.symbol.toUpperCase()
        };
      } catch (error) {
        if (!error.response || error.response.status !== 404) {
          throw error;
        }
      }

      const response = await geckoGet('/search', {
        params: { query: normalizedQuery }
      });

      const coin =
        response.data.coins.find(item => {
          const id = item.id?.toLowerCase();
          const symbol = item.symbol?.toLowerCase();
          const name = item.name?.toLowerCase();

          return (
            id === normalizedQuery ||
            symbol === normalizedQuery ||
            name === normalizedQuery
          );
        }) || response.data.coins[0];

      if (!coin) {
        throw new Error(`Crypto "${query}" was not found on CoinGecko.`);
      }

      return {
        id: coin.id,
        name: coin.name,
        symbol: coin.symbol.toUpperCase()
      };
    }
  );
}

async function fetchUsdPrice(coinId) {
  return memoizeAsync(responseCache, `price:${coinId}`, CACHE_TTL_MS.price, async () => {
    const response = await geckoGet('/simple/price', {
      params: {
        ids: coinId,
        vs_currencies: 'usd'
      }
    });

    const price = response.data?.[coinId]?.usd;

    if (typeof price !== 'number') {
      throw new Error(`Price data for "${coinId}" is not available right now.`);
    }

    return price;
  });
}

async function fetchCoinDetails(coinId) {
  return memoizeAsync(
    responseCache,
    `coin-details:${coinId}`,
    CACHE_TTL_MS.coinDetails,
    async () => {
      const response = await geckoGet(`/coins/${encodeURIComponent(coinId)}`, {
        params: {
          localization: false,
          tickers: true,
          market_data: false,
          community_data: false,
          developer_data: false,
          sparkline: false
        }
      });

      return response.data;
    }
  );
}

async function fetchPriceHistory(coinId) {
  return memoizeAsync(
    responseCache,
    `price-history:${coinId}`,
    CACHE_TTL_MS.priceHistory,
    async () => {
      const response = await geckoGet(
        `/coins/${encodeURIComponent(coinId)}/market_chart`,
        {
          params: {
            vs_currency: 'usd',
            days: '90',
            interval: 'daily'
          }
        }
      );

      return response.data;
    }
  );
}

async function startUserClient() {
  if (!userClient) {
    console.warn(
      'Telegram user client is disabled. Set API_ID, API_HASH, and USER_SESSION_STRING to enable /subscribe.'
    );
    return;
  }

  try {
    await userClient.start();
    userClient.addEventHandler(messageHandler, new NewMessage({}));
    console.log('User client started and listening for incoming messages.');
  } catch (error) {
    console.error('Failed to start user client:', error);
  }
}

function extractIncomingMessageText(message) {
  const content = message?.message || message?.rawText || message?.text;

  if (!content || typeof content !== 'string') {
    return '';
  }

  return content.trim();
}

async function messageHandler(event) {
  if (!subscribers.size) {
    return;
  }

  const text = extractIncomingMessageText(event.message);
  if (!text) {
    return;
  }

  let sourceName = 'Channel update';

  try {
    const chat = await event.getChat();
    sourceName = chat?.title || chat?.username || sourceName;
  } catch (error) {
    console.error('Unable to resolve source chat metadata:', error.message);
  }

  const formattedMessage = `${sourceName}\n\n${text}`;

  await Promise.all(
    Array.from(subscribers).map(chatId => sendBotMessage(chatId, formattedMessage))
  );
}

function updateChatData(chatId, data) {
  chatData[chatId] = {
    ...chatData[chatId],
    ...data
  };
}

function chunkArray(array, size) {
  const chunks = [];

  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }

  return chunks;
}

function displayPage(chatId, page) {
  const data = chatData[chatId];

  if (!data || !data.pages[page]) {
    sendBotMessage(chatId, 'No data available. Run /priceexchanges first.');
    return;
  }

  let message = `Prices for page ${page + 1}/${data.pages.length}:\n${data.pages[page].join('\n')}`;

  if (data.pages.length > 1) {
    message += '\n\nUse /next or /prev to navigate pages.';
  }

  sendBotMessage(chatId, message);
}

function getPriceAtTimestamp(prices, targetTimestamp) {
  if (!Array.isArray(prices) || !prices.length) {
    return 'Data not available';
  }

  let closestPrice = prices[0];
  let smallestGap = Math.abs(prices[0][0] - targetTimestamp);

  for (const point of prices) {
    const gap = Math.abs(point[0] - targetTimestamp);

    if (gap < smallestGap) {
      closestPrice = point;
      smallestGap = gap;
    }
  }

  return typeof closestPrice[1] === 'number'
    ? closestPrice[1].toFixed(2)
    : 'Data not available';
}

function createPriceHistoryMessage(coin, priceData, timeZone = 'UTC') {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone
  });

  const now = Date.now();
  const timestamps = {
    '24h': now - 24 * 60 * 60 * 1000,
    '7d': now - 7 * 24 * 60 * 60 * 1000,
    '14d': now - 14 * 24 * 60 * 60 * 1000,
    '30d': now - 30 * 24 * 60 * 60 * 1000,
    '90d': now - 90 * 24 * 60 * 60 * 1000
  };

  let message = `Price history for ${coin.name} (${coin.symbol}) in ${timeZone}:\n`;

  for (const [interval, timestamp] of Object.entries(timestamps)) {
    const dateFormatted = formatter.format(new Date(timestamp));
    const price = getPriceAtTimestamp(priceData.prices, timestamp);
    message += `- ${interval} (${dateFormatted}): $${price}\n`;
  }

  return message;
}

async function addAlertRequest(chatId, cryptoQuery, changeThreshold, timeframeMinutes) {
  const coin = await resolveCoin(cryptoQuery);
  const initialPrice = await fetchUsdPrice(coin.id);

  if (!alertRequests[chatId]) {
    alertRequests[chatId] = [];
  }

  if (alertRequests[chatId].length >= MAX_ALERTS_PER_CHAT) {
    throw new Error(`You can only keep ${MAX_ALERTS_PER_CHAT} active alerts at a time.`);
  }

  const alert = {
    coinId: coin.id,
    coinName: coin.name,
    coinSymbol: coin.symbol,
    changeThreshold,
    timeframeMinutes,
    initialPrice,
    nextCheckAt: Date.now() + timeframeMinutes * 60 * 1000
  };

  alertRequests[chatId].push(alert);
  return alert;
}

async function checkAlerts(chatId) {
  const alerts = alertRequests[chatId];
  if (!alerts?.length) {
    return;
  }

  const now = Date.now();

  for (let index = 0; index < alerts.length; index += 1) {
    const alert = alerts[index];

    if (alert.nextCheckAt > now) {
      continue;
    }

    try {
      const currentPrice = await fetchUsdPrice(alert.coinId);
      const change =
        ((currentPrice - alert.initialPrice) / alert.initialPrice) * 100;

      if (Math.abs(change) >= alert.changeThreshold) {
        await sendBotMessage(
          chatId,
          `Alert for ${alert.coinName} (${alert.coinSymbol}): price moved ${change.toFixed(
            2
          )}% from ${formatUsd(alert.initialPrice)} to ${formatUsd(
            currentPrice
          )}. Threshold: ${alert.changeThreshold}%.`
        );

        alerts.splice(index, 1);
        index -= 1;
        continue;
      }

      alert.nextCheckAt = now + alert.timeframeMinutes * 60 * 1000;
    } catch (error) {
      console.error(`Error checking alert for chat ${chatId}:`, error.message);
      alert.nextCheckAt = now + ALERT_CHECK_INTERVAL_MS;
    }
  }

  if (!alerts.length) {
    delete alertRequests[chatId];
  }
}

async function runAlertChecks() {
  const chatIds = Object.keys(alertRequests);

  for (const chatId of chatIds) {
    await checkAlerts(chatId);
  }
}

const alertTimer = setInterval(() => {
  runAlertChecks().catch(error => {
    console.error('Unexpected error while checking alerts:', error);
  });
}, ALERT_CHECK_INTERVAL_MS);

alertTimer.unref?.();

bot.onText(/\/next/, msg => {
  const chatId = msg.chat.id;

  if (!chatData[chatId]) {
    sendBotMessage(chatId, 'No paginated data found. Run /priceexchanges first.');
    return;
  }

  if (chatData[chatId].currentPage < chatData[chatId].pages.length - 1) {
    chatData[chatId].currentPage += 1;
    displayPage(chatId, chatData[chatId].currentPage);
    return;
  }

  sendBotMessage(chatId, 'You are on the last page.');
});

bot.onText(/\/prev/, msg => {
  const chatId = msg.chat.id;

  if (!chatData[chatId]) {
    sendBotMessage(chatId, 'No paginated data found. Run /priceexchanges first.');
    return;
  }

  if (chatData[chatId].currentPage > 0) {
    chatData[chatId].currentPage -= 1;
    displayPage(chatId, chatData[chatId].currentPage);
    return;
  }

  sendBotMessage(chatId, 'You are on the first page.');
});

bot.onText(/\/price(?:\s+)(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cryptoQuery = match[1];

  await runExpensiveCommand(chatId, async () => {
    try {
      const coin = await resolveCoin(cryptoQuery);
      const price = await fetchUsdPrice(coin.id);

      await sendBotMessage(
        chatId,
        `The current price of ${coin.name} (${coin.symbol}) is ${formatUsd(
          price
        )}.\n\nData provided by CoinGecko.`
      );
    } catch (error) {
      console.error('Error fetching price:', error);
      await sendBotMessage(
        chatId,
        getFriendlyErrorMessage(error, 'Sorry, something went wrong while fetching the price.')
      );
    }
  });
});

bot.onText(/\/start/, msg => {
  sendBotMessage(
    msg.chat.id,
    "Welcome! I'm your Crypto Tracker Bot.\n\nUse /help to see the available commands."
  );
});

bot.onText(/\/help/, msg => {
  const helpMessage = [
    "Welcome to the Crypto Tracker Bot. Available commands:",
    '/start - Show the welcome message.',
    '/price [crypto] - Get the current price. Example: /price bitcoin or /price btc',
    '/setalert [crypto] [change%] [minutes] - Example: /setalert bitcoin 5 60',
    '/pricehistory [crypto] - Show the 24h, 7d, 14d, 30d, and 90d price checkpoints.',
    '/priceexchanges [crypto] - Show the coin price across exchanges with pagination.',
    '/subscribe - Subscribe to forwarded updates from the configured Telegram user session.',
    '/unsubscribe - Stop receiving forwarded updates.',
    '/next - Show the next exchange page after /priceexchanges.',
    '/prev - Show the previous exchange page after /priceexchanges.'
  ].join('\n');

  sendBotMessage(msg.chat.id, helpMessage);
});

bot.onText(/\/priceexchanges(?:\s+)(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cryptoQuery = match[1];

  await runExpensiveCommand(chatId, async () => {
    try {
      const coin = await resolveCoin(cryptoQuery);
      const coinData = await fetchCoinDetails(coin.id);
      const tickers = coinData.tickers
        .filter(ticker => typeof ticker.converted_last?.usd === 'number')
        .slice(0, MAX_TICKERS_PER_RESPONSE)
        .map(ticker => `${ticker.market.name}: ${formatUsd(ticker.converted_last.usd)}`);

      if (!tickers.length) {
        await sendBotMessage(chatId, `No exchange price data is available for ${coin.name}.`);
        return;
      }

      const pages = chunkArray(tickers, ITEMS_PER_PAGE);
      updateChatData(chatId, { pages, currentPage: 0 });
      displayPage(chatId, 0);
    } catch (error) {
      console.error('Error fetching exchange prices:', error);
      await sendBotMessage(
        chatId,
        getFriendlyErrorMessage(
          error,
          `Error fetching exchange data for "${cryptoQuery}". Please try again.`
        )
      );
    }
  });
});

bot.onText(/\/pricehistory(?:\s+)(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cryptoQuery = match[1];

  await runExpensiveCommand(chatId, async () => {
    try {
      const coin = await resolveCoin(cryptoQuery);
      const priceData = await fetchPriceHistory(coin.id);
      const message = createPriceHistoryMessage(coin, priceData);

      await sendBotMessage(chatId, message);
    } catch (error) {
      console.error('Error fetching price history:', error);
      await sendBotMessage(
        chatId,
        getFriendlyErrorMessage(
          error,
          `Error fetching historical data for "${cryptoQuery}". Please try again.`
        )
      );
    }
  });
});

bot.onText(
  /\/setalert(?:\s+)(.+?)\s+(\d+(?:\.\d+)?)\s+(\d+)/,
  async (msg, match) => {
    const chatId = msg.chat.id;
    const cryptoQuery = match[1];
    const changeThreshold = Number.parseFloat(match[2]);
    const timeframeMinutes = Number.parseInt(match[3], 10);

    await runExpensiveCommand(chatId, async () => {
      if (changeThreshold <= 0 || timeframeMinutes <= 0) {
        await sendBotMessage(chatId, 'Alert threshold and timeframe must be greater than zero.');
        return;
      }

      try {
        const alert = await addAlertRequest(
          chatId,
          cryptoQuery,
          changeThreshold,
          timeframeMinutes
        );

        await sendBotMessage(
          chatId,
          `Alert set for ${alert.coinName} (${alert.coinSymbol}): ${changeThreshold}% change checked every ${timeframeMinutes} minute(s). Baseline price: ${formatUsd(
            alert.initialPrice
          )}.`
        );
      } catch (error) {
        console.error('Error setting alert:', error);
        await sendBotMessage(
          chatId,
          getFriendlyErrorMessage(error, 'Unable to set the alert right now.')
        );
      }
    });
  }
);

bot.onText(/\/subscribe/, async msg => {
  const chatId = msg.chat.id;

  if (!userClient) {
    await sendBotMessage(
      chatId,
      'Subscription forwarding is not configured on this bot yet.'
    );
    return;
  }

  subscribers.add(chatId);
  await sendBotMessage(chatId, "You've subscribed to channel updates.");
});

bot.onText(/\/unsubscribe/, async msg => {
  const chatId = msg.chat.id;

  subscribers.delete(chatId);
  await sendBotMessage(chatId, "You've unsubscribed from channel updates.");
});

startUserClient().catch(console.error);

process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled Rejection:', error);
});
