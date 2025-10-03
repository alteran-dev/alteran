import { createPdsFetchHandler } from './worker/runtime';
import { Sequencer } from './worker/sequencer';

const fetch = createPdsFetchHandler();

export default { fetch };

export { Sequencer };
