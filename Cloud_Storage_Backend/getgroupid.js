// get-group-id.js
require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, 'telegram_session.json');
const API_ID = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;

async function getGroupId() {
    try {
        // Load session
        const sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        
        const client = new TelegramClient(
            new StringSession(sessionData.string),
            API_ID,
            API_HASH,
            { connectionRetries: 5 }
        );
        
        await client.connect();
        
        console.log('✅ Connected! Fetching your groups...\n');
        
        // Get all dialogs (chats)
        const dialogs = await client.getDialogs({});
        
        console.log('📋 Your private groups:\n');
        
        let groupFound = false;
        for (const dialog of dialogs) {
            if (dialog.isGroup) {
                groupFound = true;
                console.log(`📌 Group Name: ${dialog.name}`);
                console.log(`   ID: ${dialog.id}`);
                console.log(`   Is Private: ${!dialog.entity.username}`);
                console.log(`   Members: ${dialog.entity.participantsCount || 'Unknown'}`);
                console.log(`   ------------------------------------`);
            }
        }
        
        if (!groupFound) {
            console.log('❌ No groups found!');
            console.log('\n💡 Create a group first:');
            console.log('1. Open Telegram');
            console.log('2. Create a new group');
            console.log('3. Add at least one member');
            console.log('4. Name your group');
            console.log('5. Run this script again');
        }
        
        await client.disconnect();
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

getGroupId();