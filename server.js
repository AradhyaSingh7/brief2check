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
      "Apply Q1 blue theme",
      "Strengthen primary CTA for growth focus"
    ],
    Product: [
      "Add Feature X screenshot on slide 3"
    ],
    Legal: [
      "Insert T&C disclaimer on all slides",
      "Replace 'guaranteed' with compliant wording"
    ],
    Brand: [
      "Ensure logo lockup is bottom-right"
    ],
    Other: []
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
  "Marketing": ["task 1", "task 2"],
  "Product": ["task 1"],
  "Legal": [],
  "Brand": ["task 1", "task 2"],
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

        const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
        
        if (!OPENAI_API_KEY) {
            return res.status(500).json({ 
                error: 'OpenAI API key is not configured. Please set OPENAI_API_KEY environment variable.' 
            });
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: SYSTEM_PROMPT
                    },
                    {
                        role: 'user',
                        content: formatPrompt(instructions)
                    }
                ],
                temperature: 0.3,
                response_format: { type: 'json_object' }
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.error?.message || `API request failed with status ${response.status}`;
            
            if (response.status === 401) {
                return res.status(401).json({ 
                    error: 'Invalid API key. Please check your OPENAI_API_KEY.' 
                });
            } else if (response.status === 429) {
                return res.status(429).json({ 
                    error: 'Rate limit exceeded. Please try again later.' 
                });
            } else if (response.status >= 500) {
                return res.status(502).json({ 
                    error: 'OpenAI API server error. Please try again later.' 
                });
            } else {
                return res.status(response.status).json({ 
                    error: `API Error: ${errorMessage}` 
                });
            }
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        
        if (!content) {
            return res.status(500).json({ 
                error: 'No content received from OpenAI API.' 
            });
        }

        // Extract JSON from response
        const jsonString = extractJsonFromResponse(content);
        
        // Parse JSON
        let parsedData;
        try {
            parsedData = JSON.parse(jsonString);
        } catch (parseError) {
            return res.status(500).json({ 
                error: `Failed to parse JSON response: ${parseError.message}` 
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
