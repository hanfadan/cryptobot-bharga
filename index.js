require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

// Environment variables
const token = process.env.TELEGRAM_BOT_TOKEN;
const apiId = parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;
const userSessionString = process.env.USER_SESSION_STRING;

// Global variables
let chatData = {};
let alertRequests = {};
let subscribers = {};

// Telegram Bot Client
const bot = new TelegramBot(token, { polling: true });

// Telegram User Client (for listening to channel messages)
const userClient = new TelegramClient(new StringSession(userSessionString), apiId, apiHash, {});

// Start User Client
async function startUserClient() {
  try {
      await userClient.start();
      console.log('User client started.');

      // Listen for new messages from any chat
      userClient.addEventHandler(messageHandler, new NewMessage({}));

      console.log('Listening for messages from all chats.');
  } catch (error) {
      console.error('Failed to start user client:', error);
  }
}

// Handle new messages from any chat
async function messageHandler(event) {
  const message = event.message;

  console.log(`Forwarding message: ${message.message}`);
  // Forward the message to all subscribed users
  Object.keys(subscribers).forEach(chatId => {
      if (subscribers[chatId]) {
          bot.sendMessage(chatId, `${message.message}`).catch(error => {
              console.error('Error sending message:', error);
          });
      }
  });
}

async function addAlertRequest(chatId, crypto, change, timeframe) {
  if (!alertRequests[chatId]) {
      alertRequests[chatId] = [];
      setInterval(() => checkAlerts(chatId), timeframe * 60 * 1000);
  }
  try {
      // Fetch the initial price
      let response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${crypto}&vs_currencies=usd`);
      let initialPrice = response.data[crypto].usd;

      alertRequests[chatId].push({ crypto, change, timeframe, initialPrice });
  } catch (error) {
      console.error('Error setting alert:', error);
      // Optionally handle errors, like notifying the user
  }
}

function updateChatData(chatId, data) {
    chatData[chatId] = {
      ...chatData[chatId],
      ...data,
    };
  }

  function chunkArray(array, size) {
    return array.reduce((acc, val, i) => {
      let idx = Math.floor(i / size);
      let page = acc[idx] || (acc[idx] = []);
      page.push(val);
      return acc;
    }, []);
  }
  
  function displayPage(chatId, page) {
    const data = chatData[chatId];
    if (!data || !data.pages[page]) {
      bot.sendMessage(chatId, 'No data available.');
      return;
    }
  
    let message = `Prices for Page ${page + 1}:\n${data.pages[page].join('\n')}`;
    message += `\n\nUse /next or /prev to navigate pages.`;
    bot.sendMessage(chatId, message);
  }

  function createPriceHistoryMessage(crypto, priceData, timeZone = 'UTC') {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timeZone
    });
  
    const currentDate = new Date();
    currentDate.setUTCHours(0, 0, 0, 0); // Normalize to start of day in UTC
    const timestamps = {
      '24h': currentDate.getTime() - (24 * 60 * 60 * 1000),
      '7d': currentDate.getTime() - (7 * 24 * 60 * 60 * 1000),
      '14d': currentDate.getTime() - (14 * 24 * 60 * 60 * 1000),
      '30d': currentDate.getTime() - (30 * 24 * 60 * 60 * 1000),
      '90d': currentDate.getTime() - (90 * 24 * 60 * 60 * 1000),
    };
  
    let message = `Price history for ${crypto} (Timezone: ${timeZone}):\n`;
    for (const [interval, timestamp] of Object.entries(timestamps)) {
      const dateFormatted = formatter.format(new Date(timestamp));
      const price = getPriceAtTimestamp(priceData.prices, timestamp);
      message += `- ${interval} (${dateFormatted}): $${price}\n`;
    }
  
    return message;
  }
  
  
  function getPriceAtTimestamp(prices, targetTimestamp) {
    const oneDayMillis = 24 * 60 * 60 * 1000; // Milliseconds in a day
    let priceOnDate = null;
  
    for (const [timestamp, price] of prices) {
      if (Math.abs(timestamp - targetTimestamp) <= oneDayMillis) {
        priceOnDate = price;
        break;
      }
    }
  
    return priceOnDate ? priceOnDate.toFixed(2) : 'Data not available';
  }

async function checkAlerts(chatId) {
  if (!alertRequests[chatId]) return;

  for (let i = 0; i < alertRequests[chatId].length; i++) {
      let alert = alertRequests[chatId][i];
      try {
          // Fetch the current price
          let response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${alert.crypto}&vs_currencies=usd`);
          let currentPrice = response.data[alert.crypto].usd;

          // Calculate the percentage change
          let change = ((currentPrice - alert.initialPrice) / alert.initialPrice) * 100;

          // Check if the change meets the alert criteria
          if (Math.abs(change) >= alert.change) {
              bot.sendMessage(chatId, `Alert for ${alert.crypto}: Price has changed by ${change.toFixed(2)}% (threshold: ${alert.change}%)`);
              // Remove the alert after triggering
              alertRequests[chatId].splice(i, 1);
              i--; // Adjust the index since an element was removed
          }
      } catch (error) {
          console.error('Error checking alerts:', error);
          // Optionally handle errors, like notifying the user
      }
  }
}

  
  
  bot.onText(/\/next/, (msg) => {
    const chatId = msg.chat.id;
    if (chatData[chatId] && chatData[chatId].currentPage < chatData[chatId].pages.length - 1) {
      displayPage(chatId, ++chatData[chatId].currentPage);
    } else {
      bot.sendMessage(chatId, 'You are on the last page.');
    }
  });
  
  bot.onText(/\/prev/, (msg) => {
    const chatId = msg.chat.id;
    if (chatData[chatId] && chatData[chatId].currentPage > 0) {
      displayPage(chatId, --chatData[chatId].currentPage);
    } else {
      bot.sendMessage(chatId, 'You are on the first page.');
    }
  });

bot.onText(/\/price (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const resp = match[1]; // the captured "crypto" after /price command
  
    axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${resp}&vs_currencies=usd`)
      .then(response => {
        const price = response.data[resp].usd;
        bot.sendMessage(chatId, `The current price of ${resp} is: $${price} \n\nData provided by CoinGecko`);
      })
      .catch(error => {
        console.error('Error fetching data:', error);
        bot.sendMessage(chatId, 'Sorry, something went wrong.');
      });
  });

  // Matches "/start"
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Welcome! I'm your Crypto Tracker Bot. Here are the commands you can use:\n/start - Start the bot\n/price [crypto] - Get the price of a cryptocurrency\n/help - Get help and instructions");
  });
  
  // Matches "/help"
  bot.onText(/\/help/, (msg) => {
    const helpMessage = `
    Welcome to the Crypto Tracker Bot! Here's how you can use me:
    - /start: Start the bot and see this message.
    - /price [crypto]: Get the current price of a cryptocurrency. Example: /price bitcoin
    - /setalert [crypto] [change%] [time in minutes]: Set a price alert for a cryptocurrency. Example: /setalert bitcoin 5 60
    - /pricehistory [crypto]: Get the price history of a cryptocurrency. Example: /pricehistory bitcoin
    - /priceexchanges [crypto]: Get the price of a cryptocurrency on different exchanges. Example: /priceexchanges bitcoin
    - /subscribe: Subscribe to receive updates from the channel. You'll receive forwarded messages from our curated channel.
    - /unsubscribe: Unsubscribe from receiving updates from the channel.
    Each command has its purpose, and you can use them to track cryptocurrencies effectively. If you have any questions or suggestions, please feel free to reach out.
    `;
    bot.sendMessage(msg.chat.id, helpMessage).catch(error => {
        console.error('Error sending help message:', error);
    });
  });
  
  const ITEMS_PER_PAGE = 5; // You can adjust this number based on your preference

  bot.onText(/\/priceexchanges (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const crypto = match[1].toLowerCase();
  
    axios.get(`https://api.coingecko.com/api/v3/coins/${crypto}`)
      .then(response => {
        const coinData = response.data;
        const pages = chunkArray(coinData.tickers.map(ticker => `${ticker.market.name}: ${ticker.converted_last.usd} USD`), ITEMS_PER_PAGE);
  
        updateChatData(chatId, { pages, currentPage: 0 });
        displayPage(chatId, 0);
      })
      .catch(error => {
        console.error('Error:', error);
        bot.sendMessage(chatId, `Error fetching data for "${crypto}". Please try again.`);
      });
  });

  bot.onText(/\/pricehistory (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const crypto = match[1].toLowerCase();
  
    axios.get(`https://api.coingecko.com/api/v3/coins/${crypto}/market_chart?vs_currency=usd&days=max`)
      .then(response => {
        const priceData = response.data;
        const message = createPriceHistoryMessage(crypto, priceData);
        bot.sendMessage(chatId, message);
      })
      .catch(error => {
        console.error('Error:', error);
        bot.sendMessage(chatId, `Error fetching historical data for "${crypto}". Please try again.`);
      });
  });

  bot.onText(/\/setalert (\w+) (\d+) (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const crypto = match[1].toLowerCase();
    const change = parseFloat(match[2]);
    const timeframe = parseInt(match[3]); // Time in minutes

    addAlertRequest(chatId, crypto, change, timeframe);
    bot.sendMessage(chatId, `Alert set for ${crypto}: ${change}% change within ${timeframe} minutes.`);
});

// Subscribe command
bot.onText(/\/subscribe/, (msg) => {
  const chatId = msg.chat.id;
  subscribers[chatId] = true;
  bot.sendMessage(chatId, "You've subscribed to receive updates from the channel.").catch(error => {
      console.error('Error sending message:', error);
  });
});

// Unsubscribe command
bot.onText(/\/unsubscribe/, (msg) => {
  const chatId = msg.chat.id;
  delete subscribers[chatId];
  bot.sendMessage(chatId, "You've unsubscribed from receiving updates from the channel.").catch(error => {
      console.error('Error sending message:', error);
  });
});

// Start the user client
startUserClient().catch(console.error);

// Global error handlers to improve stability
process.on('uncaughtException', error => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled Rejection:', error);
});
