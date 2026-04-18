// utils/telegramUserClient.js - Without Supabase
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const fs = require('fs');
const path = require('path');

class TelegramUserClient {
  constructor() {
    this.sessionFile = path.join(__dirname, '../telegram_session.json');
    this.client = null;
    this.isReady = false;

    console.log('📁 Session file path:', this.sessionFile);
  }

  async initialize() {
    try {
      // Check for Telegram credentials
      if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
        throw new Error('Telegram API credentials missing in .env file');
      }

      console.log('📱 Initializing Telegram client...');

      // Try to load existing session
      let sessionString = '';
      if (fs.existsSync(this.sessionFile)) {
        const saved = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
        sessionString = saved.string;
        console.log('✅ Loading existing session');
      }

      const stringSession = new StringSession(sessionString);

      this.client = new TelegramClient(
        stringSession,
        parseInt(process.env.TELEGRAM_API_ID),
        process.env.TELEGRAM_API_HASH,
        {
          connectionRetries: 5,
          useWSS: true,
        }
      );

      await this.client.connect();

      // Check if already authenticated
      if (!await this.client.checkAuthorization()) {
        console.log('🔐 Need to login...');
        await this.client.start({
          phoneNumber: async () => {
            return await input.text('Enter your phone number: ');
          },
          phoneCode: async () => {
            return await input.text('Enter verification code: ');
          },
          password: async () => {
            return await input.text('Enter 2FA password: ');
          },
        });

        // Save session
        const newSession = this.client.session.save();
        fs.writeFileSync(this.sessionFile, JSON.stringify({
          string: newSession,
          savedAt: new Date().toISOString()
        }));
        console.log('✅ Session saved!');
      } else {
        console.log('✅ Already authenticated!');
      }

      this.isReady = true;
      console.log('✅ Telegram client ready!');
      return this.client;
    } catch (error) {
      console.error('❌ Failed to initialize Telegram client:', error.message);
      throw error;
    }
  }

  async uploadFileToPrivateGroup(fileBuffer, fileName, mimeType) {
    if (!this.isReady) {
      throw new Error('Telegram client not initialized. Call initialize() first.');
    }

    try {
      let chat;
      const groupId = process.env.TELEGRAM_GROUP_ID;

      if (groupId) {
        console.log(`📤 Getting private group by ID: ${groupId}`);
        chat = await this.client.getEntity(parseInt(groupId));
      } else {
        throw new Error('TELEGRAM_GROUP_ID not set in .env');
      }

      console.log(`📤 Uploading to group: ${chat.title || chat.name || 'Group'}`);
      console.log(`📁 File: ${fileName} (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

      const result = await this.client.sendFile(chat, {
        file: fileBuffer,
        fileName: fileName,
        mimeType: mimeType,
        forceDocument: true,
        attributes: {
          fileName: fileName,
          mimeType: mimeType
        },
        progressCallback: (progress) => {
          process.stdout.write(`\r📊 Upload progress: ${Math.round(progress)}%`);
        }
      });

      console.log(`\n✅ Upload complete! Message ID: ${result.id}`);
      console.log(`📄 File sent as: ${fileName}`);

      return {
        success: true,
        messageId: result.id,
        fileName: fileName,
        size: fileBuffer.length,
        groupName: chat.title || chat.name
      };
    } catch (error) {
      console.error('❌ Upload error:', error);
      throw error;
    }
  }

  async uploadFileToChannel(fileBuffer, fileName, mimeType) {
    return this.uploadFileToPrivateGroup(fileBuffer, fileName, mimeType);
  }
}

module.exports = new TelegramUserClient();