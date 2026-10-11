// Explicit synthetic provider for isolated integration tests. No credentials or network.
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
export default function (pi) {
  globalThis.fetch = async () => { throw new Error('Synthetic fixture blocks network'); };
  const faux = fauxProvider({provider:'bridge-fixture',models:[{id:'deterministic',name:'Deterministic test only'}],tokensPerSecond:30,tokenSize:{min:1,max:1}});
  faux.setResponses(Array.from({length:12},(_,i)=>fauxAssistantMessage(`Synthetic response ${i+1}.`)));
  pi.registerProvider(faux.provider);
}
