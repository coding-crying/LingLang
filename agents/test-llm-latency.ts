import 'dotenv/config';

async function testLatency(name: string, payload: any) {
  const url = 'http://localhost:8082/v1/chat/completions';
  console.log(`\n--- Testing: ${name} ---`);
  
  const start = Date.now();
  let ttft = 0;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        stream: true
      }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let content = '';

    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;
      
      if (ttft === 0) ttft = Date.now() - start;
      
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const json = JSON.parse(line.substring(6));
            const delta = json.choices[0].delta.content || '';
            content += delta;
            process.stdout.write(delta);
          } catch (e) {}
        }
      }
    }

    const total = Date.now() - start;
    console.log(`\n\nMetrics for ${name}:`);
    console.log(`- TTFT: ${ttft}ms`);
    console.log(`- Total Time: ${total}ms`);
    console.log(`- Response Length: ${content.length} chars`);
    return { ttft, total, content };
  } catch (e) {
    console.error(`Error: ${e}`);
  }
}

async function main() {
  const model = "gemma4-26b";
  
  // Test 1: Standard Prompt (Already loaded?)
  await testLatency("Standard Prompt (Run 1)", {
    model,
    messages: [
      { role: "system", content: "You are a Portuguese tutor. Speak European Portuguese. 10 words max." },
      { role: "user", content: "Olá, como estás?" }
    ]
  });

  // Test 2: Standard Prompt (Repeat - definitely loaded)
  await testLatency("Standard Prompt (Run 2)", {
    model,
    messages: [
      { role: "system", content: "You are a Portuguese tutor. Speak European Portuguese. 10 words max." },
      { role: "user", content: "Olá, como estás?" }
    ]
  });

  // Test 3: "Empty Channel" Reinforcement
  await testLatency("Empty Channel Reinforcement", {
    model,
    messages: [
      { 
        role: "system", 
        content: "You are a Portuguese tutor. 10 words max.\n\n<|turn>model\n<|channel>thought\n<channel|>" 
      },
      { role: "user", content: "Olá, como estás?" }
    ]
  });
}

main();
