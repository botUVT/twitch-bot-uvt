import { Client } from 'tmi.js';
import fs from 'fs';

// Configuración del bot usando variables de entorno
const BOT_USERNAME = process.env.BOT_USERNAME || '0xjuandi';
const OAUTH_TOKEN = process.env.OAUTH_TOKEN;
const CHANNELS = process.env.CHANNELS ? process.env.CHANNELS.split(',') : ['0xjuandi', 'karenngo', '0xultravioleta'];

// Verificar que tenemos el token OAuth
if (!OAUTH_TOKEN) {
  console.error('❌ OAUTH_TOKEN no está configurado en las variables de entorno');
  process.exit(1);
}

console.log(`🤖 Iniciando bot: ${BOT_USERNAME}`);
console.log(`📺 Canales: ${CHANNELS.join(', ')}`);

// Crear cliente
const client = new Client({
  identity: { username: BOT_USERNAME, password: OAUTH_TOKEN },
  channels: CHANNELS
});

const lastMessage = new Map();

// Expresión regular para detectar direcciones de wallet de Ethereum
const walletRegex = /\b0x[a-fA-F0-9]{40}\b/g;

// Cache para el precio de UVT
let uvtPriceCache = null;
let lastUvtFetch = 0;
const CACHE_DURATION = 30000; // 30 segundos

// Función para obtener el precio de UVT
async function getUVTPrice() {
  const now = Date.now();
  
  if (uvtPriceCache && (now - lastUvtFetch) < CACHE_DURATION) {
    return uvtPriceCache;
  }

  const tokenAddress = '0x281027C6a46142D6FC57f12665147221CE69Af33';

  const attempts = [
    // Intento 1: DexScreener por dirección de token
    async () => {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
      if (!response.ok) throw new Error(`DexScreener tokens: HTTP ${response.status}`);
      return await response.json();
    },
    
    // Intento 2: DexScreener búsqueda
    async () => {
      const response = await fetch('https://api.dexscreener.com/latest/dex/search/?q=UVT');
      if (!response.ok) throw new Error(`DexScreener search: HTTP ${response.status}`);
      return await response.json();
    },
    
    // Intento 3: CoinGecko
    async () => {
      const response = await fetch(`https://api.coingecko.com/api/v3/simple/token_price/avalanche?contract_addresses=${tokenAddress}&vs_currencies=usd&include_24hr_change=true`);
      if (!response.ok) throw new Error(`CoinGecko: HTTP ${response.status}`);
      const data = await response.json();
      
      if (data[tokenAddress.toLowerCase()]) {
        return {
          source: 'coingecko',
          price: data[tokenAddress.toLowerCase()].usd,
          priceChange24h: data[tokenAddress.toLowerCase()].usd_24h_change
        };
      }
      throw new Error('Token no encontrado en CoinGecko');
    }
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      console.log(`🔍 Intentando fuente ${i + 1}...`);
      const data = await attempts[i]();
      
      // Procesar respuesta de CoinGecko
      if (data.source === 'coingecko') {
        uvtPriceCache = {
          price: data.price,
          priceChange24h: data.priceChange24h,
          symbol: 'UVT'
        };
        lastUvtFetch = now;
        console.log('✅ Precio obtenido de CoinGecko:', uvtPriceCache);
        return uvtPriceCache;
      }
      
      // Procesar respuesta de DexScreener
      let pairs = [];
      if (data.pairs && Array.isArray(data.pairs)) {
        pairs = data.pairs;
      }
      
      if (pairs.length > 0) {
        let bestPair = pairs.find(pair => 
          pair.baseToken?.address?.toLowerCase() === tokenAddress.toLowerCase() ||
          pair.baseToken?.symbol?.toLowerCase() === 'uvt'
        );
        
        if (!bestPair) {
          bestPair = pairs[0];
        }
        
        if (bestPair && bestPair.priceUsd) {
          const price = parseFloat(bestPair.priceUsd);
          const priceChange24h = bestPair.priceChange && bestPair.priceChange.h24 ? 
            parseFloat(bestPair.priceChange.h24) : null;
          
          uvtPriceCache = {
            price: price,
            priceChange24h: priceChange24h,
            symbol: bestPair.baseToken?.symbol || 'UVT',
            marketCap: bestPair.marketCap ? parseFloat(bestPair.marketCap) : null,
            volume24h: bestPair.volume?.h24 ? parseFloat(bestPair.volume.h24) : null,
            liquidity: bestPair.liquidity?.usd ? parseFloat(bestPair.liquidity.usd) : null,
            dex: bestPair.dexId ? bestPair.dexId.charAt(0).toUpperCase() + bestPair.dexId.slice(1) : null,
            fdv: bestPair.fdv ? parseFloat(bestPair.fdv) : null
          };
          
          lastUvtFetch = now;
          console.log('✅ Precio obtenido de DexScreener:', uvtPriceCache);
          return uvtPriceCache;
        }
      }
      
    } catch (error) {
      console.log(`❌ Fuente ${i + 1} falló:`, error.message);
      continue;
    }
  }
  
  console.error('❌ Todas las fuentes de precio fallaron para UVT');
  return null;
}

// Función para formatear números grandes
function formatNumber(num) {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(2)}M`;
  } else if (num >= 1000) {
    return `${(num / 1000).toFixed(2)}K`;
  } else {
    return num.toFixed(2);
  }
}

// Función para formatear el precio de UVT
function formatUVTPrice(price) {
  if (price < 0.000001) {
    return `${price.toFixed(10).replace(/\.?0+$/, '')}`;
  } else if (price < 0.001) {
    return `${price.toFixed(8).replace(/\.?0+$/, '')}`;
  } else if (price < 1) {
    return `${price.toFixed(6).replace(/\.?0+$/, '')}`;
  } else {
    return `${price.toFixed(6)}`;
  }
}

// Función para manejar el comando UVT
async function handleUVTPrice(channel, args) {
  try {
    const priceData = await getUVTPrice();
    
    if (!priceData) {
      client.say(channel, `/me 💜 No se pudo obtener el precio de UVT en este momento.`);
      return;
    }

    const price = priceData.price;

    // Si hay argumentos, es una conversión
    if (args && args.length > 0) {
      const amountStr = args[0].replace(/[,\.]/g, match => match === ',' ? '' : '.');
      const amount = parseFloat(amountStr);
      
      if (isNaN(amount) || amount <= 0) {
        client.say(channel, `/me 💜 Por favor ingresa una cantidad válida de UVT. Ejemplo: $uvt 100000`);
        return;
      }

      const usdValue = amount * price;
      const amountFormatted = formatNumber(amount);
      const usdFormatted = usdValue >= 0.01 ? `${usdValue.toFixed(2)}` : `${usdValue.toFixed(6).replace(/\.?0+$/, '')}`;
      
      client.say(channel, `/me 💜 ${amountFormatted} UVT = ${usdFormatted} USD`);
      return;
    }

    // Mostrar información del precio
    const priceFormatted = formatUVTPrice(price);
    let message = `💜 ${priceData.symbol}: ${priceFormatted}`;
    
    if (priceData.priceChange24h !== null) {
      const changeIcon = priceData.priceChange24h >= 0 ? '📈' : '📉';
      const changeFormatted = Math.abs(priceData.priceChange24h).toFixed(2);
      const changeSign = priceData.priceChange24h >= 0 ? '+' : '-';
      message += ` (${changeIcon} ${changeSign}${changeFormatted}% 24h)`;
    }
    
    if (priceData.marketCap) {
      const mcFormatted = priceData.marketCap > 1000000 
        ? `${(priceData.marketCap / 1000000).toFixed(2)}M`
        : `${(priceData.marketCap / 1000).toFixed(0)}K`;
      message += ` • MC: ${mcFormatted}`;
    }
    
    if (priceData.volume24h) {
      const volFormatted = priceData.volume24h > 1000 
        ? `${(priceData.volume24h / 1000).toFixed(1)}K`
        : `${priceData.volume24h.toFixed(0)}`;
      message += ` • Vol: ${volFormatted}`;
    }
    
    if (priceData.liquidity) {
      const liqFormatted = priceData.liquidity > 1000000 
        ? `${(priceData.liquidity / 1000000).toFixed(2)}M`
        : `${(priceData.liquidity / 1000).toFixed(0)}K`;
      message += ` • Liq: ${liqFormatted}`;
    }
    
    if (priceData.dex) {
      message += ` • ${priceData.dex}`;
    }
    
    client.say(channel, `/me ${message}`);
    
  } catch (error) {
    console.error('❌ Error en handleUVTPrice:', error);
    client.say(channel, `/me 💜 Error al consultar el precio de UVT.`);
  }
}

// Función para guardar wallet (modificada para Render)
function saveWalletToFile(username, wallet) {
  const data = { username, wallet, timestamp: new Date().toISOString() };

  fs.readFile('wallets.json', (err, fileData) => {
    let wallets = [];

    if (err) {
      if (err.code === 'ENOENT') {
        console.log('📁 Creando archivo de wallets...');
      } else {
        console.error('❌ Error al leer archivo:', err);
      }
    } else {
      try {
        wallets = JSON.parse(fileData);
      } catch (e) {
        console.error('❌ Error al parsear JSON:', e);
        wallets = [];
      }
    }

    const userWalletExists = wallets.some(entry => entry.username === username && entry.wallet === wallet);

    if (!userWalletExists) {
      wallets.push(data);

      fs.writeFile('wallets.json', JSON.stringify(wallets, null, 2), (err) => {
        if (err) {
          console.error('❌ Error al guardar wallet:', err);
        } else {
          console.log(`💾 Wallet guardada para ${username}: ${wallet}`);
        }
      });
    } else {
      console.log(`💾 Wallet ya existe para ${username}: ${wallet}`);
    }
  });
}

// Función para comandos de porcentaje
function handlePercentageCommand(tags, channel, command, targetUser) {
  const username = targetUser || `@${tags.username}`;
  let percentage;
  
  const specialUsers = ['iNichelt_GO', '@iNichelt_GO', 'Nich'];

  if (command === 'zorri' && (specialUsers.includes(targetUser) || specialUsers.includes(tags.username))) {
    percentage = 100;
  } else {
    percentage = Math.floor(Math.random() * 100);
  }

  const responses = {
    'gay': `${username} eres un ${Math.floor(Math.random() * 100)}% gay 🌈`,
    'zorri': `${username} tienes un ${percentage}% de zorrita 🦊`
  };

  if (responses[command]) {
    client.say(channel, `/me ${responses[command]}`);
  }
}

// Función para pirámide
function handlePyramid(channel, args) {
  if (!args.length) {
    client.say(channel, `/me ¡Debes proporcionar un emote o palabra para la pirámide!`);
    return;
  }

  const emote = args[0];
  const height = Math.min(Number(args[1]) || 3, 10);

  if (isNaN(height) || height < 2) {
    client.say(channel, `/me Debes especificar un número válido mayor a 1.`);
    return;
  }

  const pyramid = [...Array(height).keys()].map(i => `${emote} `.repeat(i + 1).trim());
  const fullPyramid = [...pyramid, ...pyramid.slice(0, -1).reverse()];

  fullPyramid.forEach((row, index) => {
    setTimeout(() => client.say(channel, `/me ${row}`), index * 1000);
  });
}

// Comandos disponibles
const commands = {
  'uvt': (tags, channel, args) => handleUVTPrice(channel, args)
};

// Manejo de mensajes
client.on('message', (channel, tags, message, self) => {
  if (self) return;

  const args = message.trim().split(' ');
  const command = args.shift().toLowerCase();

  const userId = tags['user-id'];
  if (lastMessage.get(userId) === message) return;
  lastMessage.set(userId, message);

  // Verificar wallets
  const walletMatches = message.match(walletRegex);
  if (walletMatches && walletMatches.length === 1 && message.trim() === walletMatches[0]) {
    walletMatches.forEach((wallet) => {
      saveWalletToFile(tags.username, wallet);
    });
  }

  // Comandos con prefijo "$"
  if (command.startsWith('$') && commands[command.slice(1)]) {
    commands[command.slice(1)](tags, channel, args);
  }
  // Respuesta al ":D"
  else if (message === ":D") {
    client.say(channel, "LUL");
  }
  // Respuesta a texto específico
  else if (message.toLowerCase().includes("akjsdhksajhdkjsahdjkashdjk")) {
    client.say(channel, "Que quiere 🥱");
  }
});

// Conexión del bot
client.connect().then(() => {
  console.log('🎉 Bot conectado exitosamente!');
}).catch(error => {
  console.error('❌ Error conectando el bot:', error);
});

client.on('join', (channel, username, self) => {
  if (self) {
    console.log(`✅ Bot unido a ${channel}`);
  }
});

client.on('disconnected', (reason) => {
  console.log('❌ Bot desconectado:', reason);
});

// Mantener el proceso activo
process.on('SIGINT', () => {
  console.log('🛑 Cerrando bot...');
  client.disconnect();
  process.exit(0);
});

// Health check endpoint para mantener activo el servicio
const PORT = process.env.PORT || 3000;
import { createServer } from 'http';

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      uptime: process.uptime(),
      channels: CHANNELS,
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Twitch Bot UVT está funcionando! 🤖');
  }
});

server.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP corriendo en puerto ${PORT}`);
});
