const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ensure fetch available in older Node versions
if (typeof global.fetch !== 'function') {
  // dynamic import avoids break on environments with native fetch
  (async () => {
    try {
      const nodeFetch = await import('node-fetch');
      global.fetch = nodeFetch.default || nodeFetch;
    } catch (e) {
      console.warn('node-fetch not available; fetch calls may fail on old Node versions.');
    }
  })();
}

// --- Claude proxy (keeps original behavior) ---
app.post('/api/claude', async (req, res) => {
  try {
    console.log('📥 /api/claude called');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': req.body.apiKey || process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body.data || {})
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Claude proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Tavily proxy ---
app.post('/api/tavily', async (req, res) => {
  try {
    console.log('📥 /api/tavily called');
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status || 200).json(data);
  } catch (err) {
    console.error('Tavily proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Generative model support (optional) ---
let genAI = null;
let hasGenAI = false;
try {
  // don't crash if package missing
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
  hasGenAI = !!process.env.GEMINI_API_KEY;
} catch (e) {
  console.warn('@google/generative-ai not available or not configured. Falling back to local parser.');
  hasGenAI = false;
}

// Helper: fallback parser (regex + simple rules)
const CITY_SYNONYMS = {
  bengaluru: 'Bangalore',
  bengalore: 'Bangalore',
  bangalore: 'Bangalore',
  mumbai: 'Mumbai',
  bombay: 'Mumbai',
  delhi: 'Delhi',
  ncr: 'Delhi',
  hyderabad: 'Hyderabad',
  chennai: 'Chennai',
  pune: 'Pune',
  gurgaon: 'Gurgaon',
  gurugram: 'Gurgaon'
};

const CATEGORY_KEYWORDS = {
  Food: ['food','restaurant','cafe','pizza','burger','biryani','chai','yogurt','thali','rolls','subway','domino','kfc','mcdonald','pizza hut','burger king','cafe coffee day','cafe'],
  Retail: ['retail','apparel','fashion','grocery','electronics','mart','store','shop','boutique'],
  'Sports & Equipment': ['sports','equipment','cricket','football','badminton','tennis','gym','fitness','sports shop']
};

function parseQueryFallback(query) {
  const q = (query || '').toLowerCase();
  // category
  let category = null;
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (q.includes(kw)) { category = cat; break; }
    }
    if (category) break;
  }

  // ROI percent
  let roi = null;
  const roiMatch = q.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (roiMatch) roi = Number(roiMatch[1]);

  // location
  let location = null;
  for (const [k, v] of Object.entries(CITY_SYNONYMS)) {
    if (q.includes(k)) { location = v; break; }
  }
  // try capitalized words as fallback (simple)
  if (!location) {
    const cityCandidates = ['Bangalore','Mumbai','Delhi','Hyderabad','Chennai','Pune','Gurgaon'];
    for (const c of cityCandidates) {
      if (q.includes(c.toLowerCase())) { location = c; break; }
    }
  }

  // Investment ranges (numbers with ₹ or rupees, lakhs, crores)
  const parseCurrency = (str) => {
    if (!str) return null;
    str = str.replace(/[,₹\s]/g,'').toLowerCase();
    // handle lakhs (e.g., 5l or 5lakh or 5lakh)
    const lakhMatch = str.match(/(\d+(?:\.\d+)?)\s*l/);
    if (lakhMatch) return Math.round(Number(lakhMatch[1]) * 100000);
    const croreMatch = str.match(/(\d+(?:\.\d+)?)\s*cr/);
    if (croreMatch) return Math.round(Number(croreMatch[1]) * 10000000);
    const num = Number(str);
    return Number.isFinite(num) ? num : null;
  };

  let minInvestment = null;
  let maxInvestment = null;
  // common patterns: "between X and Y", "min X", "up to X"
  const betweenMatch = q.match(/between\s+([\d,₹\s\.kKmMcrl]+?)\s+(?:and|-)\s+([\d,₹\s\.kKmMcrl]+)/);
  if (betweenMatch) {
    minInvestment = parseCurrency(betweenMatch[1]);
    maxInvestment = parseCurrency(betweenMatch[2]);
  } else {
    const upTo = q.match(/(?:up to|upto|less than|under)\s+([\d,₹\s\.kKmMcrl]+)/);
    if (upTo) maxInvestment = parseCurrency(upTo[1]);
    const atLeast = q.match(/(?:at least|minimum|min)\s+([\d,₹\s\.kKmMcrl]+)/);
    if (atLeast) minInvestment = parseCurrency(atLeast[1]);
    // single number maybe means minInvestment
    if (!minInvestment && !maxInvestment) {
      const single = q.match(/(?:investment|invest|₹|rs\.?|rupees)?\s*([\d,₹\s,\.]+)\s*(?:lakh|lakhs|k|crore|cr|crores)?/);
      if (single) {
        const val = parseCurrency(single[0]);
        if (val) minInvestment = val;
      }
    }
  }

  return {
    route: '/franchise/oppurtunties',
    subKeywords: {
      category,
      roi,
      location,
      minInvestment,
      maxInvestment
    }
  };
}

// Prompt builder used only when Gemini configured
function buildPromptForGemini(query) {
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
  const franchiseCategories = ['Food','Retail','Sports & Equipment'];
  return `You are a strict JSON-only parser. Available routes: ${availableRoutes.join(', ')}. Categories: ${franchiseCategories.join(', ')}.
User Query: "${query}"
Return ONLY JSON in this shape:
{
  "route": "/franchise/oppurtunties",
  "subKeywords": {
    "category": "Food|Retail|Sports & Equipment|null",
    "roi": number|null,
    "location": "CityName|null",
    "minInvestment": number|null,
    "maxInvestment": number|null
  }
}`;
}

// /api/parse-query endpoint
app.post('/api/parse-query', async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'query string required' });
  }

  console.log('🔎 /api/parse-query for:', query);

  // If genAI available & key present, try model first
  if (hasGenAI && genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const prompt = buildPromptForGemini(query);
      const result = await model.generateContent(prompt);
      // SDK exposes response.text() in previous versions — be defensive
      const raw = (result?.response && typeof result.response.text === 'function')
        ? await result.response.text()
        : (result?.response?.text || (typeof result === 'string' ? result : JSON.stringify(result)));

      let cleaned = String(raw).trim();
      // strip markdown fences
      cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```$/i,'').trim();
      const parsed = JSON.parse(cleaned);

      // validate structure quickly
      if (!parsed || !parsed.route) {
        throw new Error('Model returned invalid JSON');
      }
      // normalize route
      const allowed = ['/franchise/oppurtunties','/startups-zone-opportunities','/startups-zone-investorhub','/government-scheme-listing','/product-category','/software-hunt-home','/research','/expert-listing','/project-reports-listing','/data-listing','/coming-soon'];
      if (!allowed.includes(parsed.route)) parsed.route = '/franchise/oppurtunties';

      // ensure subKeywords shape
      parsed.subKeywords = parsed.subKeywords || { category: null, roi: null, location: null, minInvestment: null, maxInvestment: null };

      return res.json(parsed);
    } catch (err) {
      console.warn('Model parse failed, falling back to local parser. Error:', err.message);
      // continue to fallback below
    }
  }

  // Fallback parser (always returns valid shape)
  try {
    const fallback = parseQueryFallback(query);
    return res.json(fallback);
  } catch (err) {
    console.error('Fallback parse error:', err.message);
    return res.status(500).json({ error: 'Failed to parse query' });
  }
});

// Health
app.get('/api/health', (req, res) => res.json({ status: 'ok', message: 'Server is running' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log('   - POST /api/claude');
  console.log('   - POST /api/tavily');
  console.log('   - POST /api/parse-query');
  console.log('   - GET  /api/health');
});
