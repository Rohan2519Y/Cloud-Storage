// utils/telegramUserClient.js - Without Supabase
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

class TelegramUserClient {
  constructor() {
    this.client = null;
    this.isReady = false;
  }

  async initialize() {
    try {
      if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
        throw new Error('Telegram API credentials missing in .env file');
      }

      console.log('📱 Initializing Telegram client...');

      let sessionString = process.env.TELEGRAM_SESSION || '';

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

      if (!await this.client.checkAuthorization()) {
        throw new Error('Session invalid or expired. Please login again via /api/auth/send-code');
      }

      console.log('✅ Already authenticated!');
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
      const groupId = process.env.TELEGRAM_GROUP_ID;

      if (!groupId) {
        throw new Error('TELEGRAM_GROUP_ID not set in .env');
      }

      console.log(`📤 Getting private group by ID: ${groupId}`);
      const chat = await this.client.getEntity(parseInt(groupId));

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