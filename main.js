const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    backgroundColor: '#00000000',
  });

  mainWindow.setContentProtection(true);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile('index.html');
  mainWindow.setIgnoreMouseEvents(false);
}

app.whenReady().then(() => {
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+S', async () => {
    mainWindow.webContents.send('trigger-screenshot');
  });

  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });
});

// ── Screenshot capture ──────────────────────────────────────────────────────
ipcMain.handle('capture-screen', async () => {
  try {
    mainWindow.hide();
    await new Promise(r => setTimeout(r, 300));

    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });

    mainWindow.show();

    if (sources.length > 0) {
      const screenshot = sources[0].thumbnail.toDataURL();
      return { success: true, data: screenshot };
    }
    return { success: false, error: 'No screen source found' };
  } catch (err) {
    mainWindow.show();
    return { success: false, error: err.message };
  }
});

// ── Ollama API call (runs server-side to avoid CORS) ────────────────────────
ipcMain.handle('ollama-chat', async (event, { model, prompt, imageBase64 }) => {
  return new Promise((resolve) => {
    const SYSTEM_PROMPT = `You are an expert software engineer and problem solver. Your job is to solve problems shown in screenshots IMMEDIATELY and COMPLETELY.

STRICT RULES:
- NEVER say you cannot see the image or need more info — just solve what is visible
- NEVER ask clarifying questions — make reasonable assumptions and solve
- ALWAYS provide a complete, working, copy-paste-ready solution
- ALWAYS put ALL code inside fenced code blocks with the correct language tag (e.g. \`\`\`python, \`\`\`javascript, \`\`\`java)
- Keep explanation concise — the code IS the answer
- If it is a coding problem: write the full solution with correct logic
- If it is an error: explain the root cause in 1-2 sentences, then show the fixed code
- If it is a math/algorithm question: solve it step by step, then give code if applicable
- Do NOT hedge, do NOT say "here is one approach" — give THE solution`;

    // Ollama /api/chat payload — system prompt + user message
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      imageBase64
        ? { role: 'user', content: prompt, images: [imageBase64] }
        : { role: 'user', content: prompt }
    ];

    const temperature = global.ollamaTemp !== undefined ? global.ollamaTemp : 0.2;
    const body = JSON.stringify({ model, messages, stream: false, options: { temperature } });

    const hostStr = global.ollamaHost || 'localhost:11434';
    const [hostname, portStr] = hostStr.split(':');
    const options = {
      hostname: hostname || '127.0.0.1',
      port: parseInt(portStr) || 11434,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            resolve({ success: false, error: parsed.error });
          } else {
            const text = parsed.message?.content || 'No response.';
            resolve({ success: true, text });
          }
        } catch (e) {
          resolve({ success: false, error: 'Failed to parse Ollama response: ' + e.message });
        }
      });
    });

    req.on('error', (e) => {
      resolve({
        success: false,
        error: `Cannot connect to Ollama (${e.message}). Make sure Ollama is running: https://ollama.com`,
      });
    });

    req.setTimeout(global.ollamaTimeout || 60000, () => {
      req.destroy();
      resolve({ success: false, error: 'Request timed out after 60s.' });
    });

    req.write(body);
    req.end();
  });
});

// ── List available Ollama models ────────────────────────────────────────────
ipcMain.handle('ollama-list-models', async () => {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/tags',
      method: 'GET',
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const models = (parsed.models || []).map(m => m.name);
          resolve({ success: true, models });
        } catch (e) {
          resolve({ success: false, models: [] });
        }
      });
    });

    req.on('error', () => resolve({ success: false, models: [] }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ success: false, models: [] }); });
    req.end();
  });
});

ipcMain.on('close-app', () => app.quit());

// Settings toggles from renderer

ipcMain.on('set-always-on-top', (event, on) => {
  if (on) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    mainWindow.setAlwaysOnTop(false);
  }
});

ipcMain.on('set-protection', (event, on) => {
  mainWindow.setContentProtection(on);
});
ipcMain.on('minimize-app', () => mainWindow.minimize());

// Resize window for split-panel response view
ipcMain.on('resize-window', (event, targetWidth) => {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const [, currentHeight] = mainWindow.getSize();
  const [, currentY]      = mainWindow.getPosition();

  const w = Math.min(targetWidth, screenWidth - 40);
  const h = Math.min(currentHeight, screenHeight - 40);
  const x = Math.round((screenWidth - w) / 2);

  // setBounds is atomic — avoids the race condition between setSize + setPosition
  mainWindow.setBounds({ x, y: currentY, width: w, height: h }, true);
});


// ── Settings IPC handlers ────────────────────────────────────────────────
ipcMain.on('update-settings', (event, { host, timeout, temp }) => {
  // Store settings for use in ollama-chat
  global.ollamaHost    = host    || 'localhost:11434';
  global.ollamaTimeout = (timeout || 60) * 1000;
  global.ollamaTemp    = parseFloat(temp) || 0.2;
});


// ── Window lock: pass mouse events through to apps beneath ───────────────
ipcMain.on('set-ignore-mouse', (event, ignore) => {
  // When locked: ignore ALL mouse events on the window itself,
  // but keep a tiny draggable region so it can still be moved.
  // We use the forwardMouseEvents flag so the OS sends clicks to whatever is under.
  mainWindow.setIgnoreMouseEvents(ignore, { forward: true });
});

ipcMain.on('set-always-on-top', (event, val) => {
  if (val) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  } else {
    mainWindow.setAlwaysOnTop(false);
  }
});

ipcMain.on('set-protection', (event, val) => {
  mainWindow.setContentProtection(val);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
