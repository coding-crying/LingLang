import OpenAI from 'openai';

const CONFIG = {
  tts: {
    baseURL: process.env.LOCAL_TTS_URL || 'http://localhost:5000/v1',
    apiKey: 'dummy',
    model: 'tts-1',
  },
  fishSpeech: {
    baseURL: 'http://localhost:7860',
  }
};

async function measureTTSLatency() {
  console.log('\n--- Measuring TTS Latency ---');
  
  const testPhrases = [
    'Hello',
    'Hello, how are you?',
    'Hello, how are you doing today? I hope everything is going well.',
  ];

  for (const phrase of testPhrases) {
    console.log(`\nTesting: "${phrase}"`);
    
    // Test the proxy (Port 5000)
    const openai = new OpenAI({
      baseURL: CONFIG.tts.baseURL,
      apiKey: CONFIG.tts.apiKey,
    });

    try {
      const startProxy = Date.now();
      let firstChunkProxy = 0;
      let chunkCountProxy = 0;
      
      const responseProxy = await openai.audio.speech.create({
        model: CONFIG.tts.model,
        voice: 'alloy',
        input: phrase,
      });

      // Stream the response
      const reader = responseProxy.body?.getReader();
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          if (chunkCountProxy === 0) {
            firstChunkProxy = Date.now() - startProxy;
          }
          chunkCountProxy++;
        }
      }
      
      const totalProxy = Date.now() - startProxy;
      
      console.log(`  Proxy (Port 5000):`);
      console.log(`    Time to first chunk: ${firstChunkProxy}ms`);
      console.log(`    Total time: ${totalProxy}ms`);
      console.log(`    Chunks received: ${chunkCountProxy}`);
      
    } catch (error: any) {
      console.error(`  ❌ Proxy failed: ${error.message}`);
    }

    // Test native Fish Speech (Port 7860)
    try {
      const startNative = Date.now();
      let firstChunkNative = 0;
      let chunkCountNative = 0;
      
      const responseNative = await fetch(`${CONFIG.fishSpeech.baseURL}/v1/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: phrase,
          format: 'wav',
          streaming: true,
        })
      });

      if (responseNative.body) {
        const reader = responseNative.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          if (chunkCountNative === 0) {
            firstChunkNative = Date.now() - startNative;
          }
          chunkCountNative++;
        }
      }
      
      const totalNative = Date.now() - startNative;
      
      console.log(`  Native Fish Speech (Port 7860):`);
      console.log(`    Time to first chunk: ${firstChunkNative}ms`);
      console.log(`    Total time: ${totalNative}ms`);
      console.log(`    Chunks received: ${chunkCountNative}`);
      
    } catch (error: any) {
      console.error(`  ❌ Native failed: ${error.message}`);
    }
  }
}

measureTTSLatency().catch(console.error);
