// login.js - Add proper cleanup
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const telegramClient = require('./utils/telegramUserClient');

(async () => {
  console.log('Starting one-time login process...');
  
  try {
    await telegramClient.initialize();
    console.log('\n✅ Login successful!');
    console.log('Session saved. You can now upload files without re-login.');
    
    // Properly disconnect to avoid assertion error
    if (telegramClient.client) {
      await telegramClient.client.disconnect();
      console.log('🔌 Disconnected gracefully');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Login failed:', error.message);
    process.exit(1);
  }
})();