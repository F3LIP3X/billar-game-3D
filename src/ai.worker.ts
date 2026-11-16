// La máquina piensa en un hilo aparte: sus simulaciones no le quitan tiempo al render.
import { planShot, type AiInput } from './ai';

self.onmessage = async (e: MessageEvent<{ id: number; input: AiInput }>) =>
  self.postMessage({ id: e.data.id, shot: await planShot(e.data.input) });
