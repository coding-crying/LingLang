import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function testGemini() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error("❌ GOOGLE_API_KEY is missing");
    return;
  }
  console.log("✅ API Key found:", apiKey.substring(0, 8) + "...");

  const client = new GoogleGenAI({ apiKey });
  
  try {
    console.log("Testing standard generation first (non-realtime)...");
    const result = await client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: "Hello, are you working?" }] }]
    });
    console.log("✅ Standard Response:", result.text);
  } catch (error) {
    console.error("❌ Standard Generation Failed:", error);
  }

  try {
    console.log("Listing available models...");
    const listResp = await client.models.list();
    console.log("Available Models:");
    // @ts-ignore
    for (const m of listResp.page) {
        console.log(`- ${m.name}`);
        if (m.name?.includes('flash') || m.name?.includes('realtime')) {
             console.log(`  (Potential candidate: ${m.name})`);
        }
    }
  } catch (error) {
    console.error("❌ List Models Failed:", error);
  }
}

testGemini();