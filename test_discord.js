require('dotenv').config();

async function test() {
  const webhookUrl = (process.env.DISCORD_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    console.error('❌ DISCORD_WEBHOOK_URL is not set in your .env file!');
    console.log('Please add DISCORD_WEBHOOK_URL=your_webhook_url to your .env file first.');
    process.exit(1);
  }

  console.log('Sending test message to Discord...');
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        content: '🔔 **[SMABot] Test Notification**\nIf you see this, your Discord Webhook is configured correctly!' 
      })
    });
    if (res.ok) {
      console.log('✅ Test notification sent successfully! Check your Discord channel.');
    } else {
      console.error(`❌ Discord API returned error code ${res.status}: ${res.statusText}`);
    }
  } catch (e) {
    console.error(`❌ Failed to send notification: ${e.message}`);
  }
}

test();
