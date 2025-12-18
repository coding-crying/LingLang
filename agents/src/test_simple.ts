import { cli, defineAgent, WorkerOptions } from '@livekit/agents';
import { fileURLToPath } from 'node:url';

export default defineAgent({
  entry: async (ctx) => {
    console.log('Agent started!');
    await ctx.connect();
    console.log('Connected to room', ctx.room.name);
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
}
