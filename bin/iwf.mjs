#!/usr/bin/env node

import { executeIwf } from "../scripts/v2-cli.mjs";

executeIwf(process.argv.slice(2))
  .then((result) => {
    if (result?.healthy === false || result?.stopped === true) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(`iwf failed: ${error.message}`);
    process.exitCode = 1;
  });
