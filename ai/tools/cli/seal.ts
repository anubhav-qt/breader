import { writeFileSync } from 'node:fs';
import { prodEnv } from '../env.ts';
import { main } from '../lib.ts';
import { nvidiaKey, SEALED } from '../nim.ts';
import { seal, unseal } from '../seal.ts';

/*
 * npm --prefix ai run seal   Seals the NVIDIA key from ai/.env into ai/nvidia-key.enc with the
 *                            ADMIN_TOKEN in infra/.env (seal.ts), for the marker on the server.
 *                            Run it again after either one changes, then commit the file. Neither
 *                            value is printed.
 */

main(() => {
  const nvidia = nvidiaKey();
  if (nvidia.from === 'ai/nvidia-key.enc') throw new Error('No NVIDIA_NIM_API_KEY in ai/.env to seal.');
  const token = prodEnv().ADMIN_TOKEN;
  if (!token) throw new Error('No ADMIN_TOKEN in infra/.env.');
  // The sealed file is public, so the token is all that keeps the key: it has to be a long one.
  if (token.length < 32) throw new Error('ADMIN_TOKEN is too short to seal with (fewer than 32 characters).');

  const sealed = seal(nvidia.key, token);
  if (unseal(sealed, token) !== nvidia.key) throw new Error('The sealed key didn’t open again. Nothing was written.');
  writeFileSync(SEALED, `${sealed}\n`);
  console.log(`Sealed the NVIDIA key from ${nvidia.from} into ai/nvidia-key.enc. Commit it, and the server's marker picks it up with its next image.`);
});
