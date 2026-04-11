import { llm } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';

const googleRM = new google.beta.realtime.RealtimeModel({ apiKey: 'x' });
console.log('googleRM instanceof llm.RealtimeModel:', googleRM instanceof llm.RealtimeModel);
console.log('googleRM class name:', googleRM.constructor.name);
console.log('llm.RealtimeModel class name:', llm.RealtimeModel.name);
