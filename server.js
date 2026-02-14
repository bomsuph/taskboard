const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3851;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// JSON "Database"
const DB_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DB_FILE)) {
    return { tasks: [], activity: [], archived: [], comments: [] };
  }
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!data.archived) data.archived = [];
  if (!data.comments) data.comments = [];
  return data;
}

function saveData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// WebSocket clients - Map to store client metadata
const clients = new Map();

// Broadcast message to all connected clients except sender (optional)
function broadcast(message, sender = null) {
  const data = typeof message === 'string' ? message : JSON.stringify(message);
  clients.forEach((metadata, ws) => {
    if (ws !== sender && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
      } catch (e) {
        console.error('WebSocket broadcast error:', e.message);
      }
    }
  });
}

// Broadcast task updates
function broadcastTaskUpdate(type, task, extra = {}) {
  broadcast({
    type: `task:${type}`,
    task,
    timestamp: new Date().toISOString(),
    ...extra
  });
}

// API Routes

// Get all tasks
app.get('/api/tasks', (req, res) => {
  const data = loadData();
  let tasks = data.tasks;
  
  const { project, status } = req.query;
  if (project) tasks = tasks.filter(t => t.project === project);
  if (status) tasks = tasks.filter(t => t.status === status);
  
  // Sort: overdue first, then by priority, then by updated
  const priorityOrder = { urgent: 1, high: 2, normal: 3, low: 4 };
  const now = new Date();
  now.setHours(0,0,0,0);
  
  tasks.sort((a, b) => {
    // Overdue tasks first
    const aOverdue = a.due_date && new Date(a.due_date) < now ? 0 : 1;
    const bOverdue = b.due_date && new Date(b.due_date) < now ? 0 : 1;
    if (aOverdue !== bOverdue) return aOverdue - bOverdue;
    
    const pa = priorityOrder[a.priority] || 3;
    const pb = priorityOrder[b.priority] || 3;
    if (pa !== pb) return pa - pb;
    return new Date(b.updated_at) - new Date(a.updated_at);
  });
  
  res.json(tasks);
});

// Get single task
app.get('/api/tasks/:id', (req, res) => {
  const data = loadData();
  const task = data.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const activity = data.activity.filter(a => a.task_id === req.params.id);
  const comments = (data.comments || []).filter(c => c.task_id === req.params.id);
  const linkedDocuments = (data.taskDocuments || {})[req.params.id] || [];
  res.json({ ...task, activity, comments, linkedDocuments });
});

// Create task
app.post('/api/tasks', (req, res) => {
  const data = loadData();
  const { title, description, status: reqStatus, priority = 'normal', project = 'general', assignee = 'bom', due_date, created_by = 'bom' } = req.body;
  
  if (!title) return res.status(400).json({ error: 'Title is required' });
  
  const now = new Date().toISOString();
  const task = {
    id: uuidv4(),
    title,
    description: description || '',
    status: reqStatus || 'backlog',
    priority,
    project,
    assignee,
    due_date: due_date || null,
    created_at: now,
    updated_at: now,
    created_by
  };
  
  data.tasks.push(task);
  data.activity.push({
    id: Date.now(),
    task_id: task.id,
    action: 'created',
    by: created_by,
    note: `Task created by ${created_by}`,
    created_at: now
  });
  
  saveData(data);
  
  // Broadcast to all clients
  broadcastTaskUpdate('created', task, { created_by });
  
  res.status(201).json(task);
});

// Update task
app.patch('/api/tasks/:id', (req, res) => {
  const data = loadData();
  const taskIndex = data.tasks.findIndex(t => t.id === req.params.id);
  if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });
  
  const task = data.tasks[taskIndex];
  const updates = req.body;
  const now = new Date().toISOString();
  
  // Track status change
  if (updates.status && updates.status !== task.status) {
    data.activity.push({
      id: Date.now(),
      task_id: task.id,
      action: 'moved',
      from_status: task.status,
      to_status: updates.status,
      by: updates.updated_by || 'system',
      note: `Moved from ${task.status} to ${updates.status}`,
      created_at: now
    });
  }
  
  // Track due_date change
  if (updates.due_date !== undefined && updates.due_date !== task.due_date) {
    data.activity.push({
      id: Date.now() + 1,
      task_id: task.id,
      action: 'updated',
      by: updates.updated_by || 'system',
      note: updates.due_date ? `Due date set to ${updates.due_date}` : 'Due date removed',
      created_at: now
    });
  }
  
  // Apply updates
  Object.assign(task, updates, { updated_at: now });
  data.tasks[taskIndex] = task;
  
  saveData(data);
  
  // Broadcast to all clients
  broadcastTaskUpdate('updated', task, { updates });
  
  res.json(task);
});

// Archive task (soft delete)
app.patch('/api/tasks/:id/archive', (req, res) => {
  const data = loadData();
  const index = data.tasks.findIndex(t => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Task not found' });
  
  const task = data.tasks.splice(index, 1)[0];
  const now = new Date().toISOString();
  task.archived_at = now;
  task.updated_at = now;
  data.archived.push(task);
  
  data.activity.push({
    id: Date.now(),
    task_id: task.id,
    action: 'archived',
    by: req.body?.by || 'system',
    note: 'Task archived',
    created_at: now
  });
  
  saveData(data);
  
  // Broadcast to all clients
  broadcastTaskUpdate('archived', task, { archived_at: now });
  
  res.json(task);
});

// Restore task from archive
app.post('/api/tasks/:id/restore', (req, res) => {
  const data = loadData();
  const index = data.archived.findIndex(t => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Archived task not found' });
  
  const task = data.archived.splice(index, 1)[0];
  const now = new Date().toISOString();
  delete task.archived_at;
  task.updated_at = now;
  data.tasks.push(task);
  
  data.activity.push({
    id: Date.now(),
    task_id: task.id,
    action: 'restored',
    by: req.body?.by || 'system',
    note: 'Task restored from archive',
    created_at: now
  });
  
  saveData(data);
  
  // Broadcast to all clients
  broadcastTaskUpdate('restored', task);
  
  res.json(task);
});

// Get archived tasks
app.get('/api/archived', (req, res) => {
  const data = loadData();
  res.json(data.archived || []);
});

// Add comment to task
app.post('/api/tasks/:id/comments', (req, res) => {
  const data = loadData();
  const task = data.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  
  const { text, by = 'bom' } = req.body;
  if (!text) return res.status(400).json({ error: 'Comment text is required' });
  
  const now = new Date().toISOString();
  const comment = {
    id: uuidv4(),
    task_id: req.params.id,
    text,
    by,
    created_at: now
  };
  
  if (!data.comments) data.comments = [];
  data.comments.push(comment);
  
  data.activity.push({
    id: Date.now(),
    task_id: req.params.id,
    action: 'commented',
    by,
    note: `Comment: ${text.slice(0, 100)}`,
    created_at: now
  });
  
  saveData(data);
  
  // Broadcast comment to all clients
  broadcast({
    type: 'task:commented',
    comment,
    task_id: req.params.id,
    timestamp: now
  });
  
  res.status(201).json(comment);
});

// Get comments for task
app.get('/api/tasks/:id/comments', (req, res) => {
  const data = loadData();
  const comments = (data.comments || []).filter(c => c.task_id === req.params.id);
  res.json(comments);
});

// Delete task permanently (from archive)
app.delete('/api/tasks/:id', (req, res) => {
  const data = loadData();
  // Check active tasks first
  let index = data.tasks.findIndex(t => t.id === req.params.id);
  if (index !== -1) {
    data.tasks.splice(index, 1);
  } else {
    // Check archived
    index = data.archived.findIndex(t => t.id === req.params.id);
    if (index !== -1) {
      data.archived.splice(index, 1);
    } else {
      return res.status(404).json({ error: 'Task not found' });
    }
  }
  data.activity = data.activity.filter(a => a.task_id !== req.params.id);
  data.comments = (data.comments || []).filter(c => c.task_id !== req.params.id);
  saveData(data);
  
  // Broadcast deletion
  broadcast({
    type: 'task:deleted',
    task_id: req.params.id,
    timestamp: new Date().toISOString()
  });
  
  res.json({ success: true });
});

// Get stats
app.get('/api/stats', (req, res) => {
  const data = loadData();
  const stats = {
    total: data.tasks.length,
    backlog: data.tasks.filter(t => t.status === 'backlog').length,
    todo: data.tasks.filter(t => t.status === 'todo').length,
    in_progress: data.tasks.filter(t => t.status === 'in-progress').length,
    review: data.tasks.filter(t => t.status === 'review').length,
    done: data.tasks.filter(t => t.status === 'done').length,
    archived: (data.archived || []).length
  };
  res.json(stats);
});

// Team status endpoint
app.get('/api/team', async (req, res) => {
  const instances = [
    { name: 'Alice', configDir: '/home/clawdbot/.clawdbot', workspace: '/home/clawdbot/clawd', port: 18789, emoji: '✨' },
    { name: 'Cloud', configDir: '/home/clawdbot/.clawdbot-cloud', workspace: '/home/clawdbot/cloud', port: 18790, emoji: '☁️' },
    { name: 'Tifa', configDir: '/home/clawdbot/.clawdbot-tifa', workspace: '/home/clawdbot/tifa', port: 18794, emoji: '⚔️' },
    { name: 'Yuna', configDir: '/home/clawdbot/.clawdbot-yuna', workspace: '/home/clawdbot/yuna', port: 18795, emoji: '🌙' }
  ];
  
  const team = [];
  for (const inst of instances) {
    const info = { name: inst.name, emoji: inst.emoji, port: inst.port, status: 'unknown', model: '?', fallbacks: [], workspace: inst.workspace };
    try {
      const configPath = path.join(inst.configDir, 'clawdbot.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const model = config?.agents?.defaults?.model || {};
        info.model = model.primary || '?';
        info.fallbacks = model.fallbacks || [];
        info.cronModel = config?.cron?.model || 'default';
      }
    } catch (e) { /* ignore */ }
    
    try {
      const { execSync } = require('child_process');
      const listening = execSync(`ss -tlnp 2>/dev/null | grep ':${inst.port} '`, { encoding: 'utf8', timeout: 2000 });
      info.status = listening.trim() ? 'online' : 'offline';
    } catch (e) {
      info.status = 'offline';
    }
    
    if (inst.name === 'Alice') {
      try {
        const runtimeConfig = JSON.parse(fs.readFileSync('/home/clawdbot/.openclaw/openclaw.json', 'utf8'));
        const runtimeModel = runtimeConfig?.agents?.defaults?.model;
        if (runtimeModel?.primary) {
          info.model = runtimeModel.primary;
          info.fallbacks = runtimeModel.fallbacks || info.fallbacks;
          info.runtimeOverride = true;
        }
      } catch (e) { /* ignore */ }
    }
    
    team.push(info);
  }
  
  res.json(team);
});

// Second Brain documents endpoint
app.get('/api/brain/documents', (req, res) => {
  const docsDir = '/home/clawdbot/clawd/brain/documents';
  const docs = [];
  
  function scanDir(dir, prefix = '') {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        scanDir(path.join(dir, entry.name), prefix + entry.name + '/');
      } else if (entry.name.endsWith('.md')) {
        try {
          const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          let meta = {};
          if (fmMatch) {
            const lines = fmMatch[1].split('\n');
            for (const line of lines) {
              const m = line.match(/^(\w+):\s*(.+)/);
              if (m) {
                let val = m[2].trim().replace(/^["']|["']$/g, '');
                if (val.startsWith('[')) {
                  try { val = JSON.parse(val.replace(/'/g, '"')); } catch(e) { val = val.replace(/[\[\]]/g, '').split(',').map(s => s.trim()); }
                }
                meta[m[1]] = val;
              }
            }
          }
          const body = fmMatch ? content.slice(fmMatch[0].length).trim() : content;
          docs.push({
            path: prefix + entry.name,
            slug: entry.name.replace('.md', ''),
            ...meta,
            preview: body.slice(0, 300),
            wordCount: body.split(/\s+/).length
          });
        } catch (e) { /* skip */ }
      }
    }
  }
  
  scanDir(docsDir);
  res.json(docs);
});

// Get single brain document
app.get('/api/brain/documents/:type/:slug', (req, res) => {
  const filePath = path.join('/home/clawdbot/clawd/brain/documents', req.params.type, req.params.slug + '.md');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.json({ content: fs.readFileSync(filePath, 'utf8') });
});

// Catch-all: serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server on same HTTP server
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  console.log('WebSocket client connected');
  
  // Store client metadata
  const metadata = { connectedAt: new Date().toISOString() };
  clients.set(ws, metadata);
  
  // Send initial connection confirmation
  ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  
  // Handle messages from clients
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      
      // Handle ping/pong
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        return;
      }
      
      // Handle typing indicator
      if (message.type === 'typing') {
        // Broadcast typing indicator to all OTHER clients
        broadcast({
          type: 'user:typing',
          user: message.user || 'Someone',
          taskId: message.taskId || null
        }, ws);
        return;
      }
      
      // Handle task mutations via WebSocket
      if (message.type === 'task:create') {
        // Check for duplicate processing (could add idempotency token here)
        // Just broadcast for now - actual create happens via API
        broadcastTaskUpdate('created', message.task);
      }
      
      console.log('WebSocket message received:', message.type);
    } catch (e) {
      console.error('WebSocket message parse error:', e.message);
    }
  });
  
  // Handle client disconnect
  ws.on('close', () => {
    console.log('WebSocket client disconnected');
    clients.delete(ws);
  });
  
  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
    clients.delete(ws);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`TaskBoard server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  console.log(`HTTP endpoint: http://localhost:${PORT}`);
});
