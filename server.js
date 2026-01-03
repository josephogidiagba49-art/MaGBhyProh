require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests'
});
app.use('/api/', limiter);

// Static files
app.use(express.static('public'));

// Auth key
const MAGIC_KEY = process.env.MAGIC_KEY || uuidv4();
const ADMIN_PASS = process.env.ADMIN_PASS ? 
  bcrypt.hashSync(process.env.ADMIN_PASS, 10) : 
  bcrypt.hashSync('magicpro2024', 10);

// Session simulation
const sessions = new Map();
const templates = new Map();

// 🎯 Global Stats
let MAGIC_STATS = {
  sent: 0,
  rotations: 0,
  errors: 0,
  active: false,
  speed: 0,
  successRate: 100,
  uptime: Date.now(),
  currentCampaign: null
};

// 📦 SMTP Harvesters
const SMTP_HARVESTERS = [
  {
    name: 'GuerrillaMail',
    enabled: true,
    harvest: async () => {
      try {
        const response = await fetch('https://api.guerrillamail.com/ajax.php?f=get_email_address');
        const data = await response.json();
        return {
          user: data.email_addr,
          pass: data.sid_token,
          host: 'smtp.guerrillamail.com',
          port: 587,
          secure: false
        };
      } catch (error) {
        console.error('GuerrillaMail error:', error.message);
        throw error;
      }
    }
  },
  {
    name: 'TempMail',
    enabled: true,
    harvest: async () => {
      let browser;
      try {
        browser = await puppeteer.launch({
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
          timeout: 30000
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        
        await page.goto('https://temp-mail.org/en/', { 
          waitUntil: 'networkidle2',
          timeout: 30000 
        });
        
        await page.waitForSelector('.btn-generate', { timeout: 10000 });
        await page.click('.btn-generate');
        
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const email = await page.$eval('.mail-address', el => el.textContent.trim());
        
        await browser.close();
        
        return {
          user: email,
          pass: `magic_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          host: 'smtp.temp-mail.org',
          port: 587,
          secure: false
        };
      } catch (error) {
        if (browser) await browser.close();
        console.error('TempMail error:', error.message);
        throw error;
      }
    }
  }
];

// Default template
templates.set('default', {
  id: 'default',
  name: 'Security Alert',
  subject: 'Urgent: Security Alert for {{target}}',
  html: `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; color: white; text-align: center;">
        <h1 style="margin: 0;">🔐 Security Alert</h1>
      </div>
      <div style="padding: 30px; background: #f8f9fa;">
        <h2>Important Notice</h2>
        <p>We detected unusual activity on account <strong>{{target}}</strong>.</p>
        <p>Immediate verification required to prevent account suspension.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="{{phish}}" style="background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
            Verify Account Now
          </a>
        </div>
        <p style="color: #666; font-size: 12px;">
          If you didn't request this verification, please ignore this email.
        </p>
      </div>
      <div style="background: #1a202c; color: #a0aec0; padding: 20px; text-align: center; font-size: 12px;">
        <p>© 2024 MagicPro Security System. All rights reserved.</p>
      </div>
    </div>
  `,
  sender: 'Security Team',
  createdAt: new Date().toISOString()
});

// 🔥 Core Functions
async function harvestSMTP(retries = 3) {
  const enabledHarvesters = SMTP_HARVESTERS.filter(h => h.enabled);
  
  for (let attempt = 0; attempt < retries; attempt++) {
    const harvesterIndex = (MAGIC_STATS.rotations + attempt) % enabledHarvesters.length;
    const harvester = enabledHarvesters[harvesterIndex];
    
    try {
      console.log(`Attempting to harvest SMTP from ${harvester.name} (attempt ${attempt + 1})`);
      const smtp = await harvester.harvest();
      
      // Test SMTP connection
      const testTransporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass },
        connectionTimeout: 10000
      });
      
      await testTransporter.verify();
      testTransporter.close();
      
      MAGIC_STATS.rotations++;
      MAGIC_STATS.currentSMTP = harvester.name;
      
      console.log(`Successfully harvested SMTP: ${smtp.user}`);
      return smtp;
    } catch (error) {
      console.error(`Failed to harvest from ${harvester.name}:`, error.message);
      MAGIC_STATS.errors++;
      
      if (attempt === retries - 1) {
        throw new Error(`All SMTP harvesters failed after ${retries} attempts`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
}

async function sendBatch(smtp, targets, template) {
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
    pool: true,
    maxConnections: 10,
    maxMessages: 50,
    connectionTimeout: 10000
  });

  const results = [];
  const startTime = Date.now();
  let sentInBatch = 0;

  for (const target of targets) {
    const email = target.trim();
    
    if (!email.includes('@') || email.length < 5) {
      results.push({ target: email, status: 'invalid', error: 'Invalid email format' });
      continue;
    }

    try {
      const subject = template.subject.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (key === 'target') return email.split('@')[0];
        if (key === 'domain') return email.split('@')[1];
        if (key === 'id') return (MAGIC_STATS.sent + 1).toString();
        if (key === 'date') return new Date().toLocaleDateString();
        return match;
      });

      const html = template.html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (key === 'target') return email;
        if (key === 'email') return email;
        if (key === 'id') return (MAGIC_STATS.sent + 1).toString();
        if (key === 'sender') return smtp.user;
        if (key === 'phish') return template.phishLink || '#';
        if (key === 'date') return new Date().toLocaleDateString();
        if (key === 'time') return new Date().toLocaleTimeString();
        return match;
      });

      await transporter.sendMail({
        from: `"${template.sender || 'MagicPro'}" <${smtp.user}>`,
        to: email,
        subject: subject,
        html: html,
        headers: {
          'X-Mailer': 'MagicPro v3.0',
          'X-Campaign-ID': MAGIC_STATS.currentCampaign || 'unknown'
        }
      });

      MAGIC_STATS.sent++;
      sentInBatch++;
      results.push({ target: email, status: 'success' });

    } catch (error) {
      MAGIC_STATS.errors++;
      results.push({ 
        target: email, 
        status: 'failed', 
        error: error.message 
      });
    }
  }

  await transporter.close();
  
  const elapsedSeconds = (Date.now() - startTime) / 1000;
  MAGIC_STATS.speed = elapsedSeconds > 0 ? Math.round(sentInBatch / elapsedSeconds) : 0;
  
  const totalAttempts = MAGIC_STATS.sent + MAGIC_STATS.errors;
  MAGIC_STATS.successRate = totalAttempts > 0 ? 
    (MAGIC_STATS.sent / totalAttempts) * 100 : 100;

  return results;
}

// 🔐 Authentication Middleware
const requireAuth = (req, res, next) => {
  const token = req.headers['x-magic-token'] || req.query.token;
  if (token && sessions.has(token)) {
    req.user = sessions.get(token);
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
};

// 🚀 API Endpoints

// Login
app.post('/api/login', (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }

    if (bcrypt.compareSync(password, ADMIN_PASS)) {
      const token = uuidv4();
      sessions.set(token, { 
        id: 1, 
        name: 'Admin', 
        loggedIn: Date.now(),
        lastActivity: Date.now()
      });
      
      cleanupSessions();
      
      return res.json({ 
        token, 
        key: MAGIC_KEY,
        user: { name: 'Admin' }
      });
    }
    
    res.status(401).json({ error: 'Invalid credentials' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function cleanupSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now - session.lastActivity > 24 * 60 * 60 * 1000) {
      sessions.delete(token);
    }
  }
}

// Stats endpoint
app.get('/api/stats', requireAuth, (req, res) => {
  try {
    req.user.lastActivity = Date.now();
    sessions.set(req.headers['x-magic-token'], req.user);
    
    res.json({
      ...MAGIC_STATS,
      uptime: Math.floor((Date.now() - MAGIC_STATS.uptime) / 1000),
      activeSessions: sessions.size,
      templates: templates.size,
      smtpProviders: SMTP_HARVESTERS.filter(h => h.enabled).length
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Launch Campaign
app.post('/api/launch', requireAuth, async (req, res) => {
  try {
    const { targets, template, batchSize = 25, campaignName } = req.body;
    
    if (!targets || !template) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const targetList = Array.isArray(targets) 
      ? targets 
      : targets.split('\n')
          .map(t => t.trim())
          .filter(t => t.includes('@') && t.length > 5);
    
    if (targetList.length === 0) {
      return res.status(400).json({ error: 'No valid email targets provided' });
    }

    if (!template.subject || !template.html) {
      return res.status(400).json({ error: 'Invalid template format' });
    }

    MAGIC_STATS.active = true;
    MAGIC_STATS.currentCampaign = campaignName || `Campaign-${Date.now()}`;
    
    const campaignId = uuidv4();
    
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    res.write(`data: ${JSON.stringify({ 
      type: 'started', 
      campaignId, 
      total: targetList.length,
      name: MAGIC_STATS.currentCampaign
    })}\n\n`);

    let totalSent = 0;
    const startTime = Date.now();

    try {
      for (let i = 0; i < targetList.length; i += batchSize) {
        const batch = targetList.slice(i, Math.min(i + batchSize, targetList.length));
        
        const smtp = await harvestSMTP();
        
        const results = await sendBatch(smtp, batch, template);
        
        const successful = results.filter(r => r.status === 'success').length;
        totalSent += successful;
        
        const progress = Math.round((i + batch.length) / targetList.length * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? Math.round(totalSent / elapsed) : 0;
        
        const remaining = targetList.length - (i + batch.length);
        const estimatedTime = speed > 0 ? Math.round(remaining / speed) : 0;
        
        const updateData = {
          type: 'progress',
          progress,
          sent: MAGIC_STATS.sent,
          totalSent,
          batch: batch.length,
          successful,
          failed: results.length - successful,
          smtp: smtp.user.split('@')[1] || smtp.user.substring(0, 20) + '...',
          speed,
          eta: estimatedTime,
          currentBatch: Math.floor(i / batchSize) + 1,
          totalBatches: Math.ceil(targetList.length / batchSize)
        };
        
        res.write(`data: ${JSON.stringify(updateData)}\n\n`);
        
        io.emit('campaign_update', updateData);
        
        if (i + batchSize < targetList.length) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      const finalData = {
        type: 'completed',
        totalSent,
        totalTargets: targetList.length,
        successRate: Math.round((totalSent / targetList.length) * 100),
        duration: Math.round((Date.now() - startTime) / 1000),
        campaignId
      };
      
      res.write(`data: ${JSON.stringify(finalData)}\n\n`);
      io.emit('campaign_completed', finalData);
      
    } catch (error) {
      console.error('Campaign error:', error);
      res.write(`data: ${JSON.stringify({
        type: 'error',
        error: error.message,
        campaignId
      })}\n\n`);
      io.emit('campaign_error', { error: error.message, campaignId });
    } finally {
      MAGIC_STATS.active = false;
      MAGIC_STATS.currentCampaign = null;
      res.end();
    }

  } catch (error) {
    console.error('Launch endpoint error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Template management
app.get('/api/templates', requireAuth, (req, res) => {
  try {
    const templateArray = Array.from(templates.values());
    res.json(templateArray);
  } catch (error) {
    console.error('Templates error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/templates', requireAuth, (req, res) => {
  try {
    const { name, subject, html, sender, category } = req.body;
    
    if (!name || !subject || !html) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const id = uuidv4();
    const template = {
      id,
      name,
      subject,
      html,
      sender: sender || 'MagicPro',
      category: category || 'general',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    templates.set(id, template);
    res.json({ id, success: true, template });
  } catch (error) {
    console.error('Save template error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/templates/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'default') {
      return res.status(400).json({ error: 'Cannot delete default template' });
    }
    
    const deleted = templates.delete(id);
    res.json({ success: deleted });
  } catch (error) {
    console.error('Delete template error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// Serve main application - FIXED VERSION
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  
  // THE FIXED RESPONSE - PROPERLY CLOSED TEMPLATE LITERAL
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MagicPro by Zaza</title>
    <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { font-family: 'Inter', sans-serif; }
        .gradient-bg { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .gradient-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .stat-card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); }
        .glow { box-shadow: 0 0 20px rgba(102, 126, 234, 0.5); }
        .terminal { background: #1a202c; font-family: 'Courier New', monospace; }
        .typewriter { border-right: 2px solid; animation: blink 1s infinite; }
        @keyframes blink { 50% { border-color: transparent; } }
        .gradient-text { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .fade-in { animation: fadeIn 0.5s ease-in; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    </style>
</head>
<body class="bg-gray-900 text-white min-h-screen">
    <div id="app" class="container mx-auto px-4 py-8">
        <!-- Loading screen -->
        <div id="loading" class="flex flex-col items-center justify-center min-h-screen fade-in">
            <div class="relative">
                <div class="w-32 h-32 border-4 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
                <div class="absolute inset-0 flex items-center justify-center">
                    <i class="fas fa-hat-wizard text-4xl text-purple-400"></i>
                </div>
            </div>
            <h1 class="text-4xl font-bold mt-8 gradient-text">
                MagicPro by Zaza
            </h1>
            <p class="mt-4 text-gray-400">Initializing quantum email matrix...</p>
        </div>

        <!-- Login Screen -->
        <div id="login" class="hidden flex-col items-center justify-center min-h-screen">
            <div class="gradient-card rounded-2xl p-8 max-w-md w-full glow">
                <div class="text-center mb-8">
                    <i class="fas fa-hat-wizard text-6xl text-white mb-4"></i>
                    <h1 class="text-3xl font-bold">MagicPro</h1>
                    <p class="text-gray-300 mt-2">by Zaza - Professional Email Platform</p>
                </div>
                <div class="mb-6">
                    <input type="password" id="password" placeholder="Enter access key" 
                           class="w-full p-4 bg-gray-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                           onkeypress="if(event.key === 'Enter') login()">
                </div>
                <button onclick="login()" id="login-btn"
                        class="w-full p-4 gradient-bg rounded-xl font-bold hover:opacity-90 transition flex items-center justify-center">
                    <i class="fas fa-unlock mr-2"></i> Access System
                </button>
                <div class="mt-6 text-center text-sm text-gray-400">
                    <i class="fas fa-shield-alt mr-2"></i> Secured by Zaza Technologies
                </div>
            </div>
        </div>

        <!-- Main Dashboard -->
        <div id="dashboard" class="hidden">
            <!-- Header -->
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                <div>
                    <h1 class="text-4xl font-bold gradient-text">
                        <i class="fas fa-hat-wizard mr-3"></i>MagicPro
                    </h1>
                    <p class="text-gray-400">Professional Email Campaign Platform</p>
                </div>
                <div class="flex items-center space-x-4">
                    <div class="stat-card rounded-xl p-4">
                        <div class="text-sm text-gray-400">Session</div>
                        <div class="text-xl font-bold" id="session-timer">00:00</div>
                    </div>
                    <button onclick="logout()" class="p-3 bg-red-500 rounded-xl hover:bg-red-600 transition" title="Logout">
                        <i class="fas fa-sign-out-alt"></i>
                    </button>
                </div>
            </div>

            <!-- Stats Grid -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <div class="stat-card rounded-2xl p-6 hover:scale-105 transition-transform">
                    <div class="flex justify-between items-center">
                        <div>
                            <div class="text-sm text-gray-400">Emails Sent</div>
                            <div class="text-3xl font-bold" id="stat-sent">0</div>
                        </div>
                        <i class="fas fa-paper-plane text-2xl text-purple-400"></i>
                    </div>
                </div>
                <div class="stat-card rounded-2xl p-6 hover:scale-105 transition-transform">
                    <div class="flex justify-between items-center">
                        <div>
                            <div class="text-sm text-gray-400">Success Rate</div>
                            <div class="text-3xl font-bold" id="stat-success">100%</div>
                        </div>
                        <i class="fas fa-chart-line text-2xl text-green-400"></i>
                    </div>
                </div>
                <div class="stat-card rounded-2xl p-6 hover:scale-105 transition-transform">
                    <div class="flex justify-between items-center">
                        <div>
                            <div class="text-sm text-gray-400">SMTP Rotations</div>
                            <div class="text-3xl font-bold" id="stat-rotations">0</div>
                        </div>
                        <i class="fas fa-sync-alt text-2xl text-blue-400"></i>
                    </div>
                </div>
                <div class="stat-card rounded-2xl p-6 hover:scale-105 transition-transform">
                    <div class="flex justify-between items-center">
                        <div>
                            <div class="text-sm text-gray-400">Speed</div>
                            <div class="text-3xl font-bold" id="stat-speed">0/s</div>
                        </div>
                        <i class="fas fa-tachometer-alt text-2xl text-yellow-400"></i>
                    </div>
                </div>
            </div>

            <!-- Campaign Control -->
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <!-- Left: Campaign Form -->
                <div class="lg:col-span-2">
                    <div class="bg-gray-800 rounded-2xl p-6">
                        <h2 class="text-2xl font-bold mb-6">
                            <i class="fas fa-rocket mr-3"></i>Launch Campaign
                        </h2>
                        
                        <div class="space-y-6">
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-sm font-medium mb-2">Campaign Name</label>
                                    <input type="text" id="campaign-name" value="My Email Campaign"
                                           class="w-full p-4 bg-gray-900 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500">
                                </div>
                                <div>
                                    <label class="block text-sm font-medium mb-2">Batch Size</label>
                                    <input type="number" id="batch-size" value="25" min="1" max="100"
                                           class="w-full p-4 bg-gray-900 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500">
                                </div>
                            </div>

                            <div>
                                <label class="block text-sm font-medium mb-2">Target Emails (one per line)</label>
                                <textarea id="targets" rows="6" 
                                          class="w-full p-4 bg-gray-900 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500"
                                          placeholder="user1@example.com&#10;user2@example.com&#10;user3@example.com"></textarea>
                                <div class="flex justify-between mt-2">
                                    <div class="text-sm text-gray-400" id="target-count">0 targets</div>
                                    <button onclick="addSampleTargets()" class="text-sm text-purple-400 hover:text-purple-300">
                                        <i class="fas fa-magic mr-1"></i> Add Sample Targets
                                    </button>
                                </div>
                            </div>

                            <!-- EMAIL COMPOSER -->
                            <div class="border border-gray-700 rounded-xl p-4">
                                <h3 class="text-lg font-bold mb-4 flex items-center">
                                    <i class="fas fa-edit mr-2"></i> Compose Your Email
                                </h3>
                                
                                <!-- Quick Insert Buttons -->
                                <div class="mb-4">
                                    <label class="block text-sm font-medium mb-2">Quick Insert:</label>
                                    <div class="flex flex-wrap gap-2">
                                        <button onclick="insertPlaceholder('target')" class="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600 text-sm">
                                            {{target}} (Email)
                                        </button>
                                        <button onclick="insertPlaceholder('phish')" class="px-3 py-1 bg-purple-700 rounded hover:bg-purple-600 text-sm">
                                            {{phish}} (Link)
                                        </button>
                                        <button onclick="insertPlaceholder('id')" class="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600 text-sm">
                                            {{id}} (ID)
                                        </button>
                                        <button onclick="insertPlaceholder('date')" class="px-3 py-1 bg-gray-700 rounded hover:bg-gray-600 text-sm">
                                            {{date}} (Date)
                                        </button>
                                    </div>
                                </div>

                                <!-- Subject Line -->
                                <div class="mb-4">
                                    <label class="block text-sm font-medium mb-2">Email Subject</label>
                                    <input type="text" id="subject" value="Important Message for {{target}}"
                                           class="w-full p-4 bg-gray-900 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500">
                                </div>

                                <!-- Action Link Input -->
                                <div class="mb-4">
                                    <label class="block text-sm font-medium mb-2">Action Link (for {{phish}} placeholder)</label>
                                    <input type="text" id="phish-link" placeholder="https://your-link-here.com"
                                           class="w-full p-4 bg-gray-900 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500">
                                </div>

                                <!-- Email Body Editor -->
                                <div>
                                    <label class="block text-sm font-medium mb-2">Email Body (HTML)</label>
                                    <div class="bg-gray-900 rounded-xl p-4">
                                        <textarea id="template" rows="12"
                                                  class="w-full bg-transparent focus:outline-none resize-none font-mono text-sm">
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; color: white; text-align: center;">
        <h1 style="margin: 0;">Important Message</h1>
    </div>
    <div style="padding: 30px; background: #f8f9fa;">
        <h2>Hello {{target}},</h2>
        <p>This is your custom email message.</p>
        <p>Click the link below:</p>
        <div style="text-align: center; margin: 30px 0;">
            <a href="{{phish}}" style="background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
                Take Action
            </a>
        </div>
        <p>Reference ID: {{id}}<br>Date: {{date}}</p>
    </div>
</div>
                                        </textarea>
                                    </div>
                                    <div class="text-xs text-gray-500 mt-2">
                                        Write any HTML email. Use {{target}} for recipient's email, {{phish}} for your link.
                                    </div>
                                </div>
                            </div>

                            <!-- Action Buttons -->
                            <div class="flex flex-wrap gap-4">
                                <button onclick="launchCampaign()" id="launch-btn"
                                        class="flex-1 gradient-bg p-4 rounded-xl font-bold hover:opacity-90 transition flex items-center justify-center">
                                    <i class="fas fa-paper-plane mr-2"></i> Send Emails Now
                                </button>
                                <button onclick="saveTemplate()" id="save-btn"
                                        class="p-4 bg-blue-600 rounded-xl hover:bg-blue-700 transition">
                                    <i class="fas fa-save mr-2"></i> Save
                                </button>
                                <button onclick="clearAll()"
                                        class="p-4 bg-red-600 rounded-xl hover:bg-red-700 transition">
                                    <i class="fas fa-trash mr-2"></i> Clear
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Right: Live Terminal -->
                <div>
                    <div class="bg-gray-800 rounded-2xl p-6 h-full">
                        <h2 class="text-2xl font-bold mb-6">
                            <i class="fas fa-terminal mr-3"></i>Live Terminal
                        </h2>
                        
                        <div class="terminal rounded-xl p-4 h-96 overflow-y-auto" id="terminal">
                            <div class="text-green-400">$ MagicPro v3.0 Ready</div>
                            <div class="text-green-400">$ Write your email in the editor</div>
                            <div class="text-green-400">$ Add links with {{phish}} placeholder</div>
                        </div>

                        <!-- Progress -->
                        <div class="mt-6">
                            <div class="flex justify-between text-sm mb-2">
                                <span>Campaign Progress</span>
                                <span id="progress-percent">0%</span>
                            </div>
                            <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
                                <div id="progress-bar" class="gradient-bg h-full transition-all duration-300" style="width: 0%"></div>
                            </div>
                        </div>

                        <!-- Quick Stats -->
                        <div class="mt-6 space-y-3">
                            <div class="flex justify-between">
                                <span class="text-gray-400">Active SMTP:</span>
                                <span id="current-smtp" class="font-mono text-sm">None</span>
                            </div>
                            <div class="flex justify-between">
                                <span class="text-gray-400">Speed:</span>
                                <span id="current-speed" class="font-mono text-sm">0/s</span>
                            </div>
                        </div>

                        <!-- Quick Templates -->
                        <div class="mt-6">
                            <h3 class="text-sm font-medium mb-3">Quick Templates:</h3>
                            <div class="grid grid-cols-2 gap-2">
                                <button onclick="loadQuickTemplate('security')" class="p-2 bg-gray-700 rounded-lg hover:bg-gray-600 text-xs">
                                    Security Alert
                                </button>
                                <button onclick="loadQuickTemplate('simple')" class="p-2 bg-gray-700 rounded-lg hover:bg-gray-600 text-xs">
                                    Simple Message
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Templates Section -->
            <div class="mt-8">
                <div class="bg-gray-800 rounded-2xl p-6">
                    <div class="flex justify-between items-center mb-6">
                        <h2 class="text-2xl font-bold">
                            <i class="fas fa-layer-group mr-3"></i>Saved Templates
                        </h2>
                        <button onclick="showTemplateModal()" class="p-2 bg-purple-600 rounded-lg hover:bg-purple-700">
                            <i class="fas fa-plus mr-2"></i> New Template
                        </button>
                    </div>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" id="templates-list">
                        <!-- Templates loaded here -->
                    </div>
                </div>
            </div>
        </div>

        <!-- Template Modal -->
        <div id="template-modal" class="hidden fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div class="bg-gray-800 rounded-2xl p-6 max-w-md w-full">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-xl font-bold">Save Template</h3>
                    <button onclick="hideTemplateModal()" class="text-gray-400 hover:text-white">
                        <i class="fas fa-times text-2xl"></i>
                    </button>
                </div>
                <div class="space-y-4">
                    <div>
                        <label class="block text-sm font-medium mb-2">Template Name</label>
                        <input type="text" id="template-name" 
                               class="w-full p-3 bg-gray-900 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500">
                    </div>
                    <div class="flex justify-end space-x-3 pt-4">
                        <button onclick="hideTemplateModal()" class="px-4 py-2 bg-gray-700 rounded-lg hover:bg-gray-600">
                            Cancel
                        </button>
                        <button onclick="confirmSaveTemplate()" class="px-4 py-2 gradient-bg rounded-lg hover:opacity-90">
                            Save Template
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        let authToken = localStorage.getItem('magic_token');
        let sessionStart = Date.now();
        let socket;
        let currentCampaign = null;

        const loading = document.getElementById('loading');
        const loginScreen = document.getElementById('login');
        const dashboard = document.getElementById('dashboard');
        const terminal = document.getElementById('terminal');
        const templatesList = document.getElementById('templates-list');
        const templateModal = document.getElementById('template-modal');

        document.addEventListener('DOMContentLoaded', async () => {
            setTimeout(() => {
                loading.style.display = 'none';
                if (authToken) {
                    verifyToken();
                } else {
                    loginScreen.classList.remove('hidden');
                }
            }, 1000);

            socket = io();
            setupSocketListeners();
            setupEventListeners();
            addSampleTargets();
        });

        async function verifyToken() {
            try {
                const response = await fetch('/api/stats', {
                    headers: { 'x-magic-token': authToken }
                });
                if (response.ok) {
                    loadDashboard();
                } else {
                    localStorage.removeItem('magic_token');
                    authToken = null;
                    loginScreen.classList.remove('hidden');
                }
            } catch (error) {
                console.error('Token verification failed:', error);
                loginScreen.classList.remove('hidden');
            }
        }

        function setupSocketListeners() {
            socket.on('connect', () => {
                logToTerminal('Connected to real-time server', 'success');
            });

            socket.on('campaign_update', (data) => {
                if (data.type === 'progress') {
                    updateProgressDisplay(data);
                }
            });

            socket.on('campaign_completed', (data) => {
                logToTerminal(`Campaign completed! Success: ${data.successRate}%`, 'success');
            });

            socket.on('campaign_error', (data) => {
                logToTerminal(`Campaign error: ${data.error}`, 'error');
            });
        }

        function setupEventListeners() {
            document.getElementById('targets').addEventListener('input', function() {
                const emails = this.value.split('\\n')
                    .filter(e => e.trim())
                    .filter(e => e.includes('@') && e.length > 5);
                document.getElementById('target-count').textContent = `${emails.length} valid targets`;
            });

            document.getElementById('password').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') login();
            });
        }

        async function login() {
            const password = document.getElementById('password').value;
            const btn = document.getElementById('login-btn');
            
            if (!password) {
                alert('Please enter access key');
                return;
            }

            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Authenticating...';
            btn.disabled = true;

            try {
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });

                if (response.ok) {
                    const data = await response.json();
                    authToken = data.token;
                    localStorage.setItem('magic_token', authToken);
                    
                    loginScreen.classList.add('hidden');
                    loadDashboard();
                    logToTerminal('Authentication successful', 'success');
                } else {
                    const error = await response.json();
                    alert(error.error || 'Authentication failed');
                    btn.innerHTML = '<i class="fas fa-unlock mr-2"></i> Access System';
                    btn.disabled = false;
                }
            } catch (error) {
                console.error('Login error:', error);
                alert('Connection error');
                btn.innerHTML = '<i class="fas fa-unlock mr-2"></i> Access System';
                btn.disabled = false;
            }
        }

        function loadDashboard() {
            dashboard.classList.remove('hidden');
            startSessionTimer();
            loadStats();
            loadTemplates();
            setInterval(loadStats, 5000);
        }

        async function loadStats() {
            try {
                const response = await fetch('/api/stats', {
                    headers: { 'x-magic-token': authToken }
                });
                
                if (response.ok) {
                    const stats = await response.json();
                    updateStatsDisplay(stats);
                } else if (response.status === 401) {
                    logout();
                }
            } catch (error) {
                console.error('Failed to load stats:', error);
            }
        }

        function updateStatsDisplay(stats) {
            document.getElementById('stat-sent').textContent = stats.sent.toLocaleString();
            document.getElementById('stat-success').textContent = stats.successRate.toFixed(1) + '%';
            document.getElementById('stat-rotations').textContent = stats.rotations;
            document.getElementById('stat-speed').textContent = stats.speed + '/s';
        }

        // Insert placeholder into email body
        function insertPlaceholder(type) {
            const textarea = document.getElementById('template');
            const placeholder = \`{{\${type}}}\`;
            
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            
            textarea.value = textarea.value.substring(0, start) + 
                             placeholder + 
                             textarea.value.substring(end);
            
            textarea.selectionStart = textarea.selectionEnd = start + placeholder.length;
            textarea.focus();
            
            logToTerminal(\`Inserted placeholder: \${placeholder}\`, 'info');
        }

        async function launchCampaign() {
            const targets = document.getElementById('targets').value;
            const subject = document.getElementById('subject').value;
            const html = document.getElementById('template').value;
            const phishLink = document.getElementById('phish-link').value;
            const campaignName = document.getElementById('campaign-name').value;
            const batchSize = parseInt(document.getElementById('batch-size').value) || 25;

            if (!targets.trim()) {
                alert('Please enter target emails');
                return;
            }

            const btn = document.getElementById('launch-btn');
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> Launching...';
            btn.disabled = true;

            const template = {
                subject,
                html: html.replace(/\\{\\{phish\\}\\}/g, phishLink || '#'),
                sender: 'MagicPro Security',
                phishLink: phishLink || '#'
            };

            try {
                const eventSource = new EventSource(\`/api/launch?token=\${authToken}\`);
                
                eventSource.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        handleCampaignEvent(data);
                    } catch (error) {
                        console.error('Error parsing SSE:', error);
                    }
                };

                eventSource.onerror = (error) => {
                    console.error('SSE error:', error);
                    eventSource.close();
                    btn.innerHTML = '<i class="fas fa-play mr-2"></i> Launch Campaign';
                    btn.disabled = false;
                    logToTerminal('Campaign connection lost', 'error');
                };

                const response = await fetch('/api/launch', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-magic-token': authToken
                    },
                    body: JSON.stringify({ 
                        targets, 
                        template, 
                        batchSize,
                        campaignName 
                    })
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.error || 'Failed to start campaign');
                }

            } catch (error) {
                console.error('Campaign error:', error);
                alert('Failed to launch campaign: ' + error.message);
                btn.innerHTML = '<i class="fas fa-play mr-2"></i> Launch Campaign';
                btn.disabled = false;
            }
        }

        function handleCampaignEvent(data) {
            switch(data.type) {
                case 'started':
                    logToTerminal(\`Campaign "\${data.name}" started with \${data.total} targets\`, 'info');
                    currentCampaign = data.campaignId;
                    break;
                    
                case 'progress':
                    updateProgressDisplay(data);
                    break;
                    
                case 'completed':
                    logToTerminal(\`Campaign completed! Sent: \${data.totalSent}/\${data.totalTargets} (\${data.successRate}% success)\`, 'success');
                    document.getElementById('launch-btn').innerHTML = '<i class="fas fa-play mr-2"></i> Launch Campaign';
                    document.getElementById('launch-btn').disabled = false;
                    currentCampaign = null;
                    break;
                    
                case 'error':
                    logToTerminal(\`Campaign error: \${data.error}\`, 'error');
                    document.getElementById('launch-btn').innerHTML = '<i class="fas fa-play mr-2"></i> Launch Campaign';
                    document.getElementById('launch-btn').disabled = false;
                    currentCampaign = null;
                    break;
            }
        }

        function updateProgressDisplay(data) {
            document.getElementById('progress-bar').style.width = data.progress + '%';
            document.getElementById('progress-percent').textContent = data.progress + '%';
            document.getElementById('current-smtp').textContent = data.smtp || 'None';
            document.getElementById('current-speed').textContent = data.speed + '/s';
            
            if (data.eta > 0) {
                const minutes = Math.floor(data.eta / 60);
                const seconds = data.eta % 60;
                document.getElementById('eta').textContent = \`\${minutes}:\${seconds.toString().padStart(2, '0')}\`;
            }
            
            logToTerminal(\`Batch \${data.currentBatch}: \${data.successful} sent, \${data.failed} failed\`, 'info');
        }

        function logToTerminal(message, type = 'info') {
            const terminal = document.getElementById('terminal');
            const now = new Date();
            const time = now.toLocaleTimeString();
            
            let color = 'text-green-400';
            if (type === 'error') color = 'text-red-400';
            if (type === 'warning') color = 'text-yellow-400';
            if (type === 'success') color = 'text-green-400';
            
            const line = \`<div class="\${color}"><span class="text-gray-500">[\${time}]</span> \${message}</div>\`;
            terminal.innerHTML += line;
            terminal.scrollTop = terminal.scrollHeight;
        }

        async function loadTemplates() {
            try {
                const response = await fetch('/api/templates', {
                    headers: { 'x-magic-token': authToken }
                });
                
                if (response.ok) {
                    const templates = await response.json();
                    renderTemplates(templates);
                }
            } catch (error) {
                console.error('Failed to load templates:', error);
            }
        }

        function renderTemplates(templates) {
            if (!templates.length) {
                templatesList.innerHTML = '<div class="col-span-3 text-center text-gray-500 py-8">No templates saved yet</div>';
                return;
            }

            templatesList.innerHTML = templates.map(template => \`
                <div class="bg-gray-900 rounded-xl p-4 hover:bg-gray-800 cursor-pointer transition">
                    <div class="flex justify-between items-center mb-2">
                        <h3 class="font-bold truncate">\${template.name}</h3>
                    </div>
                    <p class="text-sm text-gray-400 truncate mb-3">\${template.subject}</p>
                    <div class="flex justify-between text-xs text-gray-500">
                        <button onclick="loadTemplate('\${template.id}')" class="text-purple-400 hover:text-purple-300">
                            <i class="fas fa-edit mr-1"></i> Load
                        </button>
                        \${template.id !== 'default' ? \`
                        <button onclick="deleteTemplate('\${template.id}')" class="text-red-400 hover:text-red-300">
                            <i class="fas fa-trash mr-1"></i> Delete
                        </button>
                        \` : ''}
                    </div>
                </div>
            \`).join('');
        }

        async function loadTemplate(templateId) {
            try {
                const response = await fetch('/api/templates', {
                    headers: { 'x-magic-token': authToken }
                });
                
                if (response.ok) {
                    const templates = await response.json();
                    const template = templates.find(t => t.id === templateId);
                    
                    if (template) {
                        document.getElementById('subject').value = template.subject;
                        document.getElementById('template').value = template.html;
                        logToTerminal(\`Loaded template: \${template.name}\`, 'success');
                    }
                }
            } catch (error) {
                console.error('Failed to load template:', error);
            }
        }

        function showTemplateModal() {
            templateModal.classList.remove('hidden');
        }

        function hideTemplateModal() {
            templateModal.classList.add('hidden');
        }

        async function confirmSaveTemplate() {
            const name = document.getElementById('template-name').value;
            
            if (!name.trim()) {
                alert('Please enter a template name');
                return;
            }

            const template = {
                name,
                subject: document.getElementById('subject').value,
                html: document.getElementById('template').value,
                sender: 'MagicPro',
                category: 'custom'
            };

            try {
                const response = await fetch('/api/templates', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-magic-token': authToken
                    },
                    body: JSON.stringify(template)
                });

                if (response.ok) {
                    hideTemplateModal();
                    loadTemplates();
                    logToTerminal(\`Template "\${name}" saved successfully\`, 'success');
                } else {
                    const error = await response.json();
                    alert(error.error || 'Failed to save template');
                }
            } catch (error) {
                console.error('Save template error:', error);
                alert('Failed to save template');
            }
        }

        function saveTemplate() {
            showTemplateModal();
        }

        function loadQuickTemplate(type) {
            if (type === 'security') {
                document.getElementById('subject').value = 'Urgent: Security Alert for {{target}}';
                document.getElementById('template').value = \`
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; color: white; text-align: center;">
        <h1 style="margin: 0;">🔐 Security Alert</h1>
    </div>
    <div style="padding: 30px; background: #f8f9fa;">
        <h2>Important Security Notice</h2>
        <p>Dear {{target}},</p>
        <p>We detected unusual login activity on your account.</p>
        <p>Please verify your identity immediately:</p>
        <div style="text-align: center; margin: 30px 0;">
            <a href="{{phish}}" style="background: #dc3545; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
                Verify Your Account
            </a>
        </div>
        <p style="color: #666; font-size: 14px;">
            If you didn't attempt to login, please secure your account.
        </p>
    </div>
</div>\`;
                logToTerminal('Loaded security template', 'success');
            } else if (type === 'simple') {
                document.getElementById('subject').value = 'Message for {{target}}';
                document.getElementById('template').value = \`
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: #f8f9fa; padding: 30px;">
        <h2>Hello {{target}},</h2>
        <p>This is a simple message from MagicPro.</p>
        <p>Click the link below:</p>
        <p style="margin: 20px 0;">
            <a href="{{phish}}" style="color: #667eea; text-decoration: none;">
                Click here → {{phish}}
            </a>
        </p>
        <p>Best regards,<br>MagicPro Team</p>
    </div>
</div>\`;
                logToTerminal('Loaded simple template', 'success');
            }
        }

        async function deleteTemplate(templateId) {
            if (!confirm('Are you sure you want to delete this template?')) return;

            try {
                const response = await fetch(\`/api/templates/\${templateId}\`, {
                    method: 'DELETE',
                    headers: { 'x-magic-token': authToken }
                });

                if (response.ok) {
                    loadTemplates();
                    logToTerminal('Template deleted', 'success');
                }
            } catch (error) {
                console.error('Delete template error:', error);
                alert('Failed to delete template');
            }
        }

        function clearAll() {
            if (confirm('Clear all campaign fields?')) {
                document.getElementById('targets').value = '';
                document.getElementById('subject').value = 'Important Message for {{target}}';
                document.getElementById('template').value = '';
                document.getElementById('phish-link').value = '';
                document.getElementById('campaign-name').value = 'My Email Campaign';
                document.getElementById('target-count').textContent = '0 targets';
                logToTerminal('All fields cleared', 'info');
            }
        }

        function addSampleTargets() {
            const samples = Array.from({length: 10}, (_, i) => 
                \`user\${i + 1}@example.com\`
            ).join('\\n');
            document.getElementById('targets').value = samples;
            
            const emails = samples.split('\\n').filter(e => e.includes('@') && e.length > 5);
            document.getElementById('target-count').textContent = \`\${emails.length} valid targets\`;
            
            logToTerminal('Added sample targets', 'info');
        }

        function startSessionTimer() {
            setInterval(() => {
                const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
                const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
                const seconds = (elapsed % 60).toString().padStart(2, '0');
                document.getElementById('session-timer').textContent = \`\${minutes}:\${seconds}\`;
            }, 1000);
        }

        function logout() {
            localStorage.removeItem('magic_token');
            window.location.reload();
        }
    </script>
</body>
</html>
`);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`
✨ MagicPro by Zaza v3.0
🌐 Server: http://localhost:${PORT}
🔐 Access Key: magicpro2024
🎯 Ready for deployment
  `);
});