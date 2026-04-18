// utils/telegramUserClient.js - COMPLETE WORKING VERSION
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const fs = require('fs');
const path = require('path');
const { Api } = require('telegram');

class TelegramUserClient {
  constructor() {
    this.sessionFile = path.join(__dirname, '../telegram_session.json');
    this.client = null;
    this.isReady = false;
  }

  async initialize() {
    try {
      if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
        throw new Error('Telegram API credentials missing');
      }
      
      console.log('📱 Initializing Telegram client...');
      
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
        { connectionRetries: 5, useWSS: true }
      );

      await this.client.connect();
      
      if (!await this.client.checkAuthorization()) {
        console.log('🔐 Need to login...');
        await this.client.start({
          phoneNumber: async () => await input.text('Enter your phone number: '),
          phoneCode: async () => await input.text('Enter verification code: '),
          password: async () => await input.text('Enter 2FA password: '),
        });
        
        const newSession = this.client.session.save();
        fs.writeFileSync(this.sessionFile, JSON.stringify({ string: newSession, savedAt: new Date().toISOString() }));
        console.log('✅ Session saved!');
      } else {
        console.log('✅ Already authenticated!');
      }

      this.isReady = true;
      console.log('✅ Telegram client ready!');
      return this.client;
    } catch (error) {
      console.error('❌ Failed to initialize:', error.message);
      throw error;
    }
  }

  async uploadFileToPrivateGroup(fileBuffer, fileName, mimeType) {
    if (!this.isReady) {
      throw new Error('Telegram client not initialized');
    }
    
    try {
      const groupId = parseInt(process.env.TELEGRAM_GROUP_ID);
      const chat = await this.client.getEntity(groupId);
      
      console.log(`📤 Uploading: ${fileName}`);
      console.log(`📊 Size: ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`);
      
      // Save file temporarily
      const tempPath = `/tmp/temp_${Date.now()}_${fileName}`;
      fs.writeFileSync(tempPath, fileBuffer);
      
      // Send file using file path (this works reliably)
      const result = await this.client.sendFile(chat, {
        file: tempPath,
        caption: fileName,
        forceDocument: true
      });
      
      // Delete temp file
      fs.unlinkSync(tempPath);
      
      console.log(`✅ Upload complete!`);
      console.log(`📄 File name in Telegram: ${fileName}`);
      
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
}

module.exports = new TelegramUserClient();