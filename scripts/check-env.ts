import { makeEnv } from '../tests/helpers/env';

async function main() {
  try {
    const env = await makeEnv();
    console.log('Env created', Object.keys(env));
  } catch (err) {
    console.error('Failed to create env', err);
  }
}

main();
