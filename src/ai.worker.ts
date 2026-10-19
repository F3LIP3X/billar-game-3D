// La máquina piensa en un hilo aparte: sus simulaciones no le quitan tiempo al render.
import { planShot, type AiInput } from './ai';

self.onmessage = async (e: MessageEvent<AiInput>) => self.postMessage(await planShot(e.data));
