const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for large payloads

// Proxy endpoint for Claude API
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



// ============ NEW: Gemini smart Filtering ============
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const availableRoutes = [
  '/franchise/oppurtunties',
  '/startups-zone-opportunities',
  '/startups-zone-investorhub',
  '/government-scheme-listing',
  '/product-category',
  '/software-hunt-home',
  '/research',
  '/expert-listing',
  '/project-reports-listing',
  '/data-listing',
  '/coming-soon'
];

const franchiseCategories = ['Food', 'Retail', 'Sports & Equipment'];

app.post('/api/parse-query', async (req, res) => {
  try {
    const { query } = req.body;
    console.log(`✅ Called with query: ${query}`);


    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query is required and must be a string' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `You are a query parser for a franchise discovery platform. Analyze the user query and extract relevant information.

Available routes: ${availableRoutes.join(', ')}

Available franchise categories: ${franchiseCategories.join(', ')}

User Query: "${query}"

Extract the following information:
1. Route: Determine which route/page the user wants to navigate to based on the query intent. Must be one of the available routes.
2. Category: If the query mentions a franchise category, extract it. 
   - If query contains "food", "restaurant", "cafe", "pizza", "burger", "biryani", "chai", "yogurt", "thali", "rolls", "subway", "domino", "kfc", "mcdonald", "pizza hut", "burger king", "cafe coffee day" → return "Food"
   - If query contains "retail", "apparel", "fashion", "grocery", "electronics", "mart", "store", "shop" (but not sports shop) → return "Retail"
   - If query contains "sports", "equipment", "cricket", "football", "badminton", "tennis", "gym", "fitness" → return "Sports & Equipment"
   - Return null if category is not clearly mentioned
3. ROI: Extract ROI percentage if mentioned (e.g., "8%", "10%", "12%"). Return null if not mentioned.
4. Location: Extract location/city if mentioned (e.g., "Bangalore", "Mumbai", "Delhi", "Pune", "Hyderabad", "Chennai", "Gurgaon"). Return null if not mentioned.
5. MinInvestment: Extract minimum investment amount if mentioned. Return null if not mentioned.
6. MaxInvestment: Extract maximum investment amount if mentioned. Return null if not mentioned.

Return ONLY a valid JSON object in this exact format (no markdown, no extra text):
{
  "route": "/franchise/oppurtunties",
  "subKeywords": {
    "category": "Food",
    "roi": 8,
    "location": "Bangalore",
    "minInvestment": null,
    "maxInvestment": null
  }
}

Important rules:
- Route must be one of the available routes listed above
- Category must be EXACTLY one of: "Food", "Retail", "Sports & Equipment", or null (case-sensitive)
- Only parse subKeywords if the route is "/franchise/oppurtunties"
- ROI should be a number (percentage) or null
- Location should be a string (city name) or null
- MinInvestment and MaxInvestment should be numbers (in rupees) or null
- If a value is not mentioned in the query, use null
- Be intelligent about synonyms (e.g., "food franchise" = category "Food", "Bengaluru" = "Bangalore")
- For "Food Franchise" query, category MUST be "Food"`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    // Clean the response text (remove markdown code blocks if present)
    let cleanedText = text.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/```\n?/g, '').trim();
    }

    const parsedResponse = JSON.parse(cleanedText);

    // Validate route
    if (!availableRoutes.includes(parsedResponse.route)) {
      parsedResponse.route = '/franchise/oppurtunties';
    }

    // Validate category - only if route is franchise
    if (parsedResponse.route === '/franchise/oppurtunties') {
      if (parsedResponse.subKeywords.category && !franchiseCategories.includes(parsedResponse.subKeywords.category)) {
        const categoryMap = {
          'Sports': 'Sports & Equipment',
          'Sports/Equipment': 'Sports & Equipment',
          'Equipment': 'Sports & Equipment',
          'Sports Equipment': 'Sports & Equipment'
        };
        parsedResponse.subKeywords.category = categoryMap[parsedResponse.subKeywords.category] || null;
      }
    } else {
      parsedResponse.subKeywords = {
        category: null,
        roi: null,
        location: null,
        minInvestment: null,
        maxInvestment: null
      };
    }

    res.json(parsedResponse);
  } catch (error) {
    console.error('Error parsing query:', error);
    res.status(500).json({ 
      error: 'Failed to parse query',
      message: error.message 
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`   - POST /api/claude (Claude proxy)`);
  console.log(`   - POST /api/tavily (Tavily proxy)`);
  console.log(`   - POST /api/parse-query (Franchise query parser)`);
  console.log(`   - GET /api/health (Health check)`);
});
