// Load environment variables from .env file (if dotenv is installed)
try {
    require('dotenv').config();
} catch (e) {
    // dotenv not installed, use system environment variables
}

const USE_MOCK_AI = true; // ← set to false later
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const MOCK_RESPONSE = {
    Marketing: [
      "Use primary brand blue (avoid dark navy from Q1 assets)",
      "Set primary CTA to \"Request a Demo\"",
      "Keep slides 1–3 visually uncluttered with clear value proposition on slide 2",
      "Ensure text is legible for webinar use and exports cleanly in 16:9 and 1:1",
      "Use gradients only if subtle and brand-aligned"
    ],
    Legal: [
      "Add standard T&Cs footer on every slide, including title and closing",
      "Remove or replace prohibited terms (e.g. \"guaranteed\", \"risk-free\")",
      "Phrase performance claims as \"based on internal benchmarks\"",
    ],
    Product: [
      "Insert Feature X workflow screenshot on slide 3 (March 18 build only)",
      "Mention Tool Y integration as complementary, not a replacement",
      "Ensure all legal content is compliant with the latest regulations"
    ],
    Brand: [
      "Place logo in bottom-right with required clear space",
      "Do not stretch, recolor, or modify the logo",
      "Use approved heading type scale (no custom font weights)",
    ],
    Other: [
      "Avoid placing critical content too close to slide edges",
      "Ensure all content is compliant with the latest regulations",
      "Do not include any pricing information in the deck"
    ]
  };
  
// System prompt for parsing design instructions
const SYSTEM_PROMPT = `You are a design instruction parser. Your task is to extract actionable tasks from unstructured design instructions and organize them by department.

Departments:
- Marketing: Tasks related to marketing campaigns, social media, advertising, content creation, SEO, email marketing
- Product: Tasks related to product development, features, user experience, technical implementation
- Legal: Tasks related to compliance, terms of service, privacy policies, legal reviews, contracts
- Brand: Tasks related to brand identity, logo, visual guidelines, brand consistency, style guides
- Other: Any tasks that don't fit into the above categories

Instructions:
1. Read the user's design instructions carefully
2. Extract all actionable tasks
3. Group tasks by the appropriate department
4. Each task should be a clear, actionable item
5. Return ONLY valid JSON in the following format (no markdown, no explanations, no code blocks):
{
  "Marketing": [],
  "Product": [],
  "Legal": [],
  "Brand": [],
  "Other": []
}

Important:
- Return ONLY the JSON object, nothing else
- If a department has no tasks, use an empty array []
- Do not wrap the JSON in markdown code blocks
- Do not include any explanations or additional text
- Ensure all strings are properly escaped in JSON

Critical:
- Do NOT infer or invent tasks that are not explicitly stated.
- If something is vague, keep the task wording vague.
- Do NOT improve, optimize, or rephrase beyond clarity.`;

/**
 * Formats the prompt with user instructions
 * @param {string} userInstructions - The unstructured design instructions from the user
 * @returns {string} - Formatted prompt for OpenAI API
 */
function formatPrompt(userInstructions) {
    return `Parse the following design instructions and extract actionable tasks grouped by department:\n\n${userInstructions}`;
}

/**
 * Extracts JSON from API response, handling markdown code blocks if present
 * @param {string} responseText - The raw response text from OpenAI API
 * @returns {string} - Extracted JSON string
 */
function extractJsonFromResponse(responseText) {
    // Remove markdown code blocks if present
    let jsonString = responseText.trim();
    
    // Check for markdown code blocks (```json or ```)
    const jsonBlockMatch = jsonString.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
        jsonString = jsonBlockMatch[1].trim();
    }
    
    return jsonString;
}

/**
 * Validates the JSON structure matches expected format
 * @param {object} data - Parsed JSON object
 * @returns {boolean} - True if valid, false otherwise
 */
function validateJsonStructure(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    
    // Check that all values are arrays
    for (const key in data) {
        if (!Array.isArray(data[key])) {
            return false;
        }
        // Check that all array items are strings
        if (!data[key].every(task => typeof task === 'string')) {
            return false;
        }
    }
    
    return true;
}

// POST endpoint to parse instructions
app.post('/api/parse-instructions', async (req, res) => {
    try {
        const { instructions } = req.body;

        if (!instructions || typeof instructions !== 'string' || !instructions.trim()) {
            return res.status(400).json({ 
                error: 'Invalid request. Please provide instructions as a string.' 
            });
        }

        if (USE_MOCK_AI) {
            // Simulate realistic latency
            setTimeout(() => {
                res.json(MOCK_RESPONSE);
            }, 600);
            return;
        }

        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
        
        if (!GEMINI_API_KEY) {
            return res.status(500).json({ 
                error: 'Gemini API key is not configured. Please set GEMINI_API_KEY environment variable.' 
            });
        }

        // Combine system prompt and user instructions for Gemini
        const fullPrompt = `${SYSTEM_PROMPT}\n\n${formatPrompt(instructions)}`;

        // Call Google Gemini API
        // Using gemini-1.5-flash (stable version)
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`;


        
        const requestBody = {
            contents: [{
                parts: [{
                    text: fullPrompt
                }]
            }],
            generationConfig: {
                temperature: 0.1, // Keeps the extraction consistent
                responseMimeType: "application/json" // CRITICAL: Forces pure JSON output
            }
        };

        console.log('[Gemini API] Making request to:', apiUrl.replace(GEMINI_API_KEY, '***'));
        console.log('[Gemini API] Request body (truncated):', JSON.stringify(requestBody).substring(0, 200) + '...');

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorData;
            try {
                errorData = JSON.parse(errorText);
            } catch (e) {
                errorData = { error: { message: errorText } };
            }
            
            const errorMessage = errorData.error?.message || `API request failed with status ${response.status}`;
            
            console.error('[Gemini API] Error response:', errorMessage);
            console.error('[Gemini API] Full error:', errorText);
            
            if (response.status === 401 || response.status === 403) {
                return res.status(401).json({ 
                    error: 'Invalid API key. Please check your GEMINI_API_KEY environment variable.' 
                });
            } else if (response.status === 429) {
                return res.status(429).json({ 
                    error: 'Rate limit exceeded. Please try again later.' 
                });
            } else if (response.status >= 500) {
                return res.status(502).json({ 
                    error: 'Gemini API server error. Please try again later.' 
                });
            } else {
                return res.status(response.status).json({ 
                    error: `API Error: ${errorMessage}` 
                });
            }
        }

        const data = await response.json();
        
        console.log('[Gemini API] Response received, structure:', Object.keys(data));
        
        // Handle different response structures
        let content = null;
        
        // Check for candidates array (standard response structure)
        if (data.candidates && data.candidates.length > 0) {
            const candidate = data.candidates[0];
            
            // Check for content with parts
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                content = candidate.content.parts[0].text;
            }
            
            // Check for functionCall (if using function calling)
            if (!content && candidate.content && candidate.content.functionCalls) {
                // Handle function call response if needed
                const functionCall = candidate.content.functionCalls[0];
                if (functionCall && functionCall.args) {
                    // If function call returns JSON directly, use it
                    content = JSON.stringify(functionCall.args);
                }
            }
        }
        
        // Fallback: check if response is already JSON (some API versions)
        if (!content && typeof data === 'object' && !data.candidates) {
            // Response might be direct JSON
            if (validateJsonStructure(data)) {
                return res.json(data);
            }
        }
        
        if (!content) {
            console.error('[Gemini API] Unexpected response structure:', JSON.stringify(data, null, 2));
            return res.status(500).json({ 
                error: 'No content received from Gemini API. The response structure was unexpected. Check server logs for details.' 
            });
        }
        
        console.log('[Gemini API] Content extracted, length:', content.length);

        // Extract JSON from response (handles cases where Gemini might wrap JSON)
        const jsonString = extractJsonFromResponse(content);
        
        // Parse JSON
        let parsedData;
        try {
            parsedData = JSON.parse(jsonString);
        } catch (parseError) {
            console.error('JSON parse error:', parseError.message);
            console.error('Response content:', content);
            return res.status(500).json({ 
                error: `Failed to parse JSON response: ${parseError.message}. The API may have returned invalid JSON.` 
            });
        }

        // Validate structure
        if (!validateJsonStructure(parsedData)) {
            return res.status(500).json({ 
                error: 'Invalid JSON structure received from API. Expected object with array values.' 
            });
        }

        // Return the parsed data
        res.json(parsedData);

    } catch (error) {
        console.error('Error parsing instructions:', error);
        res.status(500).json({ 
            error: error.message || 'An unexpected error occurred while parsing instructions.' 
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Serve static files from dist directory (built add-on files)
// Placed after API routes to ensure /api/* takes precedence over static file serving
// This allows the Express server to serve both the UI and API in MCP deployment

// For MCP deployment: Inject API_BASE_URL into index.html
// Get the base URL from environment or use current request origin
app.get('*.html', (req, res, next) => {
    const filePath = path.join(__dirname, 'dist', req.path);
    
    if (fs.existsSync(filePath) && req.path.endsWith('index.html')) {
        let html = fs.readFileSync(filePath, 'utf8');
        
        // Inject API_BASE_URL - use environment variable or derive from request
        const apiBaseUrl = process.env.API_BASE_URL || 
                          process.env.MCP_SERVER_URL || 
                          `${req.protocol}://${req.get('host')}`;
        
        // Inject script before closing </head> or before first script tag
        const injectionScript = `<script>window.API_BASE_URL = '${apiBaseUrl}';</script>`;
        
        // Insert before the first script tag or before </head>
        if (html.includes('</head>')) {
            html = html.replace('</head>', `  ${injectionScript}\n</head>`);
        } else if (html.includes('<script')) {
            html = html.replace('<script', `${injectionScript}\n<script`);
        }
        
        res.send(html);
    } else {
        next();
    }
});

// Serve other static files normally
app.use(express.static(path.join(__dirname, 'dist')));

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
