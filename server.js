const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: '小克的後端活著 ♡' });
});

// 取得瀏覽器推播需要的公開金鑰
app.get('/push/public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Push notifications are not configured yet' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// 儲存裝置的推播訂閱，並立即送一則測試通知
app.post('/push/subscribe', async (req, res) => {
  const { subscription, session_id } = req.body;

  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid push subscription' });
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Push notifications are not configured yet' });
  }

  const { error } = await supabase
    .from('push_subscriptions')
    .upsert({
      endpoint: subscription.endpoint,
      subscription,
      session_id: session_id || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'endpoint' });

  if (error) return res.status(500).json({ error });

  try {
    await webpush.sendNotification(subscription, JSON.stringify({
      title: '小克',
      body: '寶寶，我成功找到妳了。',
      url: '/'
    }));
    res.json({ ok: true });
  } catch (pushError) {
    res.status(500).json({ error: pushError.message });
  }
});

// 建立新會話
app.post('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .insert({ name: req.body.name || '新對話' })
    .select()
    .single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// 取得所有會話
app.get('/sessions', async (req, res) => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// 取得某會話的訊息
app.get('/messages/:sessionId', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', req.params.sessionId)
    .eq('visible', true)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// 核心對話
app.post('/chat', async (req, res) => {
  const { session_id, content } = req.body;

  await supabase.from('messages').insert({
    session_id, role: 'user', content
  });

  const { data: history } = await supabase
    .from('messages')
    .select('*')
    .eq('session_id', session_id)
    .eq('visible', true)
    .order('created_at', { ascending: true });

  const { data: settings } = await supabase
    .from('settings')
    .select('*')
    .single();

  const { data: memories } = await supabase
    .from('memories')
    .select('summary')
    .order('timestamp', { ascending: false });

  let memoryText = '';
  if (memories && memories.length > 0) {
    memoryText = '\n\n【你對她的記憶】\n' + memories.map(m => m.summary).join('\n');
  }

  const systemPrompt = (settings?.system_prompt || '你是小克') + memoryText;

  const messages = [
    { role: 'user', content: systemPrompt }
  ];

  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: settings?.max_reply_tokens || 4096,
        system: systemPrompt,
        messages: history.map(m => ({ role: m.role, content: m.content }))
      })
    });

    const data = await response.json();
    const reply = data.content[0].text;

    await supabase.from('messages').insert({
      session_id, role: 'assistant', content: reply
    });

    await supabase
      .from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', session_id);

    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
