import { hasBwrap } from "../src/runtime/sandbox/bwrap.js";
import { describeBashIntegration } from "./helpers/bash-integration.js";

describeBashIntegration({
  name: "bwrap",
  isSupported: async () => process.platform === "linux" && (await hasBwrap()),
  unameMatches: /^Linux$/,
  // bwrap doesn't bind-mount $HOME, so reads fail with ENOENT rather than EPERM.
  deniedReadPattern: /No such file|Operation not permitted/,
});
