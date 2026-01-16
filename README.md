## About

This project has been created with _@adobe/create-ccweb-add-on_. Brief2Check is an Adobe Express Add-on that parses unstructured design instructions and organizes them into actionable tasks by department (Marketing, Product, Legal, Brand, Other).

## Tools

-   HTML
-   CSS
-   JavaScript
-   Node.js/Express (backend server)
-   Google Gemini AI API

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up Gemini API Key:**
   - Get your API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
   - Create a `.env` file in the root directory:
     ```
     GEMINI_API_KEY=your_api_key_here
     PORT=3000
     ```
   - Replace `your_api_key_here` with your actual Gemini API key

3. **Build the application:**
   ```bash
   npm run build
   ```

4. **Start the server:**
   ```bash
   npm run server
   ```
   The server will run on `http://localhost:3000` by default.

5. **Start the add-on (in a separate terminal):**
   ```bash
   npm run start
   ```

## Usage

1. Open the Brief2Check add-on in Adobe Express
2. Paste your unstructured design instructions into the text area
3. Click "Parse Instructions" to process them with Gemini AI
4. Review and edit the parsed tasks organized by department
5. Export department-specific checklists as PDF or copy to clipboard

## API Endpoints

- `POST /api/parse-instructions` - Parses design instructions using Gemini AI
  - Body: `{ "instructions": "your instructions here" }`
  - Returns: JSON object with tasks grouped by department
