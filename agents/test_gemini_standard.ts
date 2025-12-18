import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function testStandardGemini() {
  const apiKey = process.env.GOOGLE_API_KEY;
  
  if (!apiKey) {
    console.error("❌ Error: GOOGLE_API_KEY is not set in .env.local");
    process.exit(1);
  }

  console.log(`ℹ️  Found API Key: ${apiKey.substring(0, 8)}...`);

  const client = new GoogleGenAI({ apiKey });

  try {
    const modelName = 'gemini-2.5-flash-native-audio-preview-12-2025';
    console.log(`🔄 Testing connection to model: ${modelName}...`);
    
    // Use the updated SDK method structure
    const result = await client.models.generateContent({
        model: modelName,
        contents: [{
            role: 'user',
            parts: [{ text: "Hello! If you can read this, please reply with 'System Online'." }]
        }]
    });

    if (result.text) {
        console.log("✅ Success! Response received:");
        console.log("---------------------------------------------------");
        console.log(result.text);
        console.log("---------------------------------------------------");
    } else {
        console.warn("⚠️  Request succeeded but returned no text.");
        console.log(JSON.stringify(result, null, 2));
    }

  } catch (error: any) {
    console.error("❌ API Request Failed!");
    if (error.message) console.error("Error Message:", error.message);
    if (error.status) console.error("Status Code:", error.status);
    // Print full error object for deep debugging
    console.error("Full Error:", JSON.stringify(error, null, 2));
  }
}

testStandardGemini();
