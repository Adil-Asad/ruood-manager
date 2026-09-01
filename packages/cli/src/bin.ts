#!/usr/bin/env node
import { main } from './main';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Nothing should reach here — main catches. If it does, say so plainly
    // rather than printing a stack at someone trying to publish.
    console.error(`Unexpected failure: ${(error as Error).message}`);
    process.exitCode = 1;
  });
