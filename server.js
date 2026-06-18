const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs/promises');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

const SESSION_FILE = path.join(__dirname, "qwenai-session.json");

function generateRandomIP() {
    const ranges = [
        [1, 1], [2, 2], [5, 5], [23, 23], [27, 27], [31, 31], [36, 36], [37, 37], [39, 39], [42, 42],
        [46, 46], [49, 49], [50, 50], [60, 60], [114, 114], [117, 117], [118, 118], [119, 119], [120, 120],
        [121, 121], [122, 122], [123, 123], [124, 124], [125, 125], [126, 126], [180, 180], [182, 182], [183, 183]
    ];
    const range = ranges[Math.floor(Math.random() * ranges.length)];
    const ip = [
        range[0],
        Math.floor(Math.random() * 256),
        Math.floor(Math.random() * 256),
        Math.floor(Math.random() * 256)
    ].join('.');
    return ip;
}

async function loadSession() {
  try {
    const raw = await fs.readFile(SESSION_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { chat_id: null };
  }
}

async function saveSession(session) {
  await fs.writeFile(SESSION_FILE, JSON.stringify(session, null, 2), "utf8");
}

async function handler(args) {
  const { action, prompt, model } = args;

  if (action === 'delete_session') {
    try {
      await fs.unlink(SESSION_FILE);
      return { content: [{ type: 'text', text: '{"message": "Session deleted successfully."}' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '{"message": "No session found to delete."}' }] };
    }
  }

  if (!prompt || !model) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: "prompt and model are required for chat" }) }],
      isError: true
    };
  }

  const session = await loadSession();
  const spoofedIp = generateRandomIP();

  // Konfigurasi Puppeteer
  const browser = await puppeteer.launch({
    // JIKA ANDA MENGGUNAKAN TERMUX (HP), HAPUS TANDA // DI BAWAH INI:
    // executablePath: '/data/data/com.termux/files/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    headless: true // Berjalan di latar belakang tanpa membuka jendela browser
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Spoof IP
    await page.setRequestInterception(true);
    page.on('request', interceptedRequest => {
        const headers = interceptedRequest.headers();
        headers['X-Forwarded-For'] = spoofedIp;
        headers['X-Real-IP'] = spoofedIp;
        headers['Client-IP'] = spoofedIp;
        headers['True-Client-IP'] = spoofedIp;
        headers['X-Originating-IP'] = spoofedIp;
        headers['X-Cluster-Client-IP'] = spoofedIp;
        headers['Forwarded'] = `for=${spoofedIp}`;
        interceptedRequest.continue({ headers });
    });

    let apiResolve;
    const apiPromise = new Promise((resolve) => {
        apiResolve = resolve;
    });

    page.on('response', async (response) => {
        const responseEndpoint = response.url();
        if (responseEndpoint.includes('/api/v2/chat/completions') && response.request().method() === 'POST') {
            try {
                const text = await response.text();
                const lines = text.split('\n');
                let answer = "";
                let currentChatId = null;
                for (const line of lines) {
                    if (line.startsWith('data:')) {
                        try {
                            const dataString = line.substring(5).trim();
                            if (!dataString) continue;
                            const data = JSON.parse(dataString);
                            
                            if (data["response.created"] && data["response.created"].chat_id) {
                                currentChatId = data["response.created"].chat_id;
                            }

                            if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
                                answer += data.choices[0].delta.content;
                            }
                        } catch (e) {}
                    }
                }
                apiResolve({ answer, chat_id: currentChatId });
            } catch (e) {}
        }
    });

    // Pergi ke Qwen
    let targetPath = `https://chat.qwen.ai/?model=${model}`;
    if (session.chat_id) {
        targetPath = `https://chat.qwen.ai/c/${session.chat_id}?model=${model}`;
    }
    
    await page.goto(targetPath, { waitUntil: 'networkidle2', timeout: 60000 });
    
    const inputSelector = 'textarea';
    await page.waitForSelector(inputSelector, { timeout: 60000 });

    // Ketik prompt dan enter
    await page.type(inputSelector, prompt);
    await page.keyboard.press('Enter');

    // Tunggu respons dari interception
    const { answer, chat_id } = await apiPromise;

    if (chat_id) {
        session.chat_id = chat_id;
        await saveSession(session);
    }

    await browser.close();

    if (!answer) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: "Gagal menangkap respons dari Qwen" }) }], isError: true };
    }

    return { content: [{ type: 'text', text: JSON.stringify({ message: answer }) }] };

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    return { content: [{ type: 'text', text: JSON.stringify({ error: `Puppeteer Error: ${error.message}` }) }], isError: true };
  }
}

// Endpoint Web
app.post('/api/chat', async (req, res) => {
    // Meminta prompt dan model (kita set default modelnya ke qwen-max jika kosong)
    const { prompt, action, model = "qwen-max" } = req.body;
    
    const result = await handler({ prompt, action, model });
    try {
        const responseData = JSON.parse(result.content[0].text);
        res.json(responseData);
    } catch (e) {
        res.json({ error: result.content[0].text });
    }
});

// Jalankan server HANYA jika dijalankan di localhost
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server berjalan di http://localhost:${PORT}`);
    });
}

// Baris INI SANGAT PENTING untuk Vercel
module.exports = app;
