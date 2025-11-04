const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for large payloads

// Proxy endpoint for Claude API
app.get("/", (req, res) => {
  res.send("Hello, World!");
  console.log("Hello, World");
});
  
app.post('/api/claude', async (req, res) => {
  console.log('\n========================================');
  console.log('📥 Received Claude API request');
  console.log('Messages count:', req.body.data.messages?.length);
  
  // Log each message in the conversation
  if (req.body.data.messages) {
    req.body.data.messages.forEach((msg, idx) => {
      console.log(`\nMessage ${idx}:`);
      console.log('  Role:', msg.role);
      console.log('  Content type:', typeof msg.content);
      if (typeof msg.content === 'string') {
        console.log('  Content preview:', msg.content.substring(0, 100) + '...');
      } else if (Array.isArray(msg.content)) {
        console.log('  Content array length:', msg.content.length);
        msg.content.forEach((item, i) => {
          console.log(`    Item ${i} type:`, item.type);
        });
      }
    });
  }
  
  try {
    console.log('\n📤 Sending to Claude API...');
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': req.body.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body.data)
    });

    const data = await response.json();
    
    console.log('✅ Response from Claude:');
    console.log('  Status:', response.status);
    console.log('  Content blocks:', data.content?.length || 0);
    console.log('  Stop reason:', data.stop_reason);
    console.log('  Output tokens:', data.usage?.output_tokens);
    
    if (data.content && data.content.length > 0) {
      data.content.forEach((block, idx) => {
        console.log(`  Block ${idx} type:`, block.type);
        if (block.type === 'text' && block.text) {
          console.log(`  Text length:`, block.text.length);
          console.log(`  Text preview:`, block.text.substring(0, 200));
        }
      });
    }
    
    console.log('========================================\n');
    
    res.json(data);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('========================================\n');
    res.status(500).json({ error: error.message });
  }
});

// Proxy endpoint for Tavily API
app.post('/api/tavily', async (req, res) => {
  console.log('📥 Tavily search request for:', req.body.query);
  
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    console.log('✅ Tavily returned', data.results?.length || 0, 'results');
    res.json(data);
  } catch (error) {
    console.error('❌ Tavily error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`✅ Proxy server running on http://localhost:${PORT}`);

});

