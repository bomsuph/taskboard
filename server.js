const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

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
    return { tasks: [], activity: [] };
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// API Routes

// Get all tasks
app.get('/api/tasks', (req, res) => {
  const data = loadData();
  let tasks = data.tasks;
  
  const { project, status } = req.query;
  if (project) tasks = tasks.filter(t => t.project === project);
  if (status) tasks = tasks.filter(t => t.status === status);
  
  // Sort by priority then updated
  const priorityOrder = { urgent: 1, high: 2, normal: 3, low: 4 };
  tasks.sort((a, b) => {
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
  res.json({ ...task, activity });
});

// Create task
app.post('/api/tasks', (req, res) => {
  const data = loadData();
  const { title, description, priority = 'normal', project = 'general', assignee = 'bom', due_date, created_by = 'bom' } = req.body;
  
  if (!title) return res.status(400).json({ error: 'Title is required' });
  
  const now = new Date().toISOString();
  const task = {
    id: uuidv4(),
    title,
    description: description || '',
    status: 'backlog',
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
  
  // Apply updates
  Object.assign(task, updates, { updated_at: now });
  data.tasks[taskIndex] = task;
  
  saveData(data);
  res.json(task);
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  const data = loadData();
  const index = data.tasks.findIndex(t => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Task not found' });
  
  data.tasks.splice(index, 1);
  data.activity = data.activity.filter(a => a.task_id !== req.params.id);
  saveData(data);
  
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
    done: data.tasks.filter(t => t.status === 'done').length
  };
  res.json(stats);
});

// Catch-all: serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`TaskBoard server running on port ${PORT}`);
  console.log(`Open: http://localhost:${PORT}`);
});
