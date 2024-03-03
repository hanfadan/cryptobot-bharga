require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const prompt = require('prompt-sync')({ sigint: true }); // Import prompt-sync and configure it

const apiId = parseInt(process.env.API_ID, 10); // Ensure your API_ID is correctly parsed as a number
const apiHash = process.env.API_HASH;

async function getSession() {
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {});

    await client.start({
        phoneNumber: () => prompt('Please enter your phone number: '),
        password: () => prompt('Please enter your password, if you have two-factor authentication enabled: '),
        phoneCode: () => prompt('Please enter the code you received: '),
        onError: (err) => console.error(err),
    });

    const sessionString = client.session.save();
    console.log('You are now logged in.');
    console.log('Your session string is:', sessionString);
}

getSession().catch(console.error);
