/**
 * Bash bwrap integration tests (Linux backend).
 *
 * Skipped silently on non-Linux or when /usr/bin/bwrap is missing.
 * The shared shape lives in `helpers/bash-integration.ts`; this file
 * is the Linux shim.
 */

import { hasBwrap } from "../src/runtime/sandbox/bwrap.js";
import { describeBashIntegration } from "./helpers/bash-integration.js";

describeBashIntegration({
  name: "bwrap",
  isSupported: async () => process.platform === "linux" && (await hasBwrap()),
  unameMatches: /^Linux$/,
  // Inside the bwrap namespace, $HOME paths aren't bind-mounted at
  // all, so `cat` sees "No such file or directory". "Operation not
  // permitted" can also appear for read-only bound paths.
  deniedReadPattern: /No such file|Operation not permitted/,
});
