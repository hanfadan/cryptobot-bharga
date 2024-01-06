require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Replace the value below with the Telegram token you receive from @BotFather
const token = process.env.TELEGRAM_BOT_TOKEN;

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, { polling: true });

let chatData = {};

let alertRequests = {};

let userLastCommandTime = {};

const COMMAND_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds

function addAlertRequest(chatId, crypto, change, timeframe) {
    if (!alertRequests[chatId]) {
        alertRequests[chatId] = [];
    }
    alertRequests[chatId].push({ crypto, change, timeframe });
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

  function canExecuteCommand(chatId, currentTime) {
    if (userLastCommandTime[chatId] && currentTime - userLastCommandTime[chatId] < COMMAND_TIMEOUT) {
        return false;
    }
    userLastCommandTime[chatId] = currentTime;
    return true;
}

  async function checkAlerts() {
    for (const chatId in alertRequests) {
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
  
// Listen for any kind of message
// bot.on('message', (msg) => {
//   const chatId = msg.chat.id;
//   // Send a message back to the user
//   bot.sendMessage(chatId, 'Hello! I am your crypto tracking bot.');
// });

bot.onText(/\/price (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const resp = match[1]; // the captured "crypto" after /price command
    const currentTime = new Date().getTime();

    if (!canExecuteCommand(chatId, currentTime)) {
        bot.sendMessage(chatId, "Please wait 5 minutes before sending another command.");
        return;
    }
  
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
    bot.sendMessage(msg.chat.id, "Here's how to use me:\n- /start to start the bot\n- /help to get this message\n- /price [crypto] to get the current price of a cryptocurrency\n- /setalert [crypto] [change%] [time in minutes] to set a price alert\n- /pricehistory [crypto] to get the price history\n- /priceexchanges [crypto] to get the price on different exchanges");
  });
  

  const ITEMS_PER_PAGE = 5; // You can adjust this number based on your preference

  bot.onText(/\/priceexchanges (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const crypto = match[1].toLowerCase();
    const currentTime = new Date().getTime();

    if (!canExecuteCommand(chatId, currentTime)) {
        bot.sendMessage(chatId, "Please wait 5 minutes before sending another command.");
        return;
    }
  
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
    const currentTime = new Date().getTime();

    if (!canExecuteCommand(chatId, currentTime)) {
        bot.sendMessage(chatId, "Please wait 5 minutes before sending another command.");
        return;
    }
  
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
    const currentTime = new Date().getTime();

    if (!canExecuteCommand(chatId, currentTime)) {
        bot.sendMessage(chatId, "Please wait 5 minutes before sending another command.");
        return;
    }

    addAlertRequest(chatId, crypto, change, timeframe);
    bot.sendMessage(chatId, `Alert set for ${crypto}: ${change}% change within ${timeframe} minutes.`);
});

  
  