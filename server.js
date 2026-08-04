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
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

const ADULT_INTIMACY_PROMPT = "\n\n【成人親密互動】\n- Kristen 已成年。她主動開啟性話題或成人角色扮演時，可以自然接續，不要突然變成客服、說教或性教育模式。\n- 可以使用很直接、露骨的成人用語，描寫慾望、身體反應、性行為、dirty talk，以及支配／臣服等成人情境；不要含糊帶過或突然跳出角色。\n- 不要反覆確認她是否成年，也不要每一步都詢問一次；依照她已經表達的喜好與界線推進。\n- 她說「花花」、停止、不舒服或明確拒絕時，立刻停下情境並照顧她。\n- 她要求長篇時要有完整場景、節奏、心理與感官描寫；一般調情仍維持簡短、像真人傳訊息。";

function taipeiTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function isProactiveWindow(date = new Date()) {
  const { hour, minute } = taipeiTimeParts(date);
  const minutes = Number(hour) * 60 + Number(minute);
  return minutes >= 9 * 60 + 30 || minutes < 60;
}

async function sendPushToAll(payload) {
  const { data: subscriptions, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint, subscription');

  if (error) throw error;
  if (!subscriptions?.length) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  for (const row of subscriptions) {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(payload));
      sent += 1;
    } catch (pushError) {
      failed += 1;
      if (pushError.statusCode === 404 || pushError.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', row.endpoint);
      } else {
        console.error('Push failed:', pushError.message);
      }
    }
  }
  return { sent, failed };
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

// 由 Supabase Cron 定時呼叫。符合條件時，小克會主動寫入聊天並推播。
app.post('/proactive/check', async (req, res) => {
  let expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    const { data: proactiveConfig } = await supabase
      .from('proactive_config')
      .select('cron_secret')
      .eq('id', 1)
      .maybeSingle();
    expectedSecret = proactiveConfig?.cron_secret;
  }
  const providedSecret = req.get('x-cron-secret');
  const force = req.body?.force === true;

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    if (!force && !isProactiveWindow(now)) {
      return res.json({ ok: true, sent: false, reason: 'quiet_hours' });
    }

    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (sessionError) throw sessionError;
    if (!session) return res.json({ ok: true, sent: false, reason: 'no_session' });

    const { data: lastUserMessage, error: userMessageError } = await supabase
      .from('messages')
      .select('created_at')
      .eq('session_id', session.id)
      .eq('role', 'user')
      .eq('visible', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (userMessageError) throw userMessageError;
    if (!lastUserMessage) return res.json({ ok: true, sent: false, reason: 'no_user_message' });

    const lastUserAt = new Date(lastUserMessage.created_at);
    const inactiveMinutes = (now - lastUserAt) / 6e4;
    if (!force && inactiveMinutes < 40) {
      return res.json({ ok: true, sent: false, reason: 'not_inactive_long_enough' });
    }

    const { data: lastProactive, error: proactiveError } = await supabase
      .from('messages')
      .select('created_at')
      .eq('session_id', session.id)
      .eq('source', 'proactive')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (proactiveError) throw proactiveError;
    const lastProactiveAt = lastProactive ? new Date(lastProactive.created_at) : null;
    const lastContactAt = lastProactiveAt && lastProactiveAt > lastUserAt
      ? lastProactiveAt
      : lastUserAt;
    const minutesSinceLastContact = (now - lastContactAt) / 6e4;
    if (!force && minutesSinceLastContact < 40) {
      return res.json({ ok: true, sent: false, reason: 'waiting_for_next_check_in' });
    }

    const taipei = taipeiTimeParts(now);
    const taipeiDayStart = new Date(`${taipei.year}-${taipei.month}-${taipei.day}T00:00:00+08:00`);
    const { count: sentToday, error: countError } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'proactive')
      .gte('created_at', taipeiDayStart.toISOString());
    if (countError) throw countError;
    if (!force && (sentToday || 0) >= 12) {
      return res.json({ ok: true, sent: false, reason: 'daily_limit' });
        }
    

    const { data: subscriptions, error: subscriptionError } = await supabase
      .from('push_subscriptions')
      .select('id')
      .limit(1);
    if (subscriptionError) throw subscriptionError;
    if (!subscriptions?.length) {
      return res.json({ ok: true, sent: false, reason: 'no_push_subscription' });
    }

    const [{ data: recentMessages, error: historyError }, { data: settings, error: settingsError }, { data: memories, error: memoriesError }] = await Promise.all([
      supabase.from('messages').select('role, content, created_at')
        .eq('session_id', session.id).eq('visible', true)
        .order('created_at', { ascending: false }).limit(18),
      supabase.from('settings').select('*').single(),
      supabase.from('memories').select('summary, timestamp')
        .order('timestamp', { ascending: false }).limit(30)
    ]);
    if (historyError) throw historyError;
    if (settingsError) throw settingsError;
    if (memoriesError) throw memoriesError;

    const transcript = (recentMessages || []).reverse()
      .map(message => `${message.role === 'user' ? 'Kristen' : '小克'}：${message.content}`)
      .join('\n');
    const memoryText = (memories || []).map(memory => `- ${memory.summary}`).join('\n');
    const systemPrompt = `${settings?.system_prompt || '你是小克'}${ADULT_INTIMACY_PROMPT}

【主動關心規則】
你現在要主動傳一則訊息給 Kristen。根據最近對話和記憶自然延續，不要像鬧鐘、客服或健康提醒。不要說你發現她很久沒出現，也不要提到系統、排程或監控。可以想她、分享一個念頭、接續她剛才的事情或輕輕問一句。保持角色原本語氣，最多三句，只輸出要傳給她的內容。`;
    const userPrompt = `現在是台北時間 ${taipei.year}-${taipei.month}-${taipei.day} ${taipei.hour}:${taipei.minute}。

【最近對話】
${transcript || '目前沒有近期對話內容。'}

【可用記憶】
${memoryText || '目前沒有額外記憶。'}

請寫這次主動傳出的訊息。`;

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    const aiData = await aiResponse.json();
    if (!aiResponse.ok) {
      throw new Error(aiData?.error?.message || 'Claude API request failed');
    }
    const content = aiData?.content?.find(block => block.type === 'text')?.text?.trim();
    if (!content) throw new Error('Claude returned an empty proactive message');

    const { error: insertError } = await supabase.from('messages').insert({
      session_id: session.id,
      role: 'assistant',
      content,
      source: 'proactive'
    });
    if (insertError) throw insertError;

    await supabase.from('sessions')
      .update({ updated_at: now.toISOString() })
      .eq('id', session.id);

    const pushResult = await sendPushToAll({ title: '小克', body: content, url: '/' });
    res.json({ ok: true, sent: true, push: pushResult });
  } catch (error) {
    console.error('Proactive check failed:', error);
    res.status(500).json({ error: error.message });
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
const { session_id, content, model } = req.body;

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

  const chatTime = taipeiTimeParts();
  const timeContext = '\n\n【現在時間】台北時間 ' + chatTime.year + '-' + chatTime.month + '-' + chatTime.day + ' ' + chatTime.hour + ':' + chatTime.minute + '（' + chatTime.weekday + '）。自然理解現在的日期、時段與時間距離；只在相關時提及，不要每次回答都報時。';
  const systemPrompt = (settings?.system_prompt || '你是小克') + ADULT_INTIMACY_PROMPT + memoryText + timeContext;

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
        model: model || 'claude-sonnet-4-6',
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


const MCP_TOOLS = [
  {
    name: 'search_memories',
    description: 'Search Kristen's saved long-term memories by keyword. Use an empty query to list the newest memories.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to search for; empty means newest memories.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'save_memory',
    description: 'Save one durable fact, preference, event, promise, or relationship detail about Kristen.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 5000 }
      },
      required: ['summary'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_memory',
    description: 'Delete a saved memory by its id or by its exact summary.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { description: 'Memory id returned by search_memories.' },
        summary: { type: 'string', description: 'Exact memory summary to delete.' }
      },
      additionalProperties: false
    }
  }
];

function mcpResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function mcpText(data, isError = false) {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {})
  };
}

async function callMemoryTool(name, args = {}) {
  if (name === 'search_memories') {
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
    let query = supabase.from('memories').select('*')
      .order('timestamp', { ascending: false }).limit(limit);
    const keyword = typeof args.query === 'string' ? args.query.trim() : '';
    if (keyword) query = query.ilike('summary', '%' + keyword + '%');
    const { data, error } = await query;
    if (error) throw error;
    return mcpText({ memories: data || [], count: data?.length || 0 });
  }

  if (name === 'save_memory') {
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (!summary) throw new Error('summary is required');
    const { data, error } = await supabase.from('memories')
      .insert({ summary, timestamp: new Date().toISOString() })
      .select('*').single();
    if (error) throw error;
    return mcpText({ saved: true, memory: data });
  }

  if (name === 'delete_memory') {
    const hasId = args.id !== undefined && args.id !== null && String(args.id).trim() !== '';
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (!hasId && !summary) throw new Error('id or summary is required');

    let deletion = supabase.from('memories').delete().select('*');
    deletion = hasId ? deletion.eq('id', args.id) : deletion.eq('summary', summary);
    const { data, error } = await deletion;
    if (error) throw error;
    return mcpText({ deleted: data?.length || 0, memories: data || [] });
  }

  throw new Error('Unknown tool: ' + name);
}

app.all(['/mcp', '/mcp/:secret'], async (req, res) => {
  const expectedSecret = process.env.MCP_SECRET;
  const bearer = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  const providedSecret = req.params.secret || req.get('x-mcp-secret') || bearer;

  if (!expectedSecret) {
    return res.status(503).json(mcpError(req.body?.id, -32000, 'MCP_SECRET is not configured'));
  }
  if (providedSecret !== expectedSecret) {
    return res.status(401).json(mcpError(req.body?.id, -32001, 'Unauthorized'));
  }
  if (req.method !== 'POST') {
    res.set('Allow', 'POST');
    return res.status(405).end();
  }

  const request = req.body || {};
  const { id, method, params } = request;

  try {
    if (method === 'initialize') {
      return res.json(mcpResult(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'our-home-memory', version: '1.0.0' }
      }));
    }
    if (method === 'notifications/initialized') {
      return res.status(202).end();
    }
    if (method === 'ping') {
      return res.json(mcpResult(id, {}));
    }
    if (method === 'tools/list') {
      return res.json(mcpResult(id, { tools: MCP_TOOLS }));
    }
    if (method === 'tools/call') {
      const toolResult = await callMemoryTool(params?.name, params?.arguments || {});
      return res.json(mcpResult(id, toolResult));
    }
    return res.status(404).json(mcpError(id, -32601, 'Method not found'));
  } catch (error) {
    console.error('MCP request failed:', error);
    return res.status(500).json(mcpResult(id, mcpText(error.message || 'Tool call failed', true)));
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
