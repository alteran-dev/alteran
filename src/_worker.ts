import { createPdsFetchHandler } from './worker/runtime';

const fetch = createPdsFetchHandler();

export default { fetch };

export { Sequencer } from './worker/sequencer';
