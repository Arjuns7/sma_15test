// ═══════════════════════════════════════════════════════════════
// SMABot — Hyperliquid Testnet Trading Bot
// ═══════════════════════════════════════════════════════════════
// Requirements: npm install ccxt dotenv
// Usage:        node bot.js
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const ccxt = require('ccxt');

// ─── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  symbol:          'BTC/USDC:USDC',  // Hyperliquid perp format
  timeframe:       '15m',             // candle interval
  fastPeriod:      20,                // fast EMA period
  slowPeriod:      100,               // slow EMA period
  leverage:        2,                 // position leverage
  useRsi:          true,
  rsiPeriod:       14,
  rsiOB:           65,               // skip longs above this RSI
  rsiOS:           35,               // skip shorts below this RSI
  useAtrStop:      true,
  atrPeriod:       14,
  atrMult:         3,                // ATR stop-loss multiplier
  useTrailing:     true,             // trailing stop ON
  trailMult:       2.0,              // trailing stop ATR multiplier — tighter = more profit captured
  useTakeProfit:   true,             // take-profit ON  ← NEW
  tpPoints:        1500,             // close when +$1500 from entry  ← NEW
  longOnly:        false,            // long + short mode
  useTrend:        true,             // trend filter ON
  trendPeriod:     100,              // trend MA period
  useVol:          false,            // volume filter OFF
  volPeriod:       20,               // volume SMA period
  signalPollMs:    60000,            // check signals every 60s (15m candles need ≤ 60s) ← FIXED (was 5s)
  stopPollMs:      1000,             // monitor stops every 1s when in position
  testnet:         false,            // true = testnet, false = mainnet
  maxDailyLoss:    -500,            // kill switch: max daily loss USD
};

// ─── EXCHANGE SETUP ──────────────────────────────────────────
const WALLET = (process.env.HL_WALLET_ADDRESS || '').trim();
const PRIVKEY = (process.env.HL_PRIVATE_KEY || '').trim();

console.log(`🔑 Wallet: ${WALLET.slice(0, 6)}...${WALLET.slice(-4)}`);
console.log(`🔑 Key:    ${PRIVKEY ? '[LOADED]' : '[MISSING]'}`);

const exchange = new ccxt.hyperliquid({
  walletAddress:   WALLET,
  privateKey:      PRIVKEY,
  enableRateLimit: true,
  sandbox:         CONFIG.testnet,
});

// Belt-and-suspenders: set on every possible property
exchange.walletAddress = WALLET;
exchange.apiKey = WALLET;
exchange.secret = PRIVKEY;
exchange.privateKey = PRIVKEY;
if (!exchange.options) exchange.options = {};
exchange.options['walletAddress'] = WALLET;
exchange.options['defaultAddress'] = WALLET;

// ─── INDICATOR FUNCTIONS ─────────────────────────────────────
function calcEMA(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = closes.slice(0, period).reduce((a, b) => a + b, 0);
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    out[i] = (closes[i] - out[i - 1]) * k + out[i - 1];
  }
  return out;
}

function calcRSI(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (avgGain += d) : (avgLoss -= d);
  }
  avgGain /= period; avgLoss /= period;
  out[period] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
  }
  return out;
}

function calcATR(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i][2], l = candles[i][3], pc = candles[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  out[period] = sum / period;
  for (let i = period; i < trs.length; i++) {
    out[i + 1] = (out[i] * (period - 1) + trs[i]) / period;
  }
  return out;
}

function calcSMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = values.slice(0, period).reduce((a, b) => a + b, 0);
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}

// ─── DISCORD NOTIFICATION ────────────────────────────────────────────
async function sendDiscordNotification(message) {
  const webhookUrl = (process.env.DISCORD_WEBHOOK_URL || '').trim();
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    });
  } catch (e) {
    console.error(`⚠️ Discord notification failed: ${e.message}`);
  }
}

// ─── BOT STATE ───────────────────────────────────────────────────────
let position = null;
let dailyPnL = 0;
let lastResetDay = new Date().toDateString();
let tradeCount = 0;
// Tracks the candle timestamp of the last crossover we ACTED on.
// Prevents re-entering a trade when the same crossover is still active
// after a stop-loss or trailing-stop closes the position mid-candle.
let lastActedCandleTime = 0;

// ─── MAIN LOOP ───────────────────────────────────────────────
async function runBot() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║       SMABot — Hyperliquid Trading Bot               ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`⚡ Starting up...`);
  console.log(`   Network:   ${CONFIG.testnet ? '🧪 TESTNET' : '🔴 MAINNET'}`);
  console.log(`   Symbol:    ${CONFIG.symbol}`);
  console.log(`   Timeframe: ${CONFIG.timeframe}`);
  console.log(`   Strategy:  EMA ${CONFIG.fastPeriod}/${CONFIG.slowPeriod}`);
  console.log(`   Leverage:  ${CONFIG.leverage}x`);
  console.log(`   Mode:      ${CONFIG.longOnly ? 'Long Only' : 'Long + Short'}`);
  console.log(`   Risk:      ${CONFIG.riskPct * 100}% per trade`);
  console.log(`   Trend:     ${CONFIG.useTrend ? `EMA ${CONFIG.trendPeriod}` : 'OFF'}`);
  console.log(`   Volume:    ${CONFIG.useVol ? `SMA ${CONFIG.volPeriod}` : 'OFF'}`);
  console.log('');

  // Load markets
  try {
    console.log('📡 Loading markets...');
    await exchange.loadMarkets();
    console.log(`✅ Markets loaded (${Object.keys(exchange.markets).length} pairs)`);
  } catch (e) {
    console.error(`❌ Failed to load markets: ${e.message}`);
    process.exit(1);
  }

  // Set leverage
  try {
    await exchange.setLeverage(CONFIG.leverage, CONFIG.symbol);
    console.log(`✅ Leverage set to ${CONFIG.leverage}x`);
  } catch (e) {
    console.log(`⚠️  Could not set leverage: ${e.message}`);
  }

  // Fetch initial price
  try {
    const ticker = await exchange.fetchTicker(CONFIG.symbol);
    console.log(`✅ BTC price: $${ticker.last.toLocaleString()}`);
  } catch (e) {
    console.log(`⚠️  Could not fetch price: ${e.message}`);
  }

  // Check balance
  try {
    const balance = await exchange.fetchBalance({ user: WALLET });
    const usdc = balance.total?.USDC || balance.free?.USDC || 0;
    console.log(`✅ Balance: $${parseFloat(usdc).toFixed(2)} USDC`);
  } catch (e) {
    console.log(`⚠️  Could not fetch balance: ${e.message}`);
  }

  // Check for existing position on startup
  try {
    const positions = await exchange.fetchPositions([CONFIG.symbol]);
    const pos = positions.find(p =>
      p.symbol === CONFIG.symbol && Math.abs(p.contracts) > 0
    );
    if (pos) {
      position = {
        side: pos.side === 'long' ? 'LONG' : 'SHORT',
        entryPrice: pos.entryPrice,
        size: Math.abs(pos.contracts),
        peakPrice: pos.entryPrice,
        troughPrice: pos.entryPrice,
      };
      console.log(`📌 Existing position: ${position.side} ${position.size} @ $${position.entryPrice}`);
    } else {
      console.log('📌 No open positions');
    }
  } catch (e) {
    console.log(`⚠️  Could not check positions: ${e.message}`);
  }

  console.log('');
  console.log('🔄 Entering main loop...');
  console.log(`   Signal check: every ${CONFIG.signalPollMs / 1000}s`);
  console.log(`   Stop monitor: every ${CONFIG.stopPollMs / 1000}s (when in position)`);
  console.log('');

  let lastSignalCheck = 0;

  // Main loop — fast polling, two modes
  while (true) {
    try {
      const now = Date.now();

      if (position) {
        // IN POSITION → monitor price for stops every 10s
        await monitorStops();
      }

      // Check for entry/exit signals on a slower cadence
      if (now - lastSignalCheck >= CONFIG.signalPollMs) {
        await tick();
        lastSignalCheck = now;
      }
    } catch (e) {
      console.error(`❌ Tick error: ${e.message}`);
    }
    await sleep(position ? CONFIG.stopPollMs : CONFIG.signalPollMs);
  }
}

// ─── FAST STOP MONITOR (runs every 10s when in position) ─────
async function monitorStops() {
  if (!position) return;

  // Check if position was closed externally or on-chain (every 10s)
  if (!position.lastPositionCheck || Date.now() - position.lastPositionCheck > 10000) {
    position.lastPositionCheck = Date.now();
    try {
      const positions = await exchange.fetchPositions([CONFIG.symbol]);
      const pos = positions.find(p =>
        p.symbol === CONFIG.symbol && Math.abs(p.contracts) > 0
      );
      if (!pos) {
        console.log(`\n[${new Date().toLocaleTimeString()}] 🔊 Position was closed externally or on-chain (e.g. stop-loss hit). Updating state...`);
        let exitPrice = 0;
        let pnl = 0;
        try {
          const trades = await exchange.fetchMyTrades(CONFIG.symbol, undefined, 5);
          if (trades && trades.length > 0) {
            const lastTrade = trades[trades.length - 1];
            exitPrice = lastTrade.price;
            pnl = position.side === 'LONG'
              ? (exitPrice - position.entryPrice) * position.size
              : (position.entryPrice - exitPrice) * position.size;
          }
        } catch (tradeErr) {
          // If we couldn't fetch trades, fallback to last known ticker price
          const ticker = await exchange.fetchTicker(CONFIG.symbol);
          exitPrice = ticker.last;
          pnl = position.side === 'LONG'
            ? (exitPrice - position.entryPrice) * position.size
            : (position.entryPrice - exitPrice) * position.size;
        }
        dailyPnL += pnl;
        sendDiscordNotification(`🔴 **[SMABot] CLOSED ${position.side}**\n• Exit Price: $${exitPrice.toFixed(2)} (Entry: $${position.entryPrice.toFixed(2)})\n• Reason: \`on-chain stop-loss / external\`\n• Trade PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDC\n• Daily PnL: $${dailyPnL.toFixed(2)} USDC`);
        position = null;
        return;
      }
    } catch (posErr) {
      console.log(`⚠️ Could not check position sync: ${posErr.message}`);
    }
  }

  try {
    const ticker = await exchange.fetchTicker(CONFIG.symbol);
    const price = ticker.last;
    const ts = new Date().toLocaleTimeString();

    // Update peak/trough for trailing stop
    if (position.side === 'LONG' && price > position.peakPrice) {
      position.peakPrice = price;
    }
    if (position.side === 'SHORT' && price < position.troughPrice) {
      position.troughPrice = price;
    }

    // Get latest ATR (cached, refresh every 5 min)
    if (!position.cachedATR || Date.now() - (position.atrTime || 0) > 300000) {
      const candles = await exchange.fetchOHLCV(CONFIG.symbol, CONFIG.timeframe, undefined, CONFIG.atrPeriod + 5);
      const atrVals = calcATR(candles, CONFIG.atrPeriod);
      position.cachedATR = atrVals[atrVals.length - 1] || price * 0.02;
      position.atrTime = Date.now();
    }
    const atrNow = position.cachedATR;

    // ATR Stop-Loss check
    if (CONFIG.useAtrStop) {
      const stopDist = CONFIG.atrMult * atrNow;
      if (position.side === 'LONG' && price < position.entryPrice - stopDist) {
        console.log(`[${ts}] 🔴 ATR STOP-LOSS HIT! Price: $${price} < Stop: $${(position.entryPrice - stopDist).toFixed(0)}`);
        await closePosition('atr-stop');
        return;
      }
      if (position.side === 'SHORT' && price > position.entryPrice + stopDist) {
        console.log(`[${ts}] 🔴 ATR STOP-LOSS HIT! Price: $${price} > Stop: $${(position.entryPrice + stopDist).toFixed(0)}`);
        await closePosition('atr-stop');
        return;
      }
    }

    // Take-Profit check  ← NEW
    if (CONFIG.useTakeProfit) {
      if (position.side === 'LONG' && price >= position.entryPrice + CONFIG.tpPoints) {
        console.log(`[${ts}] 🟢 TAKE-PROFIT HIT! Price: $${price} >= TP: $${(position.entryPrice + CONFIG.tpPoints).toFixed(0)}`);
        await closePosition('take-profit');
        return;
      }
      if (position.side === 'SHORT' && price <= position.entryPrice - CONFIG.tpPoints) {
        console.log(`[${ts}] 🟢 TAKE-PROFIT HIT! Price: $${price} <= TP: $${(position.entryPrice - CONFIG.tpPoints).toFixed(0)}`);
        await closePosition('take-profit');
        return;
      }
    }

    // Trailing Stop check
    if (CONFIG.useTrailing) {
      const tsDist = CONFIG.trailMult * atrNow;
      if (position.side === 'LONG') {
        const trailStop = position.peakPrice - tsDist;
        if (price < trailStop) {
          console.log(`[${ts}] 🟡 TRAILING STOP HIT! Price: $${price} < Trail: $${trailStop.toFixed(0)} (peak: $${position.peakPrice})`);
          await closePosition('trail-stop');
          return;
        }
      }
      if (position.side === 'SHORT') {
        const trailStop = position.troughPrice + tsDist;
        if (price > trailStop) {
          console.log(`[${ts}] 🟡 TRAILING STOP HIT! Price: $${price} > Trail: $${trailStop.toFixed(0)} (trough: $${position.troughPrice})`);
          await closePosition('trail-stop');
          return;
        }
      }
    }

    // Quiet log (only every 60s to avoid spam)
    if (!position.lastMonitorLog || Date.now() - position.lastMonitorLog > 60000) {
      const pnl = position.side === 'LONG'
        ? (price - position.entryPrice) * position.size
        : (position.entryPrice - price) * position.size;
      const stopDist = CONFIG.atrMult * atrNow;
      const trailDist = CONFIG.trailMult * atrNow;
      const atrStop = position.side === 'LONG' ? position.entryPrice - stopDist : position.entryPrice + stopDist;
      const trailStop = position.side === 'LONG' ? position.peakPrice - trailDist : position.troughPrice + trailDist;

      console.log(
        `[${ts}] 👁️ $${price.toFixed(0)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` +
        ` | SL: $${atrStop.toFixed(0)} | Trail: $${trailStop.toFixed(0)}` +
        ` | Peak: $${position.peakPrice.toFixed(0)}`
      );
      position.lastMonitorLog = Date.now();
    }

  } catch (e) {
    // Silently ignore ticker errors during fast polling
  }
}

async function tick() {
  // Reset daily PnL counter
  const today = new Date().toDateString();
  if (today !== lastResetDay) {
    console.log(`📅 New day — resetting daily PnL (was $${dailyPnL.toFixed(2)})`);
    dailyPnL = 0;
    lastResetDay = today;
  }

  // Kill switch
  if (dailyPnL <= CONFIG.maxDailyLoss) {
    console.log(`🛑 KILL SWITCH — daily loss $${dailyPnL.toFixed(2)} exceeds limit`);
    if (position) await closePosition('kill-switch');
    return;
  }

  // Fetch candles (OHLCV format: [timestamp, open, high, low, close, volume])
  const needed = Math.max(CONFIG.slowPeriod, CONFIG.rsiPeriod, CONFIG.atrPeriod, CONFIG.useTrend ? CONFIG.trendPeriod : 0, CONFIG.useVol ? CONFIG.volPeriod : 0) + 5;
  const candles = await exchange.fetchOHLCV(
    CONFIG.symbol, CONFIG.timeframe, undefined, needed
  );

  if (candles.length < needed) {
    console.log(`⏳ Waiting for data (${candles.length}/${needed} candles)`);
    return;
  }

  const closes = candles.map(c => c[4]);
  const fastEMA = calcEMA(closes, CONFIG.fastPeriod);
  const slowEMA = calcEMA(closes, CONFIG.slowPeriod);
  const rsiVals = CONFIG.useRsi ? calcRSI(closes, CONFIG.rsiPeriod) : null;
  const atrVals = (CONFIG.useAtrStop || CONFIG.useTrailing)
    ? calcATR(candles, CONFIG.atrPeriod) : null;
  const trendMA = CONFIG.useTrend ? calcEMA(closes, CONFIG.trendPeriod) : null;
  const volumes = candles.map(c => c[5]);
  const volSMA = CONFIG.useVol ? calcSMA(volumes, CONFIG.volPeriod) : null;

  const i = closes.length - 1;
  const prevI = i - 1;

  const pf = fastEMA[prevI], ps = slowEMA[prevI];
  const cf = fastEMA[i],     cs = slowEMA[i];
  if (!pf || !ps || !cf || !cs) return;

  const price = closes[i];
  const rsiNow = rsiVals ? rsiVals[i] : null;
  const atrNow = atrVals ? atrVals[i] : null;
  const trendNow = trendMA ? trendMA[i] : null;
  const volNow = candles[i] ? candles[i][5] : null;
  const volSMANow = volSMA ? volSMA[i] : null;
  const golden = pf <= ps && cf > cs;  // bullish crossover
  const death  = pf >= ps && cf < cs;  // bearish crossover

  const ts = new Date().toLocaleTimeString();
  const posInfo = position ? ` | Pos: ${position.side}` : '';
  console.log(
    `[${ts}] $${price.toFixed(2)} | Fast: ${cf.toFixed(2)} | Slow: ${cs.toFixed(2)}` +
    `${rsiNow ? ` | RSI: ${rsiNow.toFixed(1)}` : ''}` +
    `${atrNow ? ` | ATR: ${atrNow.toFixed(2)}` : ''}` +
    `${trendNow ? ` | Trend: ${price > trendNow ? '↑' : '↓'}` : ''}` +
    `${volSMANow ? ` | Vol: ${volNow > volSMANow ? '↑' : '↓'}` : ''}` +
    posInfo +
    (golden ? ' 🟢 GOLDEN CROSS' : '') +
    (death ? ' 🔴 DEATH CROSS' : '')
  );

  // ── STOP-LOSS, TAKE-PROFIT & TRAILING STOP CHECK (in tick) ──
  if (position && atrNow) {
    if (CONFIG.useAtrStop) {
      const stopDist = CONFIG.atrMult * atrNow;
      if (position.side === 'LONG' && price < position.entryPrice - stopDist) {
        console.log('🔴 ATR Stop-Loss hit!');
        await closePosition('atr-stop');
        return;
      }
      if (position.side === 'SHORT' && price > position.entryPrice + stopDist) {
        console.log('🔴 ATR Stop-Loss hit!');
        await closePosition('atr-stop');
        return;
      }
    }
    // Take-Profit check in tick  ← NEW
    if (CONFIG.useTakeProfit) {
      if (position.side === 'LONG' && price >= position.entryPrice + CONFIG.tpPoints) {
        console.log(`🟢 Take-Profit hit! $${price} >= $${(position.entryPrice + CONFIG.tpPoints).toFixed(0)}`);
        await closePosition('take-profit');
        return;
      }
      if (position.side === 'SHORT' && price <= position.entryPrice - CONFIG.tpPoints) {
        console.log(`🟢 Take-Profit hit! $${price} <= $${(position.entryPrice - CONFIG.tpPoints).toFixed(0)}`);
        await closePosition('take-profit');
        return;
      }
    }
    if (CONFIG.useTrailing) {
      const tsDist = CONFIG.trailMult * atrNow;
      if (position.side === 'LONG') {
        if (price > position.peakPrice) position.peakPrice = price;
        if (price < position.peakPrice - tsDist) {
          console.log(`🟡 Trailing Stop hit! (peak: $${position.peakPrice.toFixed(2)})`);
          await closePosition('trail-stop');
          return;
        }
      }
      if (position.side === 'SHORT') {
        if (price < position.troughPrice) position.troughPrice = price;
        if (price > position.troughPrice + tsDist) {
          console.log(`🟡 Trailing Stop hit! (trough: $${position.troughPrice.toFixed(2)})`);
          await closePosition('trail-stop');
          return;
        }
      }
    }
  }

  // Current candle's open timestamp — used to de-duplicate signals
  const candleTime = candles[i][0];

  // ── SIGNAL LOGIC ──
  // BUG FIX: Only act on a crossover ONCE per candle.
  // Without this, when a stop closes the position mid-candle the same
  // crossover signal is still true and would immediately re-open a trade.
  if (golden) {
    if (position?.side === 'SHORT') {
      // Closing opposite side on crossover — always allowed
      await closePosition('crossover');
      lastActedCandleTime = candleTime; // mark this candle as acted
      // Re-fetch price after close so new LONG entry uses current market price
      const freshTicker = await exchange.fetchTicker(CONFIG.symbol);
      const freshPrice = freshTicker.last;
      const rsiBlocked = CONFIG.useRsi && rsiNow !== null && rsiNow > CONFIG.rsiOB;
      const trendBlocked = CONFIG.useTrend && trendNow !== null && freshPrice <= trendNow;
      const volBlocked = CONFIG.useVol && volSMANow !== null && volNow <= volSMANow;
      if (!position && !rsiBlocked && !trendBlocked && !volBlocked) {
        await openPosition('LONG', freshPrice);
      }
    } else if (!position && candleTime !== lastActedCandleTime) {
      // Fresh entry from flat — only if we haven't already acted on this candle
      const rsiBlocked = CONFIG.useRsi && rsiNow !== null && rsiNow > CONFIG.rsiOB;
      const trendBlocked = CONFIG.useTrend && trendNow !== null && price <= trendNow;
      const volBlocked = CONFIG.useVol && volSMANow !== null && volNow <= volSMANow;
      if (!rsiBlocked && !trendBlocked && !volBlocked) {
        lastActedCandleTime = candleTime;
        await openPosition('LONG', price);
      }
    }
  }

  if (death) {
    if (position?.side === 'LONG') {
      // Closing opposite side on crossover — always allowed
      await closePosition('crossover');
      lastActedCandleTime = candleTime;
      if (!CONFIG.longOnly) {
        const freshTicker = await exchange.fetchTicker(CONFIG.symbol);
        const freshPrice = freshTicker.last;
        const rsiBlocked = CONFIG.useRsi && rsiNow !== null && rsiNow < CONFIG.rsiOS;
        const trendBlocked = CONFIG.useTrend && trendNow !== null && freshPrice >= trendNow;
        const volBlocked = CONFIG.useVol && volSMANow !== null && volNow <= volSMANow;
        if (!position && !rsiBlocked && !trendBlocked && !volBlocked) {
          await openPosition('SHORT', freshPrice);
        }
      }
    } else if (!position && !CONFIG.longOnly && candleTime !== lastActedCandleTime) {
      // Fresh entry from flat — only if we haven't already acted on this candle
      const rsiBlocked = CONFIG.useRsi && rsiNow !== null && rsiNow < CONFIG.rsiOS;
      const trendBlocked = CONFIG.useTrend && trendNow !== null && price >= trendNow;
      const volBlocked = CONFIG.useVol && volSMANow !== null && volNow <= volSMANow;
      if (!rsiBlocked && !trendBlocked && !volBlocked) {
        lastActedCandleTime = candleTime;
        await openPosition('SHORT', price);
      }
    }
  }
}

// ─── ORDER EXECUTION ─────────────────────────────────────────
async function openPosition(side, price) {
  try {
    // Cancel any lingering on-chain stop from a previous position  ← NEW
    if (position?.stopOrderId) {
      try {
        await exchange.cancelOrder(position.stopOrderId, CONFIG.symbol);
        console.log(`🗑️  Cancelled old stop order: ${position.stopOrderId}`);
      } catch (cancelErr) {
        // Order may already be filled or cancelled — safe to ignore
      }
    }

    const balance = await exchange.fetchBalance();
    const free = parseFloat(balance.free?.USDC || balance.total?.USDC || 0);
    const positionValue = free * CONFIG.leverage;  // full capital × leverage
    const size = positionValue / price;

    console.log(`\n🟢 OPENING ${side}`);
    console.log(`   Size:    ${size.toFixed(6)} BTC @ $${price.toFixed(2)}`);
    console.log(`   Balance: $${free.toFixed(2)} | Margin: $${free.toFixed(2)} | Notional: $${positionValue.toFixed(2)}`);

    const orderSide = side === 'LONG' ? 'buy' : 'sell';

    const order = await exchange.createOrder(
      CONFIG.symbol,
      'market',
      orderSide,
      size,
      price  // Hyperliquid uses price for slippage protection
    );

    position = {
      side,
      entryPrice: price,
      size,
      peakPrice: price,
      troughPrice: price,
    };
    tradeCount++;
    console.log(`✅ Order filled: ${order.id}`);
    console.log(`   Trade #${tradeCount}`);
    sendDiscordNotification(`🟢 **[SMABot] OPENED ${side}**\n• Price: $${price.toFixed(2)}\n• Size: ${size.toFixed(6)} BTC\n• Notional Value: $${positionValue.toFixed(2)} USDC`);

    // Place on-chain stop-loss order on Hyperliquid
    try {
      const candles = await exchange.fetchOHLCV(CONFIG.symbol, CONFIG.timeframe, undefined, CONFIG.atrPeriod + 5);
      const atrVals = calcATR(candles, CONFIG.atrPeriod);
      const currentATR = atrVals[atrVals.length - 1] || price * 0.02;
      const stopDist = CONFIG.atrMult * currentATR;
      const stopPrice = side === 'LONG'
        ? Math.round(price - stopDist)
        : Math.round(price + stopDist);
      const stopSide = side === 'LONG' ? 'sell' : 'buy';

      const stopOrder = await exchange.createOrder(
        CONFIG.symbol,
        'stop',
        stopSide,
        size,
        stopPrice,
        { stopPrice: stopPrice, reduceOnly: true }
      );
      position.stopOrderId = stopOrder.id;
      console.log(`🛡️  On-chain stop-loss placed at $${stopPrice} (${stopOrder.id})`);
    } catch (stopErr) {
      console.log(`⚠️  Could not place on-chain stop: ${stopErr.message}`);
      console.log(`   Bot will manage stop-loss internally (15s polling)`);
    }
    console.log('');
  } catch (e) {
    console.error(`❌ Failed to open ${side}: ${e.message}`);
  }
}

async function closePosition(reason) {
  if (!position) return;
  try {
    const orderSide = position.side === 'LONG' ? 'sell' : 'buy';
    const ticker = await exchange.fetchTicker(CONFIG.symbol);
    const price = ticker.last;

    console.log(`\n🔴 CLOSING ${position.side} — reason: ${reason}`);

    const order = await exchange.createOrder(
      CONFIG.symbol,
      'market',
      orderSide,
      position.size,
      price
    );

    const pnl = position.side === 'LONG'
      ? (price - position.entryPrice) * position.size
      : (position.entryPrice - price) * position.size;

    dailyPnL += pnl;
    console.log(`   PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Daily: $${dailyPnL.toFixed(2)}`);
    console.log(`✅ Position closed: ${order.id}\n`);
    sendDiscordNotification(`🔴 **[SMABot] CLOSED ${position.side}**\n• Exit Price: $${price.toFixed(2)} (Entry: $${position.entryPrice.toFixed(2)})\n• Reason: \`${reason}\`\n• Trade PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} USDC\n• Daily PnL: $${dailyPnL.toFixed(2)} USDC`);

    position = null;
  } catch (e) {
    console.error(`❌ Failed to close position: ${e.message}`);
  }
}

// ─── UTILITIES ───────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n⏹ Shutting down gracefully...');
  if (position) {
    console.log('⚠️  You have an open position! Close it manually on the Hyperliquid UI.');
  }
  process.exit(0);
});

// ─── START ───────────────────────────────────────────────────
runBot().catch(err => {
  console.error('💀 Fatal error:', err);
  process.exit(1);
});
