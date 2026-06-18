const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

// PENTING UNTUK VERCEL: Gunakan folder /tmp karena Vercel hanya mengizinkan penulisan file di sana
const SESSION_FILE = path.join('/tmp', "fawwaw-session.json");
const MAX_MESSAGES = 10;
const TIMEOUT = 60000;
const SYSTEM_PROMPT = "Kamu adalah Fawwaw AI, asisten virtual yang sangat cerdas, ramah, dan menggunakan bahasa Indonesia yang santai tapi sopan. Jawablah dengan ringkas dan jelas.";

function now() { return Date.now(); }
function randomId() { return crypto.randomUUID(); }

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

function createSession() {
  return {
    sessionId: randomId(),
    browserId: randomId(),
    createdAt: now(),
    updatedAt: now(),
    messages: []
  };
}

async function getSession() {
  const data = await readJson(SESSION_FILE, null);
  
  if (!data || !Array.isArray(data.messages) || !data.browserId) {
    const fresh = createSession();
    await writeJson(SESSION_FILE, fresh);
    return fresh;
  }
  
  const userCount = data.messages.filter(v => v.role === "user").length;
  if (userCount >= MAX_MESSAGES) {
    const fresh = createSession();
    await writeJson(SESSION_FILE, fresh);
    return fresh;
  }
  return data;
}

function normalizeMessages(messages) {
  return messages.map(v => ({
    pluginId: null,
    content: String(v.content || ""),
    role: v.role
  }));
}

async function handler(args) {
  const { prompt, action } = args;

  if (action === 'delete_session') {
    try {
      await fs.unlink(SESSION_FILE);
      return { message: 'Sesi berhasil dihapus.' };
    } catch (error) {
      return { message: 'Sesi sudah bersih.' };
    }
  }

  if (!prompt) {
    return { error: 'Pesan tidak boleh kosong.' };
  }

  try {
    const session = await getSession();
    
    const messages = [
      ...normalizeMessages(session.messages),
      { pluginId: null, content: prompt, fileList: [], role: "user" }
    ];

    const body = {
      model: {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5",
        maxLength: 12000,
        tokenLimit: 4000,
        completionTokenLimit: 2500,
        deploymentName: "gpt-35"
      },
      messages,
      prompt: SYSTEM_PROMPT,
      temperature: 0.5,
      enableConversationPrompt: false
    };

    const headers = {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "accept": "*/*",
      "content-type": "application/json",
      "origin": "https://chateverywhere.app",
      "referer": "https://chateverywhere.app/id",
      "user-browser-id": session.browserId
    };

    const res = await axios.post("https://chateverywhere.app/api/chat", body, {
      headers,
      timeout: TIMEOUT,
      responseType: "text",
      validateStatus: () => true
    });

    const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data);

    if (res.status >= 200 && res.status < 300) {
      session.messages.push({ role: "user", content: prompt });
      session.messages.push({ role: "assistant", content: text });
      session.updatedAt = now();
      await writeJson(SESSION_FILE, session);
      
      return { message: text };
    } else {
      return { error: `Server tujuan sibuk (Kode ${res.status}).` };
    }
    
  } catch (error) {
    return { error: `Kesalahan internal Vercel: ${error.message}` };
  }
}

app.post('/api/chat', async (req, res) => {
    const { prompt, action } = req.body;
    const result = await handler({ prompt, action });
    res.json(result);
});

// Jalankan server lokal untuk komputer Anda
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server Fawwaw berjalan di http://localhost:${PORT}`);
    });
}

// Ekspor untuk Vercel
module.exports = app;
